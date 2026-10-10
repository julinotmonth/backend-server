// ── Pencapaian Minimum Stok (sheet "Progress_Minimum Stock All MS WS 2026") ──
// Satu sheet untuk seluruh perusahaan (bukan per site). Bentuknya matriks:
//
//   baris judul                 : "Minimum Stock RCE & RDA ALL MS 2026"
//   baris minggu                : ... | Week 01 |      |      |      | Week 02 | ...   (sel gabung, 4 kolom/minggu)
//   baris sub-judul             : ... | Jumlah Min Stock | Terealisasi | Belum Terealisasi | Pres Terealisasi | ...
//   baris data                  : Kategori | Lokasi | 143 Item | 124 Item | 19 Item | 87% | ...
//                                 (Kategori hanya terisi di baris pertama tiap grup — sel gabung)
//   baris total (label di kolom Kategori): Total Qty Min Stock ALL MS & WS, Total Min Stock Terealisasi ...,
//                                 Pres Total ..., Target Min Stock
//   baris bantu grafik di paling bawah (label di kolom Lokasi) → DIABAIKAN.
//
// Hasil parse disimpan sebagai SATU snapshot JSON (bukan per baris): datanya
// kecil (≈16 baris × 40 minggu) dan selalu diganti utuh tiap sinkron, jadi
// tidak perlu merge/diff seperti Work Target. Bila sinkron gagal, snapshot
// terakhir yang valid tetap dipakai.
//
// Parser sengaja dibuat toleran terhadap DUA bentuk CSV:
//  (a) mentah     : baris "Week NN" lalu baris sub-judul terpisah;
//  (b) gviz Google: kadang header bertingkat digabung jadi satu label per
//                   kolom ("Week 01 Jumlah Min Stock").
// Posisi kolom tidak di-hardcode — dicari lewat teks header.

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { parseCsv } from './weeklyReport.js';
import { extractSheetId, extractGid } from './workTarget.js';

export const MIN_STOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS min_stock_sources (
  id              TEXT PRIMARY KEY DEFAULT 'global',
  sheet_id        TEXT NOT NULL DEFAULT '',
  gid             TEXT NOT NULL DEFAULT '0',
  auto_sync       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at    TIMESTAMPTZ,
  last_status     TEXT NOT NULL DEFAULT '',
  data            JSONB,
  data_updated_at TIMESTAMPTZ
);
`;

// ── Parsing ───────────────────────────────────────────────────────────────
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const low = (s) => norm(s).toLowerCase();

/** "124 Item" → 124, "1.234 Item" → 1234, "" / "83,2%" → null. */
function parseCount(raw) {
  const s = norm(raw);
  if (!s || s.includes('%')) return null;
  if (!/\d/.test(s)) return null;
  const n = Number(s.replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "87%" → 87, "83,221%" → 83.221 (koma desimal ala id-ID). Kosong → null. */
function parsePct(raw) {
  const s = norm(raw);
  if (!s || !/\d/.test(s)) return null;
  const n = Number(s.replace('%', '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function metricOf(text) {
  const t = low(text);
  if (!t) return null;
  if (/belum/.test(t)) return 'belum';
  if (/pres|persen|%/.test(t)) return 'pct';
  if (/terealisasi|realisasi/.test(t)) return 'real';
  if (/jumlah|min\s*stock|min\s*stok|^min\b/.test(t)) return 'min';
  return null;
}

const WEEK_RE = /^week\s*0*(\d{1,2})\b/i;

/** "MS SETU" → "MS Setu" (token HURUF BESAR ≥4 huruf dijadikan Kapital). */
function rapikanLokasi(s) {
  return norm(s).split(' ').map((tok) => (/^[A-Z]{4,}$/.test(tok) ? tok[0] + tok.slice(1).toLowerCase() : tok)).join(' ');
}

export function parseMinStockCsv(csvText) {
  const rows = parseCsv(String(csvText || ''));
  if (!rows.length) throw Object.assign(new Error('CSV kosong.'), { status: 400 });

  // 1) Baris "Week NN"
  const headScan = Math.min(rows.length, 15);
  let weekRow = -1;
  for (let i = 0; i < headScan; i++) {
    const n = rows[i].filter((c) => WEEK_RE.test(norm(c))).length;
    if (n >= 3) { weekRow = i; break; }
  }
  if (weekRow < 0) {
    throw Object.assign(new Error('Format sheet tidak dikenali: baris header "Week 01, Week 02, …" tidak ditemukan. Pastikan link mengarah ke tab "Resume ALL Weekly".'), { status: 400 });
  }

  // 2) Baris sub-judul (Jumlah Min Stock / Terealisasi / …) — bisa sama dengan baris minggu (bentuk gviz)
  let metricRow = weekRow;
  const kolomMetrik = (r) => rows[r].filter((c) => metricOf(c)).length;
  if (kolomMetrik(weekRow) < 4) {
    for (let i = weekRow + 1; i <= Math.min(weekRow + 3, rows.length - 1); i++) {
      if (kolomMetrik(i) >= 4) { metricRow = i; break; }
    }
  }
  const headerEnd = Math.max(weekRow, metricRow);

  // 3) Peta kolom → (minggu, metrik)
  const lebar = Math.max(...rows.slice(0, headerEnd + 1).map((r) => r.length));
  const colWeek = new Array(lebar).fill(null);
  const colMetric = new Array(lebar).fill(null);
  let cur = null;
  for (let c = 0; c < lebar; c++) {
    const cell = norm(rows[weekRow][c]);
    const m = WEEK_RE.exec(cell);
    if (m) cur = Number(m[1]);
    else if (cell) cur = null; // label lain (mis. "Kategori") memutus carry-forward
    colWeek[c] = cur;
    let met = metricOf(rows[weekRow][c]);
    if (!met && metricRow !== weekRow) met = metricOf(rows[metricRow][c]);
    colMetric[c] = met;
  }
  // Cadangan: metrik tak terbaca → ikuti urutan posisi dalam grup 4 kolom
  const URUT = ['min', 'real', 'belum', 'pct'];
  const posisi = {};
  for (let c = 0; c < lebar; c++) {
    if (colWeek[c] === null) continue;
    const k = colWeek[c];
    posisi[k] = (posisi[k] ?? -1) + 1;
    if (!colMetric[c] && posisi[k] < 4) colMetric[c] = URUT[posisi[k]];
  }
  const firstWeekCol = colWeek.findIndex((w) => w !== null);

  // 4) Kolom Kategori & Lokasi (dicari lewat teks header; default B & C)
  let catCol = 1, locCol = 2;
  for (let i = 0; i <= headerEnd; i++) {
    rows[i].forEach((c, idx) => {
      const t = low(c);
      if (t === 'kategori' || t === 'category') catCol = idx;
      else if (t === 'location' || t === 'lokasi') locCol = idx;
    });
  }

  // Judul & tahun
  const judul = norm(rows.slice(0, weekRow).flat().find((c) => norm(c)) || '');
  const thn = /\b(20\d{2})\b/.exec(judul);
  const tahun = thn ? Number(thn[1]) : null;

  // 5) Baris data & baris total
  const weekSet = new Set(colWeek.filter((w) => w !== null));
  const weekList = [...weekSet].sort((a, b) => a - b);
  const idxOf = new Map(weekList.map((w, i) => [w, i]));

  const grupMap = new Map(); // kategori → { category, rows: [] }
  const sheetTotals = {};    // minggu → { min, real, pct, target }
  let kategori = '';
  let adaTotal = false;

  for (const r of rows.slice(headerEnd + 1)) {
    const catCell = norm(r[catCol]);
    const locCell = norm(r[locCol]);

    // — Baris total: label di kolom Kategori (B), kolom Lokasi (C) kosong.
    //   Baris bantu grafik berlabel di kolom Lokasi → diabaikan.
    if (catCell && !locCell && /^(total|pres|target)/i.test(catCell)) {
      adaTotal = true;
      kategori = '';
      const t = low(catCell);
      const kunci = /^target/.test(t) ? 'target'
        : /^pres/.test(t) ? 'pct'
        : /terealisasi/.test(t) ? 'real'
        : 'min';
      for (let c = firstWeekCol; c < r.length; c++) {
        const w = colWeek[c];
        if (w === null || !norm(r[c])) continue;
        const st = (sheetTotals[w] ??= {});
        if (st[kunci] !== undefined) continue; // ambil sel pertama yang terisi di grup minggu itu
        const v = kunci === 'min' || kunci === 'real' ? parseCount(r[c]) : parsePct(r[c]);
        if (v !== null) st[kunci] = v;
      }
      continue;
    }
    if (adaTotal) continue;                               // setelah blok total: hanya baris bantu
    if (!catCell && !locCell) continue;                   // baris kosong
    if (!locCell && /^(pres|target|total)/i.test(catCell)) continue;

    if (catCell) kategori = catCell;
    if (!locCell || !kategori) continue;
    if (/^(pres|target|total|week)\b/i.test(locCell)) continue;

    const wk = new Map();
    for (let c = firstWeekCol; c < r.length; c++) {
      const w = colWeek[c], m = colMetric[c];
      if (w === null || !m || !norm(r[c])) continue;
      const e = wk.get(w) ?? { min: null, real: null, belum: null, pct: null };
      e[m] = m === 'pct' ? parsePct(r[c]) : parseCount(r[c]);
      wk.set(w, e);
    }
    if (![...wk.values()].some((e) => e.min !== null)) continue; // bukan baris data

    const v = weekList.map((w) => {
      const e = wk.get(w);
      return e && e.min !== null ? [e.min, e.real, e.belum, e.pct] : null;
    });
    let g = grupMap.get(kategori);
    if (!g) { g = { category: kategori, rows: [] }; grupMap.set(kategori, g); }
    g.rows.push({ location: rapikanLokasi(locCell), v });
  }

  const groups = [...grupMap.values()];
  const totalBaris = groups.reduce((a, g) => a + g.rows.length, 0);
  if (!totalBaris) {
    throw Object.assign(new Error('Tidak ada baris data (Kategori/Lokasi) yang terbaca dari sheet.'), { status: 400 });
  }

  // 6) Minggu yang sudah terisi: ada realisasi > 0 di total semua baris
  const weeks = weekList.map((w, i) => {
    let sMin = 0, sReal = 0;
    for (const g of groups) for (const row of g.rows) {
      const e = row.v[i];
      if (e) { sMin += e[0] ?? 0; sReal += e[1] ?? 0; }
    }
    return { n: w, label: `Week ${String(w).padStart(2, '0')}`, filled: sMin > 0 && sReal > 0 };
  });
  if (!weeks.some((w) => w.filled)) {
    throw Object.assign(new Error('Semua minggu bernilai 0 — sheet belum berisi realisasi.'), { status: 400 });
  }

  const targets = Object.values(sheetTotals).map((t) => t.target).filter((x) => typeof x === 'number');
  const target = targets.length ? targets[targets.length - 1] : 100;

  return {
    title: judul, year: tahun, target,
    weeks, groups,
    sheetTotals,
    meta: { weekRow, metricRow, catCol, locCol, firstWeekCol, rows: totalBaris, weeks: weeks.length, filledWeeks: weeks.filter((w) => w.filled).length, ukuranIdx: idxOf.size },
  };
}

// ── Ambil CSV dari Google Sheets ───────────────────────────────────────────
async function fetchCsvByGid(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  } catch (err) {
    throw Object.assign(new Error(`Tidak bisa menghubungi Google Sheets (${err.name === 'TimeoutError' ? 'timeout' : err.message}).`), { status: 502 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Gagal membaca sheet (HTTP ${res.status}). Pastikan sheet dibagikan sebagai "Anyone with the link — Viewer".`), { status: 400 });
  }
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw Object.assign(new Error('Sheet tidak bisa diakses publik. Ubah izin berbagi sheet menjadi "Anyone with the link — Viewer".'), { status: 400 });
  }
  return text;
}

// ── Repo ──────────────────────────────────────────────────────────────────
export const MinStock = {
  async row() {
    const { rows } = await query(`SELECT * FROM min_stock_sources WHERE id = 'global'`);
    return rows[0] || null;
  },

  async saveSource(sheetId, gid, autoSync) {
    await query(
      `INSERT INTO min_stock_sources (id, sheet_id, gid, auto_sync) VALUES ('global',$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET sheet_id=EXCLUDED.sheet_id, gid=EXCLUDED.gid, auto_sync=EXCLUDED.auto_sync`,
      [sheetId, gid, autoSync !== false]);
  },

  async saveData(data, status) {
    await query(
      `INSERT INTO min_stock_sources (id, data, data_updated_at, last_sync_at, last_status) VALUES ('global',$1,NOW(),NOW(),$2)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, data_updated_at=NOW(), last_sync_at=NOW(), last_status=EXCLUDED.last_status`,
      [JSON.stringify(data), status]);
  },

  async markSync(status) {
    await query(`UPDATE min_stock_sources SET last_sync_at = NOW(), last_status = $1 WHERE id = 'global'`, [status]);
  },

  /** Tarik dari Google Sheets → parse → simpan. Melempar error bila gagal (snapshot lama tetap aman). */
  async syncFromSheet() {
    const r = await this.row();
    if (!r || !r.sheet_id) throw Object.assign(new Error('Sumber spreadsheet belum diatur.'), { status: 400 });
    const csv = await fetchCsvByGid(r.sheet_id, r.gid);
    const data = parseMinStockCsv(csv);
    await this.saveData(data, 'OK');
    return data;
  },

  async payload(isSuperAdmin) {
    const r = await this.row();
    if (!r) return { source: null, data: null };
    const source = r.sheet_id
      ? {
        autoSync: r.auto_sync, lastSyncAt: r.last_sync_at, lastStatus: r.last_status,
        // ID sheet hanya untuk Super Admin (tombol "buka sheet" & kolom edit sumber).
        ...(isSuperAdmin ? { sheetUrl: `https://docs.google.com/spreadsheets/d/${r.sheet_id}/edit?gid=${r.gid}` } : {}),
      }
      : (r.data ? { autoSync: false, lastSyncAt: r.last_sync_at, lastStatus: r.last_status, manual: true } : null);
    return { source, data: r.data || null, dataUpdatedAt: r.data_updated_at };
  },
};

// ── Router ────────────────────────────────────────────────────────────────
// Company-wide: semua user yang login boleh membaca; hanya Super Admin yang
// boleh mengubah sumber / sinkron / impor manual.
export function minStockRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const hanyaSA = (req, res, aksi) => {
    if (req.auth.role === 'Super Admin') return true;
    res.status(403).json({ error: `Hanya Super Admin yang boleh ${aksi}.` });
    return false;
  };

  r.get('/min-stock', requireAuth, wrap(async (req, res) => {
    res.json(await MinStock.payload(req.auth.role === 'Super Admin'));
  }));

  r.post('/min-stock/source', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'mengubah sumber sheet Pencapaian Minimum Stok')) return;
    const { sheetUrl, autoSync } = req.body || {};
    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) return res.status(400).json({ error: 'URL Google Spreadsheet tidak valid.' });
    await MinStock.saveSource(sheetId, extractGid(sheetUrl), autoSync);
    // Langsung coba tarik supaya admin tahu seketika apakah sheet-nya bisa dibaca.
    try {
      const data = await MinStock.syncFromSheet();
      return res.json({ ...(await MinStock.payload(true)), sync: { ok: true, ...data.meta } });
    } catch (err) {
      await MinStock.markSync(err.message);
      return res.json({ ...(await MinStock.payload(true)), sync: { ok: false, error: err.message } });
    }
  }));

  r.post('/min-stock/sync', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'sinkron Pencapaian Minimum Stok')) return;
    try {
      const data = await MinStock.syncFromSheet();
      res.json({ ...(await MinStock.payload(true)), sync: { ok: true, ...data.meta } });
    } catch (err) {
      await MinStock.markSync(err.message).catch(() => {});
      res.status(err.status || 500).json({ error: err.message });
    }
  }));

  // Cadangan bila sheet tidak bisa dibuat publik: ekspor tab sebagai CSV lalu tempel.
  r.post('/min-stock/import', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'mengimpor data Pencapaian Minimum Stok')) return;
    const { csv } = req.body || {};
    if (typeof csv !== 'string' || csv.length < 20) return res.status(400).json({ error: 'Isi CSV kosong.' });
    const data = parseMinStockCsv(csv);
    await MinStock.saveData(data, 'Impor manual');
    res.json({ ...(await MinStock.payload(true)), sync: { ok: true, ...data.meta } });
  }));

  return r;
}

/** Auto-sync berkala (sama polanya dengan Work Target / PICA). */
export function startMinStockAutoSync(intervalMs = 5 * 60 * 1000) {
  const tick = async () => {
    try {
      const r = await MinStock.row();
      if (!r || !r.sheet_id || !r.auto_sync) return;
      await MinStock.syncFromSheet();
    } catch (err) {
      console.warn('[min-stock] auto-sync gagal:', err.message);
      try { await MinStock.markSync(err.message); } catch { /* noop */ }
    }
  };
  tick();
  setInterval(tick, intervalMs).unref();
}
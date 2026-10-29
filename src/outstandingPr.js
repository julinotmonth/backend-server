// ── Outstanding PR (tab "RESUME ALL MS&WS" pada workbook "Outstanding PR ALL MS & WS") ──
// Satu sheet ringkasan untuk seluruh perusahaan:
//
//   ,MS/WS,Kategori,Status ERP,,,,Total PR/Kategori,Total PR/MS
//   ,,,Pending Approval,,Realesed
//   ,,,Qty/Kategori,Total/MS,Qty/Kategori,Total/MS
//   ,MS-SETU,FastMoving/Stock,0 PR,0 PR,2 PR,35 PR,2 PR,35 PR      ← baris pertama site memuat total site
//   ,,Min Stock/Critical Part,0 PR,,12 PR,,12 PR                    ← baris berikutnya hanya per kategori
//   ...
//   ,Grand Total OS PR,,2 PR,,86 PR,,102 PR
//
// Parser SENGAJA berbasis isi sel ("N PR"), bukan posisi header, karena Google
// (gviz) kadang menggabung/menggeser header bertingkat. Kolom Pending / Released /
// Total dipelajari dari baris pertama site (6 sel "N PR"), lalu dipakai untuk semua baris.
//
// Angka di dashboard SELALU dihitung ulang dari baris per kategori. Bila Grand Total /
// total site di sheet berbeda dari hasil hitung, selisihnya dicatat di `notes`
// (sheet asli saat ini: Released tertulis 86, jumlah per site 100).
//
// Sheet ini hanya satu snapshot (tanpa riwayat), jadi tiap sinkron disimpan sebagai
// satu titik per minggu di `history` agar tren terbentuk dari waktu ke waktu.

import express from 'express';
import { query } from './db.js';
import { SHEETS_BASE, fetchGoogleText } from './googleFetch.js';
import { requireAuth } from './auth.js';
import { parseCsv } from './weeklyReport.js';
import { extractSheetId, extractGid } from './workTarget.js';

export const OUTSTANDING_PR_SCHEMA = `
CREATE TABLE IF NOT EXISTS outstanding_pr_sources (
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

/** "12 PR" → 12, "1.234 PR" → 1234; bukan format itu → null. */
function prNum(raw) {
  const m = /^([\d.]+)\s*PR$/i.exec(norm(raw));
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "MS-SETU" → "MS Setu", "WS-CIBUNGUR" → "WS Cibungur", typo "Sangkurilang" → "LNG Sangkulirang". */
function rapikanSite(s) {
  let t = norm(s).replace(/[-_]+/g, ' ');
  t = t.replace(/sangku?r?i?lang|sangkulirang/i, 'Sangkulirang');
  return t.split(' ').map((tok) => (/^[A-Z]{4,}$/.test(tok) ? tok[0] + tok.slice(1).toLowerCase() : tok)).join(' ');
}
/** "OTHER" → "Other"; teks campuran dibiarkan ("FastMoving/Stock"). */
function rapikanKategori(s) {
  const t = norm(s);
  return t && t === t.toUpperCase() ? t[0] + t.slice(1).toLowerCase() : t;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const GRAND_RE = /grand\s*total|total\s*os/i;

export function parseOutstandingPrCsv(csvText) {
  const rows = parseCsv(String(csvText || ''));
  if (!rows.length) throw Object.assign(new Error('CSV kosong.'), { status: 400 });

  // Judul & nomor minggu (bila ada di sheet)
  const kepala = rows.slice(0, 8).flat().map(norm).filter(Boolean);
  const title = kepala.find((c) => /outstanding/i.test(c) && prNum(c) === null) || 'Progres Outstanding PR';
  const wk = /week\s*0*(\d{1,2})/i.exec(kepala.join(' '));
  const weekFromSheet = wk ? Number(wk[1]) : null;

  // 1) Kumpulkan baris yang berisi sel "N PR"
  const kandidat = [];
  for (const r of rows) {
    const cells = r.map(norm);
    const prCols = cells.map((c, i) => (prNum(c) !== null ? i : -1)).filter((i) => i >= 0);
    if (prCols.length < 3) continue;
    const teks = cells.map((c, i) => ({ c, i })).filter((x) => x.c && prNum(x.c) === null).map((x) => x.c);
    kandidat.push({ cells, prCols, teks });
  }
  if (!kandidat.length) {
    throw Object.assign(new Error('Format sheet tidak dikenali: tidak ada sel berformat "N PR". Pastikan link mengarah ke tab "RESUME ALL MS&WS".'), { status: 400 });
  }

  // 2) Pelajari kolom: dari baris pertama yang punya 6 sel "N PR"
  const penuh = kandidat.find((k) => k.prCols.length >= 6 && !GRAND_RE.test(k.teks.join(' ')));
  const tiga = kandidat.find((k) => k.prCols.length === 3);
  let colP, colR, colT;
  if (penuh) [colP, , colR, , colT] = penuh.prCols;
  else if (tiga) [colP, colR, colT] = tiga.prCols;
  else throw Object.assign(new Error('Susunan kolom Pending / Released / Total tidak terbaca.'), { status: 400 });
  const colPm = colP + 1, colRm = colR + 1, colTm = colT + 1; // kolom "Total/MS"

  const val = (cells, c) => { const n = prNum(cells[c]); return n === null ? null : n; };

  // 3) Baca baris data
  const sites = [];
  const peta = new Map();
  const kategoriUrut = [];
  const sheetSite = {};
  let sheetGrand = null;
  let cur = null;

  for (const k of kandidat) {
    const { cells, teks } = k;
    if (GRAND_RE.test(teks.join(' '))) {
      sheetGrand = { pending: val(cells, colP), released: val(cells, colR), total: val(cells, colT) };
      break;
    }
    if (!teks.length) continue;
    let namaSite = null, namaKat;
    if (teks.length >= 2) { namaSite = teks[0]; namaKat = teks[1]; }
    else namaKat = teks[0];

    if (namaSite) {
      const label = rapikanSite(namaSite);
      const key = slug(label);
      if (!peta.has(key)) { const s = { key, label, categories: [], totals: { pending: 0, released: 0, total: 0 } }; peta.set(key, s); sites.push(s); }
      cur = peta.get(key);
      const pm = val(cells, colPm), rm = val(cells, colRm), tm = val(cells, colTm);
      if (tm !== null || pm !== null || rm !== null) sheetSite[key] = { pending: pm, released: rm, total: tm };
    }
    if (!cur) continue;

    const pending = val(cells, colP) ?? 0;
    const released = val(cells, colR) ?? 0;
    const total = val(cells, colT) ?? pending + released;
    const nama = rapikanKategori(namaKat);
    if (!kategoriUrut.includes(nama)) kategoriUrut.push(nama);
    cur.categories.push({ name: nama, pending, released, total });
  }

  if (!sites.length) throw Object.assign(new Error('Tidak ada baris site/kategori yang terbaca dari sheet.'), { status: 400 });

  // 4) Hitung ulang total & kumpulkan catatan selisih
  const notes = [];
  const grand = { pending: 0, released: 0, total: 0 };
  for (const s of sites) {
    for (const c of s.categories) {
      if (c.total !== c.pending + c.released) notes.push(`${s.label} · ${c.name}: total ${c.total} PR ≠ Pending ${c.pending} + Released ${c.released}.`);
      s.totals.pending += c.pending; s.totals.released += c.released; s.totals.total += c.total;
    }
    const st = sheetSite[s.key];
    if (st && st.total !== null && st.total !== s.totals.total) {
      notes.push(`${s.label}: total di sheet ${st.total} PR, jumlah per kategori ${s.totals.total} PR.`);
    }
    grand.pending += s.totals.pending; grand.released += s.totals.released; grand.total += s.totals.total;
  }
  if (sheetGrand) {
    const beda = [['Pending Approval', 'pending'], ['Released', 'released'], ['Total', 'total']]
      .filter(([, f]) => sheetGrand[f] !== null && sheetGrand[f] !== grand[f])
      .map(([n, f]) => `${n}: sheet ${sheetGrand[f]} PR, jumlah seluruh site ${grand[f]} PR`);
    if (beda.length) notes.push(`Grand Total di sheet tidak sama dengan jumlah per site — ${beda.join('; ')}. Dashboard memakai jumlah per site.`);
  }

  return {
    title, weekFromSheet,
    categories: kategoriUrut,
    sites, grand, sheetGrand, notes,
    meta: { sites: sites.length, categories: kategoriUrut.length, rows: sites.reduce((a, s) => a + s.categories.length, 0), colP, colR, colT },
  };
}

// ── Riwayat mingguan ──────────────────────────────────────────────────────
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { y, w };
}

function tambahRiwayat(prev, parsed, now = new Date()) {
  const { y, w } = parseInt(parsed.weekFromSheet, 10) ? { y: isoWeek(now).y, w: parsed.weekFromSheet } : isoWeek(now);
  const week = `${y}-W${String(w).padStart(2, '0')}`;
  const entri = {
    week, label: `W${String(w).padStart(2, '0')}`, date: now.toISOString(),
    total: parsed.grand.total, pending: parsed.grand.pending, released: parsed.grand.released,
    perSite: Object.fromEntries(parsed.sites.map((s) => [s.label, s.totals.total])),
  };
  return [...(Array.isArray(prev) ? prev : []).filter((h) => h.week !== week), entri]
    .sort((a, b) => a.week.localeCompare(b.week)).slice(-52);
}

// ── Ambil CSV dari Google Sheets ───────────────────────────────────────────
async function fetchCsvByGid(sheetId, gid) {
  const url = `${SHEETS_BASE}/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
  const { ok, status, text } = await fetchGoogleText(url);
  if (!ok) {
    throw Object.assign(new Error(`Gagal membaca sheet (HTTP ${status}). Pastikan sheet dibagikan sebagai "Anyone with the link — Viewer".`), { status: 400 });
  }
  if (text.trimStart().startsWith('<')) {
    throw Object.assign(new Error('Sheet tidak bisa diakses publik. Ubah izin berbagi sheet menjadi "Anyone with the link — Viewer".'), { status: 400 });
  }
  return text;
}

// ── Repo ──────────────────────────────────────────────────────────────────
export const OutstandingPr = {
  async row() {
    const { rows } = await query(`SELECT * FROM outstanding_pr_sources WHERE id = 'global'`);
    return rows[0] || null;
  },

  async saveSource(sheetId, gid, autoSync) {
    await query(
      `INSERT INTO outstanding_pr_sources (id, sheet_id, gid, auto_sync) VALUES ('global',$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET sheet_id=EXCLUDED.sheet_id, gid=EXCLUDED.gid, auto_sync=EXCLUDED.auto_sync`,
      [sheetId, gid, autoSync !== false]);
  },

  async saveData(parsed, status) {
    const prev = (await this.row())?.data?.history;
    const data = { ...parsed, history: tambahRiwayat(prev, parsed) };
    await query(
      `INSERT INTO outstanding_pr_sources (id, data, data_updated_at, last_sync_at, last_status) VALUES ('global',$1,NOW(),NOW(),$2)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, data_updated_at=NOW(), last_sync_at=NOW(), last_status=EXCLUDED.last_status`,
      [JSON.stringify(data), status]);
    return data;
  },

  async markSync(status) {
    await query(`UPDATE outstanding_pr_sources SET last_sync_at = NOW(), last_status = $1 WHERE id = 'global'`, [status]);
  },

  async syncFromSheet() {
    const r = await this.row();
    if (!r || !r.sheet_id) throw Object.assign(new Error('Sumber spreadsheet belum diatur.'), { status: 400 });
    const parsed = parseOutstandingPrCsv(await fetchCsvByGid(r.sheet_id, r.gid));
    return this.saveData(parsed, 'OK');
  },

  async payload(isSuperAdmin) {
    const r = await this.row();
    if (!r) return { source: null, data: null };
    const source = r.sheet_id
      ? {
        autoSync: r.auto_sync, lastSyncAt: r.last_sync_at, lastStatus: r.last_status,
        ...(isSuperAdmin ? { sheetUrl: `https://docs.google.com/spreadsheets/d/${r.sheet_id}/edit?gid=${r.gid}` } : {}),
      }
      : (r.data ? { autoSync: false, lastSyncAt: r.last_sync_at, lastStatus: r.last_status, manual: true } : null);
    return { source, data: r.data || null, dataUpdatedAt: r.data_updated_at };
  },
};

// ── Router ────────────────────────────────────────────────────────────────
// Company-wide: semua user login boleh membaca; hanya Super Admin yang mengubah sumber / sinkron / impor.
export function outstandingPrRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const hanyaSA = (req, res, aksi) => {
    if (req.auth.role === 'Super Admin') return true;
    res.status(403).json({ error: `Hanya Super Admin yang boleh ${aksi}.` });
    return false;
  };

  r.get('/outstanding-pr', requireAuth, wrap(async (req, res) => {
    res.json(await OutstandingPr.payload(req.auth.role === 'Super Admin'));
  }));

  r.post('/outstanding-pr/source', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'mengubah sumber sheet Outstanding PR')) return;
    const { sheetUrl, autoSync } = req.body || {};
    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) return res.status(400).json({ error: 'URL Google Spreadsheet tidak valid.' });
    await OutstandingPr.saveSource(sheetId, extractGid(sheetUrl), autoSync);
    try {
      const data = await OutstandingPr.syncFromSheet();
      return res.json({ ...(await OutstandingPr.payload(true)), sync: { ok: true, ...data.meta } });
    } catch (err) {
      await OutstandingPr.markSync(err.message);
      return res.json({ ...(await OutstandingPr.payload(true)), sync: { ok: false, error: err.message } });
    }
  }));

  r.post('/outstanding-pr/sync', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'sinkron Outstanding PR')) return;
    try {
      const data = await OutstandingPr.syncFromSheet();
      res.json({ ...(await OutstandingPr.payload(true)), sync: { ok: true, ...data.meta } });
    } catch (err) {
      await OutstandingPr.markSync(err.message).catch(() => {});
      res.status(err.status || 500).json({ error: err.message });
    }
  }));

  // Cadangan bila sheet tidak bisa dibuat publik: ekspor tab sebagai CSV lalu unggah.
  r.post('/outstanding-pr/import', requireAuth, wrap(async (req, res) => {
    if (!hanyaSA(req, res, 'mengimpor data Outstanding PR')) return;
    const { csv } = req.body || {};
    if (typeof csv !== 'string' || csv.length < 20) return res.status(400).json({ error: 'Isi CSV kosong.' });
    const data = await OutstandingPr.saveData(parseOutstandingPrCsv(csv), 'Impor manual');
    res.json({ ...(await OutstandingPr.payload(true)), sync: { ok: true, ...data.meta } });
  }));

  return r;
}

/** Auto-sync berkala (pola sama dengan Work Target / Minimum Stok). */
export function startOutstandingPrAutoSync(intervalMs = 5 * 60 * 1000) {
  let berjalan = false;
  const tick = async () => {
    if (berjalan) return; // putaran lama belum selesai — jangan bertumpuk
    berjalan = true;
    try {
      const r = await OutstandingPr.row();
      if (!r || !r.sheet_id || !r.auto_sync) return;
      await OutstandingPr.syncFromSheet();
    } catch (err) {
      console.warn('[outstanding-pr] auto-sync gagal:', err.message);
      try { await OutstandingPr.markSync(err.message); } catch { /* noop */ }
    } finally {
      berjalan = false;
    }
  };
  // Jeda awal bertingkat (lihat index.js) supaya tidak semua sync menyerbu saat server baru bangun.
  setTimeout(tick, 90000).unref();
  setInterval(tick, intervalMs).unref();
}
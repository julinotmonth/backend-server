// ── Work Target Tracker (Pencapaian Work Target Divisi Inventory & Asset) ──
// Beda dari weekly_report_rows (per site) dan pica_items (per site): sheet
// ini SATU untuk seluruh perusahaan, bukan per site — barisnya adalah daftar
// "Strategi/Guideline" yang dikelompokkan di bawah satu "Work Target /
// Objective", dengan capaian dilaporkan PER BULAN (bukan per minggu), dan
// grup Objective/Activity/No ditulis lewat sel gabung (cuma terisi di baris
// pertama tiap grup, baris-baris di bawahnya kosong tapi "mewarisi" nilai
// grup itu — sama seperti pola sub-bab di sheet "LIST ALL ASET ..." pada
// weeklyReport.js, hanya beda nama field).
//
// Sheet aslinya punya 23 tab: tab "WT 26" adalah
// tracker utamanya (persis ini yang diimpor di sini). 22 tab lain
// (CP/PM/SO per site, Summary Asset, List PRS) tampak seperti sumber data
// pendukung yang dipakai manual untuk mengisi persentase Pencapaian di tab
// utama — BELUM diimpor di modul ini; lihat catatan di README kalau nanti
// mau ditambahkan sebagai drill-down per site.

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { parseCsv } from './weeklyReport.js';

// ── Schema ────────────────────────────────────────────────────────────────
export const WORK_TARGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_target_items (
  id             TEXT PRIMARY KEY,
  row_hash       TEXT NOT NULL UNIQUE,
  no_objective   TEXT NOT NULL DEFAULT '',
  objective      TEXT NOT NULL DEFAULT '',
  activity       TEXT NOT NULL DEFAULT '',
  strategi       TEXT NOT NULL DEFAULT '',
  pic            TEXT NOT NULL DEFAULT '',
  target_raw     TEXT NOT NULL DEFAULT '',
  target_angka   NUMERIC,
  pencapaian     JSONB NOT NULL DEFAULT '{}',  -- { "Jan": "86%", "Feb": "92%", ... }
  bulan_urut     JSONB NOT NULL DEFAULT '[]',  -- ["Jan","Feb",...] urutan kolom bulan di sheet
  bulan_terakhir TEXT NOT NULL DEFAULT '',
  capaian_angka  NUMERIC,                       -- angka capaian bulan_terakhir, buat sorting/status
  keterangan     TEXT NOT NULL DEFAULT '',
  urutan         INTEGER NOT NULL DEFAULT 0,    -- urutan baris asli di sheet, biar tampilannya konsisten
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by    TEXT
);

CREATE TABLE IF NOT EXISTS work_target_sources (
  id           TEXT PRIMARY KEY DEFAULT 'global', -- sheet-nya satu untuk seluruh perusahaan, bukan per site
  sheet_id     TEXT NOT NULL,
  gid          TEXT NOT NULL DEFAULT '0',
  auto_sync    BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  last_status  TEXT NOT NULL DEFAULT ''
);
`;

// ── Parsing ───────────────────────────────────────────────────────────────
const norm = (h) => String(h || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

const BULAN_KANON = {
  jan: 'Jan', januari: 'Jan',
  feb: 'Feb', februari: 'Feb',
  mar: 'Mar', maret: 'Mar',
  apr: 'Apr', april: 'Apr',
  mei: 'Mei', may: 'Mei',
  jun: 'Jun', juni: 'Jun',
  jul: 'Jul', juli: 'Jul',
  agu: 'Agu', ags: 'Agu', agt: 'Agu', agustus: 'Agu', aug: 'Agu',
  sep: 'Sep', sept: 'Sep', september: 'Sep',
  okt: 'Okt', oktober: 'Okt', oct: 'Okt',
  nov: 'Nov', november: 'Nov',
  des: 'Des', desember: 'Des', dec: 'Des',
};
const URUTAN_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const kanonBulan = (label) => BULAN_KANON[norm(label).replace(/[^a-z]/g, '')] || null;

/** Ubah "86%", "99,7%", "100" jadi angka. Kosong/tidak valid → null. */
function parseAngkaPersen(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const bersih = s.replace('%', '').replace(',', '.').trim();
  const n = Number(bersih);
  return Number.isFinite(n) ? n : null;
}

function previewRows(rows, n = 20) {
  return rows.slice(0, n).map((r, i) => {
    const isi = r.map((c, ci) => (c && String(c).trim() ? `[${ci}]${String(c).trim().slice(0, 40)}` : null)).filter(Boolean);
    return isi.length ? `baris ${i + 1}: ${isi.join('  ')}` : `baris ${i + 1}: (kosong)`;
  }).join('\n');
}

/** CSV mentah tab "WT 26" → daftar baris Strategi/Guideline (sudah "mewarisi"
 * No/Objective/Activity dari baris pertama grupnya). Kolom dicari lewat
 * header, bukan huruf kolom tetap, supaya tahan kalau sheet berubah letak
 * kolom (mis. kolom disisipkan) atau kolom bulan terus bertambah tiap bulan
 * berjalan (Agustus, September, dst. ditambahkan begitu saja oleh admin sheet
 * di sebelah kanan kolom Juli tanpa pemberitahuan ke sistem ini).
 */
export function parseWorkTargetCsv(csvText) {
  const rows = parseCsv(csvText);

  // Baris anchor: mengandung "no" DAN sebuah sel yang memuat "strategi" —
  // dua penanda ini jauh lebih stabil daripada mengandalkan "work target"
  // saja (yang juga muncul di judul besar baris 1: "Work Target
  // Divisi/Departemen ...").
  const headIdx = rows.findIndex((r) => {
    const n = r.map(norm);
    return n.includes('no') && n.some((c) => c.includes('strategi'));
  });
  if (headIdx < 0) {
    throw Object.assign(new Error(
      `Tidak menemukan baris header (kolom "No" + "Strategi/Guideline") di sheet ini. ` +
      `Isi yang benar-benar terbaca (20 baris pertama):\n${previewRows(rows)}`
    ), { status: 400 });
  }
  const headerRaw = rows[headIdx];
  const header = headerRaw.map(norm);
  const cariKolom = (cocok) => header.findIndex(cocok);

  const noIdx = cariKolom((c) => c === 'no');
  const objectiveIdx = cariKolom((c) => c.includes('work target') || c.includes('objective'));
  const strategiIdx = cariKolom((c) => c.includes('strategi'));
  const activityIdx = cariKolom((c) => c.includes('activity') || c.includes('rencana kerja'));
  const picIdx = cariKolom((c) => c === 'pic');
  const keteranganIdx = cariKolom((c) => c.includes('keterangan'));
  if (strategiIdx < 0 || picIdx < 0) {
    throw Object.assign(new Error(
      `Baris header ditemukan di baris ${headIdx + 1}, tapi gagal memetakan kolom Strategi/Guideline atau PIC. ` +
      `Isi baris header: ${headerRaw.map((c, ci) => (c ? `[${ci}]${c}` : null)).filter(Boolean).join('  ')}`
    ), { status: 400 });
  }

  // Header sheet ini bertingkat (baris "[Bulan]" merged → sub-header "Target"
  // /"Pencapaian" → nama bulan). Hasil ekspor CSV Google (gviz) BISA menggabung
  // baris-baris header itu jadi SATU label per kolom — mis. kolom Target
  // berlabel "[Bulan] Target" dan kolom Januari berlabel "Pencapaian Jan"
  // (bukan "Target" dan "Jan" polos). Kalau dicocokkan persis, Target dan
  // Januari lolos tak terbaca (kejadian nyata: semua baris jadi "belum ada
  // data" dan grafik mulai dari Februari). Makanya dicocokkan per KATA, bukan
  // per isi sel utuh — jalan untuk kedua bentuk (label tergabung maupun
  // header bertingkat asli di baris-baris terpisah).
  const kata = (c) => norm(c).split(/[^a-z0-9]+/).filter(Boolean);
  const tetap = new Set([noIdx, objectiveIdx, strategiIdx, activityIdx, picIdx, keteranganIdx].filter((i) => i >= 0));
  const bulanDariSel = (c) => {
    const k = kata(c);
    if (!k.length || k.length > 3) return null; // kalimat panjang bukan label bulan
    for (const t of k) if (BULAN_KANON[t]) return BULAN_KANON[t];
    return null;
  };
  let targetIdx = -1;
  const kandidatBulan = []; // { rowIdx, cols: [{c, label}] }
  for (let r = headIdx; r <= Math.min(headIdx + 3, rows.length - 1); r++) {
    const baris = rows[r] || [];
    if (targetIdx < 0) {
      const idx = baris.findIndex((c, ci) => {
        if (tetap.has(ci) || ci <= picIdx) return false;
        const k = kata(c);
        return k.length > 0 && k.length <= 3 && k.includes('target');
      });
      if (idx >= 0) targetIdx = idx;
    }
    const cols = [];
    baris.forEach((c, ci) => {
      if (tetap.has(ci)) return;
      const b = bulanDariSel(c);
      if (b) cols.push({ c: ci, label: b });
    });
    if (cols.length) kandidatBulan.push({ rowIdx: r, cols });
  }
  if (!kandidatBulan.length) {
    throw Object.assign(new Error(
      `Header kolom bulan (Jan/Feb/Mar/dst.) tidak ditemukan di sekitar baris ${headIdx + 1}. ` +
      `Isi yang benar-benar terbaca:\n${previewRows(rows.slice(headIdx), 10)}`
    ), { status: 400 });
  }
  // Ambil baris dengan jumlah kolom-bulan TERBANYAK sebagai baris bulan asli
  // (baris lain di sekitarnya biasanya cuma kebetulan mengandung 1-2 kata
  // yang mirip nama bulan).
  kandidatBulan.sort((a, b) => b.cols.length - a.cols.length);
  const { rowIdx: barisBulan, cols: kolomBulan } = kandidatBulan[0];
  // Cadangan: kalau label "Target" tetap tak ketemu, kolom Target selalu
  // tepat di sebelah kiri kolom bulan pertama (persis susunan sheet aslinya).
  if (targetIdx < 0 && kolomBulan[0].c - 1 > picIdx) targetIdx = kolomBulan[0].c - 1;

  const dataStartIdx = barisBulan + 1;
  const out = [];
  let noBerjalan = '', objectiveBerjalan = '', activityBerjalan = '';
  let urutan = 0;

  for (const r of rows.slice(dataStartIdx)) {
    const strategiVal = String(r[strategiIdx] || '').trim();
    const noVal = noIdx >= 0 ? String(r[noIdx] || '').trim() : '';
    const objVal = objectiveIdx >= 0 ? String(r[objectiveIdx] || '').trim() : '';
    const actVal = activityIdx >= 0 ? String(r[activityIdx] || '').trim() : '';
    if (noVal) noBerjalan = noVal;
    if (objVal) objectiveBerjalan = objVal;
    if (actVal) activityBerjalan = actVal;
    if (!strategiVal) continue; // baris kosong / pemisah antar grup — bukan baris data

    const targetRaw = targetIdx >= 0 ? String(r[targetIdx] || '').trim() : '';
    const pencapaian = {};
    for (const { c, label } of kolomBulan) {
      const v = String(r[c] || '').trim();
      if (v) pencapaian[label] = v;
    }
    const bulanUrut = kolomBulan.map((k) => k.label);
    const bulanTerisi = bulanUrut.filter((b) => pencapaian[b]);
    const bulanTerakhir = bulanTerisi[bulanTerisi.length - 1] || '';

    urutan++;
    out.push({
      noObjective: noBerjalan,
      objective: objectiveBerjalan,
      activity: activityBerjalan,
      strategi: strategiVal,
      pic: picIdx >= 0 ? String(r[picIdx] || '').trim() : '',
      targetRaw,
      targetAngka: parseAngkaPersen(targetRaw),
      pencapaian,
      bulanUrut,
      bulanTerakhir,
      capaianAngka: bulanTerakhir ? parseAngkaPersen(pencapaian[bulanTerakhir]) : null,
      keterangan: keteranganIdx >= 0 ? String(r[keteranganIdx] || '').trim() : '',
      urutan,
    });
  }
  if (!out.length) {
    throw Object.assign(new Error(
      `Header ditemukan di baris ${headIdx + 1} dan kolom bulan di baris ${barisBulan + 1}, tapi tidak ada ` +
      `baris data di bawahnya yang punya isi di kolom Strategi/Guideline. Isi yang terbaca:\n${previewRows(rows.slice(barisBulan), 15)}`
    ), { status: 400 });
  }
  out.meta = {
    barisHeader: headIdx + 1, targetIdx,
    bulan: kolomBulan.map((k) => `${k.label}@${k.c}`),
  };
  return out;
}

const hashRow = (r) => [r.noObjective, r.strategi, r.pic].join('|').toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

export function extractSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null);
}
export function extractGid(input) {
  const m = String(input || '').match(/[?&#]gid=(\d+)/);
  return m ? m[1] : '0';
}

async function fetchCsvByGid(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw Object.assign(new Error(`Gagal membaca sheet (HTTP ${res.status}). Pastikan sheet dibagikan sebagai "Anyone with the link — Viewer".`), { status: 400 });
  }
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw Object.assign(new Error('Sheet tidak bisa diakses publik. Ubah izin berbagi sheet menjadi "Anyone with the link".'), { status: 400 });
  }
  return text;
}

// ── Repo ──────────────────────────────────────────────────────────────────
export const WorkTargetItems = {
  async upsertMany(records, importedBy) {
    let inserted = 0, updated = 0;
    const hashesInBatch = [];
    for (const r of records) {
      const hash = hashRow(r);
      hashesInBatch.push(hash);
      const { rows } = await query(
        `INSERT INTO work_target_items
           (id, row_hash, no_objective, objective, activity, strategi, pic, target_raw,
            target_angka, pencapaian, bulan_urut, bulan_terakhir, capaian_angka, keterangan, urutan, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (row_hash) DO UPDATE SET
           no_objective=EXCLUDED.no_objective, objective=EXCLUDED.objective, activity=EXCLUDED.activity,
           target_raw=EXCLUDED.target_raw, target_angka=EXCLUDED.target_angka, pencapaian=EXCLUDED.pencapaian,
           bulan_urut=EXCLUDED.bulan_urut, bulan_terakhir=EXCLUDED.bulan_terakhir,
           capaian_angka=EXCLUDED.capaian_angka, keterangan=EXCLUDED.keterangan, urutan=EXCLUDED.urutan,
           imported_at=NOW(), imported_by=EXCLUDED.imported_by
         RETURNING (xmax = 0) AS is_new`,
        [`wt-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, hash,
         r.noObjective, r.objective, r.activity, r.strategi, r.pic, r.targetRaw, r.targetAngka,
         JSON.stringify(r.pencapaian), JSON.stringify(r.bulanUrut), r.bulanTerakhir, r.capaianAngka,
         r.keterangan, r.urutan, importedBy]
      );
      rows[0].is_new ? inserted++ : updated++;
    }
    let removed = 0;
    if (hashesInBatch.length > 0) {
      const res = await query(`DELETE FROM work_target_items WHERE NOT (row_hash = ANY($1::text[]))`, [hashesInBatch]);
      removed = res.rowCount;
    }
    return { inserted, updated, removed, total: records.length };
  },

  async list() {
    const { rows } = await query('SELECT * FROM work_target_items ORDER BY urutan');
    return rows.map((r) => ({
      id: r.id, noObjective: r.no_objective, objective: r.objective, activity: r.activity,
      strategi: r.strategi, pic: r.pic, targetRaw: r.target_raw, targetAngka: r.target_angka !== null ? Number(r.target_angka) : null,
      pencapaian: r.pencapaian, bulanUrut: r.bulan_urut, bulanTerakhir: r.bulan_terakhir,
      capaianAngka: r.capaian_angka !== null ? Number(r.capaian_angka) : null,
      keterangan: r.keterangan, urutan: r.urutan, importedAt: r.imported_at,
    }));
  },

  async source() {
    const { rows } = await query(`SELECT * FROM work_target_sources WHERE id = 'global'`);
    if (!rows[0]) return null;
    const r = rows[0];
    return { sheetId: r.sheet_id, gid: r.gid, autoSync: r.auto_sync, lastSyncAt: r.last_sync_at, lastStatus: r.last_status };
  },

  async saveSource(sheetId, gid, autoSync) {
    await query(
      `INSERT INTO work_target_sources (id, sheet_id, gid, auto_sync) VALUES ('global',$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET sheet_id=EXCLUDED.sheet_id, gid=EXCLUDED.gid, auto_sync=EXCLUDED.auto_sync`,
      [sheetId, gid, autoSync !== false]);
    return this.source();
  },

  async markSync(status) {
    await query(`UPDATE work_target_sources SET last_sync_at = NOW(), last_status = $1 WHERE id = 'global'`, [status]);
  },
};

// ── Router ────────────────────────────────────────────────────────────────
// Sheet ini company-wide (bukan per site) — siapa pun yang sudah login boleh
// membacanya, tapi cuma Super Admin yang boleh mengubah Sumber Sheet/sync,
// karena ini mempengaruhi data yang dilihat SEMUA site sekaligus.
export function workTargetRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.get('/work-target', requireAuth, wrap(async (_req, res) => {
    res.json(await WorkTargetItems.list());
  }));

  r.get('/work-target/source', requireAuth, wrap(async (_req, res) => {
    res.json(await WorkTargetItems.source());
  }));

  r.post('/work-target/source', requireAuth, wrap(async (req, res) => {
    if (req.auth.role !== 'Super Admin') return res.status(403).json({ error: 'Hanya Super Admin yang boleh mengubah sumber sheet Work Target.' });
    const { sheetUrl, autoSync } = req.body || {};
    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) return res.status(400).json({ error: 'URL Google Spreadsheet wajib diisi.' });
    const gid = extractGid(sheetUrl);
    res.json(await WorkTargetItems.saveSource(sheetId, gid, autoSync));
  }));

  r.post('/work-target/sync', requireAuth, wrap(async (req, res) => {
    if (req.auth.role !== 'Super Admin') return res.status(403).json({ error: 'Hanya Super Admin yang boleh sync Work Target.' });
    const src = await WorkTargetItems.source();
    if (!src) return res.status(400).json({ error: 'Sumber spreadsheet Work Target belum diatur.' });
    try {
      const csv = await fetchCsvByGid(src.sheetId, src.gid);
      const records = parseWorkTargetCsv(csv);
      const stat = await WorkTargetItems.upsertMany(records, req.auth.email);
      await WorkTargetItems.markSync('OK');
      res.json({ syncedAt: new Date().toISOString(), ...stat, terbaca: records.meta });
    } catch (err) {
      await WorkTargetItems.markSync(err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  }));

  return r;
}

/** Auto-sync berkala — dipanggil dari index.js bersamaan dengan startAutoSync()
 * (weeklyReport.js) dan startPicaAutoSync() (pica.js). */
export function startWorkTargetAutoSync(intervalMs = 5 * 60 * 1000) {
  const tick = async () => {
    try {
      const src = await WorkTargetItems.source();
      if (!src || !src.autoSync) return;
      const csv = await fetchCsvByGid(src.sheetId, src.gid);
      const records = parseWorkTargetCsv(csv);
      if (records.length) await WorkTargetItems.upsertMany(records, 'auto-sync');
      await WorkTargetItems.markSync('OK');
    } catch (err) {
      console.warn('[work-target] auto-sync gagal:', err.message);
      try { await WorkTargetItems.markSync(err.message); } catch { /* noop */ }
    }
  };
  tick();
  setInterval(tick, intervalMs);
}
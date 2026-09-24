// ── PICA Tracker (Problem / Identification / Corrective Action) per Site ──
// Beda total struktur dari weekly_report_rows (Barang Masuk/Keluar/Aset):
// sheet-nya "lebar" — satu baris per isu, dengan satu KOLOM per minggu yang
// menyimpan catatan status terbaru minggu itu (kolom minggu terus bertambah
// tiap minggu berjalan, bukan baris baru). Modul ini mandiri, dipasang dari
// index.js dengan pola yang sama seperti weeklyReport.js.

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { parseCsv, parseTanggal } from './weeklyReport.js';

// ── Schema ────────────────────────────────────────────────────────────────
export const PICA_SCHEMA = `
CREATE TABLE IF NOT EXISTS pica_items (
  id             TEXT PRIMARY KEY,
  site           TEXT NOT NULL,
  row_hash       TEXT NOT NULL,
  no             TEXT NOT NULL DEFAULT '',
  tanggal        DATE,
  problem        TEXT NOT NULL DEFAULT '',
  identifikasi   TEXT NOT NULL DEFAULT '',
  deskripsi      TEXT NOT NULL DEFAULT '',
  target_date    DATE,
  pic            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT '',
  updates        JSONB NOT NULL DEFAULT '[]',  -- [{ "week": "Week 34", "catatan": "..." }, ...]
  latest_week    TEXT NOT NULL DEFAULT '',
  latest_note    TEXT NOT NULL DEFAULT '',
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by    TEXT,
  UNIQUE (site, row_hash)
);
CREATE INDEX IF NOT EXISTS idx_pica_site ON pica_items(site);
CREATE INDEX IF NOT EXISTS idx_pica_status ON pica_items(site, status);

-- Konfigurasi sumber sheet per site. Disimpan lewat GID (bukan nama tab)
-- karena tab PICA sering tak punya nama unik yang gampang diketik ulang
-- persis — GID langsung terbaca dari URL yang di-paste admin, jadi bebas
-- dari kelas bug "nama tab typo/spasi ganda" yang pernah terjadi di
-- weekly_report_sources (lihat catatan assertDirectionMatches di weeklyReport.js).
CREATE TABLE IF NOT EXISTS pica_sources (
  site         TEXT PRIMARY KEY,
  sheet_id     TEXT NOT NULL,
  gid          TEXT NOT NULL DEFAULT '0',
  auto_sync    BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  last_status  TEXT NOT NULL DEFAULT ''
);
`;

// ── Parsing ───────────────────────────────────────────────────────────────
const norm = (h) => String(h || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

// Sheet PICA pakai tanggal gaya "17/Mei/2024" (DD/SingkatanBulanIndo/YYYY) —
// format ini tidak dikenali parseTanggal() di weeklyReport.js (yang menangani
// "03 Agustus 2026" berspasi atau "15/09/2026" numerik). Ditangani di sini
// saja supaya parseTanggal bersama tidak perlu diubah / berisiko ke fitur lain.
const BULAN_ABBR_ID = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, agu: 8, ags: 8, sep: 9, okt: 10, nov: 11, des: 12,
};
function parseTanggalPica(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = parseTanggal(s);
  if (iso) return iso;
  const m = s.match(/^(\d{1,2})\/([A-Za-z]+)\/(\d{4})$/);
  if (m) {
    const bulan = BULAN_ABBR_ID[m[2].toLowerCase().slice(0, 3)];
    if (bulan) return `${m[3]}-${String(bulan).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** Untuk pesan error yang berguna kalau parsing gagal — tanpa ini, satu-satunya
 * petunjuk yang didapat admin cuma "Tidak ada baris terbaca", padahal sheet
 * PICA sering punya layout lebar/merge sel yang beda-beda per site. Preview
 * ini menunjukkan APA yang benar-benar terbaca dari CSV (indeks kolom + isi
 * sel yang tidak kosong) untuk 20 baris pertama, supaya bisa langsung
 * ketahuan dari pesan error di aplikasi — tanpa perlu bolak-balik menebak.
 */
function previewRows(rows, n = 20) {
  return rows.slice(0, n).map((r, i) => {
    const isi = r.map((c, ci) => (c && String(c).trim() ? `[${ci}]${String(c).trim().slice(0, 40)}` : null)).filter(Boolean);
    return isi.length ? `baris ${i + 1}: ${isi.join('  ')}` : `baris ${i + 1}: (kosong)`;
  }).join('\n');
}

/** Setelah kolom tanggal ditentukan dari LABEL header, dicek ulang terhadap
 * ISI baris data sungguhan — bukan cuma dipercaya dari posisi header.
 * Kenapa: pernah kejadian nyata di sheet PICA MS KHT, kolom "DATE" di baris
 * header ternyata TIDAK sejajar dengan nilai tanggal aslinya (nilai
 * tanggalnya konsisten muncul satu kolom lebih kiri di SEMUA baris data,
 * kemungkinan besar gara-gara sel gabung di baris judul yang menggeser
 * posisi kolom hanya di baris header, tidak di baris data). Dicoba 3
 * kandidat (posisi header apa adanya, satu kolom kiri, satu kolom kanan)
 * lalu dipilih yang paling banyak menghasilkan tanggal valid dari sampel
 * baris data — bukan menebak buta, divalidasi ke data sungguhan. */
function pilihKolomTanggal(rows, dataStartIdx, idxHeader, jumlahSampel = 15) {
  const skor = (idx) => {
    if (idx < 0 || idx >= (rows[dataStartIdx]?.length ?? 0)) return -1;
    let n = 0;
    for (let i = dataStartIdx; i < Math.min(rows.length, dataStartIdx + jumlahSampel); i++) {
      if (parseTanggalPica(rows[i]?.[idx])) n++;
    }
    return n;
  };
  const kandidat = [idxHeader, idxHeader - 1, idxHeader + 1];
  let terbaik = idxHeader, skorTerbaik = -1;
  for (const idx of kandidat) {
    const s = skor(idx);
    if (s > skorTerbaik) { skorTerbaik = s; terbaik = idx; }
  }
  return skorTerbaik > 0 ? terbaik : idxHeader;
}

/** CSV mentah tab PICA → daftar isu. Kolom dicari lewat header (bukan huruf
 * kolom tetap) supaya tahan kalau sheet ditambah/dikurangi kolom minggu. */
export function parsePicaCsv(csvText) {
  const rows = parseCsv(csvText);

  // Anchor dicari lewat PROBLEM + DESCRIPTION saja (bukan +NO seperti
  // sebelumnya). Kenapa: pernah kejadian nyata (sheet PICA MS KHT) label
  // "NO" ternyata sama sekali tidak ada di baris header hasil ekspor CSV
  // (gviz) — entah karena sel gabung di baris judul di atasnya menyerap
  // kolom itu, entah sebab lain di sheet aslinya. PROBLEM+DESCRIPTION jauh
  // lebih jarang hilang begini, jadi dipakai sebagai jangkar yang lebih
  // stabil; "NO" yang hilang ditolerir (lihat noIdx di bawah), bukan bikin
  // gagal total.
  const headIdx = rows.findIndex((r) => {
    const n = r.map(norm);
    return n.includes('problem') && n.includes('description');
  });
  if (headIdx < 0) {
    throw Object.assign(new Error(
      `Tidak menemukan baris header (kolom "PROBLEM"/"DESCRIPTION") di sheet ini. ` +
      `Isi yang benar-benar terbaca (20 baris pertama):\n${previewRows(rows)}`
    ), { status: 400 });
  }

  const headerRaw = rows[headIdx];
  const header = headerRaw.map(norm);
  const col = (label) => header.indexOf(label);

  let noIdx = col('no');
  const dateIdxHeader = col('date');
  const problemIdx = col('problem');
  const identIdx = col('identification');
  const descIdx = col('description');
  let targetIdx = header.findIndex((h) => h === 'target date');
  const picIdx = col('pic');
  const statusIdx = col('status');
  if (problemIdx < 0 || descIdx < 0) {
    throw Object.assign(new Error(
      `Baris header ditemukan di baris ${headIdx + 1}, tapi gagal memetakan kolom PROBLEM/DESCRIPTION. ` +
      `Isi baris header: ${headerRaw.map((c, ci) => `[${ci}]${c}`).filter((_, ci) => headerRaw[ci]).join('  ')}`
    ), { status: 400 });
  }
  if (targetIdx < 0) targetIdx = header.length; // sheet tanpa kolom Target Date

  const dataStartIdx = headIdx + 1;
  // Kolom DATE divalidasi ulang ke data sungguhan, bukan cuma dipercaya dari
  // posisi header — pernah kejadian nyata di sheet PICA MS KHT, nilai
  // tanggal aslinya konsisten muncul satu kolom lebih kiri dari label
  // header "DATE" di SEMUA baris data (kemungkinan besar gara-gara sel
  // gabung di baris judul yang menggeser posisi kolom hanya di baris
  // header, tidak di baris data). Dicoba posisi header apa adanya, satu
  // kolom kiri, satu kolom kanan — dipilih yang paling banyak menghasilkan
  // tanggal valid dari sampel baris data.
  const dateIdx = dateIdxHeader >= 0 ? pilihKolomTanggal(rows, dataStartIdx, dateIdxHeader) : -1;

  // Kolom antara DESCRIPTION dan TARGET DATE = kolom catatan mingguan
  // ("Week 34", "Week 35", ...), labelnya diambil dari baris header yang
  // sama (bukan baris di bawahnya — di sheet PICA nyata, label minggu
  // ternyata sebaris dengan PROBLEM/DESCRIPTION, bukan di baris terpisah).
  const weekCols = [];
  for (let c = descIdx + 1; c < targetIdx; c++) {
    if (c === dateIdx) continue; // jangan sampai kolom Date ikut kehitung minggu
    const label = String(headerRaw[c] || '').trim();
    if (label) weekCols.push({ c, label });
  }

  const out = [];
  let nomorUrut = 0;
  for (const r of rows.slice(dataStartIdx)) {
    nomorUrut++;
    const noVal = noIdx >= 0 ? String(r[noIdx] || '').trim() : '';
    const problemVal = String(r[problemIdx] || '').trim();
    if (!noVal && !problemVal) continue; // baris kosong

    const updates = weekCols
      .map(({ c, label }) => ({ week: label, catatan: String(r[c] || '').trim() }))
      .filter((u) => u.catatan);
    const latest = updates[updates.length - 1] || null;

    out.push({
      no: noVal || String(nomorUrut),
      tanggal: dateIdx >= 0 ? parseTanggalPica(r[dateIdx]) : null,
      problem: problemVal,
      identifikasi: String(r[identIdx] || '').trim(),
      deskripsi: String(r[descIdx] || '').trim(),
      targetDate: targetIdx < header.length ? parseTanggalPica(r[targetIdx]) : null,
      pic: String(r[picIdx] || '').trim(),
      status: String(r[statusIdx] || '').trim(),
      updates,
      latestWeek: latest ? latest.week : '',
      latestNote: latest ? latest.catatan : '',
    });
  }
  if (!out.length) {
    throw Object.assign(new Error(
      `Header PROBLEM/DESCRIPTION ditemukan di baris ${headIdx + 1} (kolom ${problemIdx}/${descIdx}), ` +
      `tapi tidak ada baris di bawahnya yang punya isi di kolom NO atau PROBLEM. ` +
      `Isi yang benar-benar terbaca mulai baris ${headIdx + 1} (20 baris):\n${previewRows(rows.slice(headIdx), 20)}`
    ), { status: 400 });
  }
  return out;
}

/** Kunci dedup. "NO" di sheet berfungsi sebagai ID isu, tapi digabung dengan
 * tanggal+problem untuk jaga-jaga kalau penomoran direset/diulang di sheet. */
const hashRow = (r) =>
  [r.no, r.tanggal, r.problem].join('|').toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

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
export const PicaItems = {
  async upsertMany(site, records, importedBy) {
    let inserted = 0, updated = 0;
    const hashesInBatch = [];
    for (const r of records) {
      const hash = hashRow(r);
      hashesInBatch.push(hash);
      const { rows } = await query(
        `INSERT INTO pica_items
           (id, site, row_hash, no, tanggal, problem, identifikasi, deskripsi,
            target_date, pic, status, updates, latest_week, latest_note, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (site, row_hash) DO UPDATE SET
           no=EXCLUDED.no, tanggal=EXCLUDED.tanggal, problem=EXCLUDED.problem,
           identifikasi=EXCLUDED.identifikasi, deskripsi=EXCLUDED.deskripsi,
           target_date=EXCLUDED.target_date, pic=EXCLUDED.pic, status=EXCLUDED.status,
           updates=EXCLUDED.updates, latest_week=EXCLUDED.latest_week,
           latest_note=EXCLUDED.latest_note, imported_at=NOW(), imported_by=EXCLUDED.imported_by
         RETURNING (xmax = 0) AS is_new`,
        [`pica-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, site, hash,
         r.no, r.tanggal, r.problem, r.identifikasi, r.deskripsi, r.targetDate, r.pic, r.status,
         JSON.stringify(r.updates), r.latestWeek, r.latestNote, importedBy]
      );
      rows[0].is_new ? inserted++ : updated++;
    }
    let removed = 0;
    if (hashesInBatch.length > 0) {
      const res = await query(
        `DELETE FROM pica_items WHERE site = $1 AND NOT (row_hash = ANY($2::text[]))`,
        [site, hashesInBatch]
      );
      removed = res.rowCount;
    }
    return { inserted, updated, removed, total: records.length };
  },

  async list(site) {
    const { rows } = await query(
      `SELECT * FROM pica_items WHERE site = $1 ORDER BY tanggal NULLS LAST, no`, [site]);
    return rows.map((r) => ({
      id: r.id, site: r.site, no: r.no, tanggal: r.tanggal, problem: r.problem,
      identifikasi: r.identifikasi, deskripsi: r.deskripsi, targetDate: r.target_date,
      pic: r.pic, status: r.status, updates: r.updates, latestWeek: r.latest_week,
      latestNote: r.latest_note, importedAt: r.imported_at, importedBy: r.imported_by,
    }));
  },

  async source(site) {
    const { rows } = await query('SELECT * FROM pica_sources WHERE site = $1', [site]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { site: r.site, sheetId: r.sheet_id, gid: r.gid, autoSync: r.auto_sync,
             lastSyncAt: r.last_sync_at, lastStatus: r.last_status };
  },

  async saveSource(site, sheetId, gid, autoSync) {
    await query(
      `INSERT INTO pica_sources (site, sheet_id, gid, auto_sync)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (site) DO UPDATE SET sheet_id=EXCLUDED.sheet_id, gid=EXCLUDED.gid, auto_sync=EXCLUDED.auto_sync`,
      [site, sheetId, gid, autoSync !== false]);
    return this.source(site);
  },

  async markSync(site, status) {
    await query('UPDATE pica_sources SET last_sync_at = NOW(), last_status = $2 WHERE site = $1', [site, status]);
  },
};

// ── Otorisasi: user hanya boleh menyentuh site-nya sendiri ────────────────
function siteGuard(req, site) {
  const mine = req.auth.assignedSite;
  if (req.auth.role === 'Super Admin' || mine === 'global' || !mine) return;
  if (site && site !== mine) {
    throw Object.assign(new Error(`Anda hanya bisa mengelola data Site ${String(mine).toUpperCase()}.`), { status: 403 });
  }
}

// ── Router ────────────────────────────────────────────────────────────────
export function picaRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.get('/pica', requireAuth, wrap(async (req, res) => {
    const site = req.query.site || (req.auth.assignedSite !== 'global' ? req.auth.assignedSite : null);
    if (!site) return res.status(400).json({ error: 'Parameter site wajib diisi.' });
    res.json(await PicaItems.list(site));
  }));

  r.get('/pica/source', requireAuth, wrap(async (req, res) => {
    const site = req.query.site || req.auth.assignedSite;
    res.json(await PicaItems.source(site));
  }));

  // Cukup paste link sheet (boleh langsung link ke tab tertentu, mis.
  // "...edit?gid=1610430714") — gid dibaca otomatis dari URL, admin tidak
  // perlu ketik ulang nama tab (beda dengan Sumber Sheet Laporan Mingguan).
  r.post('/pica/source', requireAuth, wrap(async (req, res) => {
    const { site, sheetUrl, autoSync } = req.body || {};
    siteGuard(req, site);
    const sheetId = extractSheetId(sheetUrl);
    if (!site || !sheetId) return res.status(400).json({ error: 'Site dan URL Google Spreadsheet wajib diisi.' });
    const gid = extractGid(sheetUrl);
    res.json(await PicaItems.saveSource(site, sheetId, gid, autoSync));
  }));

  r.post('/pica/sync', requireAuth, wrap(async (req, res) => {
    const site = req.body?.site || req.auth.assignedSite;
    siteGuard(req, site);
    const src = await PicaItems.source(site);
    if (!src) return res.status(400).json({ error: 'Sumber spreadsheet PICA untuk site ini belum diatur.' });

    try {
      const csv = await fetchCsvByGid(src.sheetId, src.gid);
      const records = parsePicaCsv(csv);
      const stat = await PicaItems.upsertMany(site, records, req.auth.email);
      await PicaItems.markSync(site, 'OK');
      res.json({ site, syncedAt: new Date().toISOString(), ...stat });
    } catch (err) {
      await PicaItems.markSync(site, err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  }));

  r.delete('/pica/:id', requireAuth, wrap(async (req, res) => {
    const { rowCount } = await query('DELETE FROM pica_items WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Baris tidak ditemukan.' });
    res.status(204).end();
  }));

  return r;
}

/** Auto-sync berkala untuk semua site yang mengaktifkannya — dipanggil dari
 * index.js bersamaan dengan startAutoSync() milik weeklyReport.js. */
export function startPicaAutoSync(intervalMs = 5 * 60 * 1000) {
  const tick = async () => {
    try {
      const { rows } = await query('SELECT site, sheet_id, gid FROM pica_sources WHERE auto_sync = TRUE');
      for (const s of rows) {
        try {
          const csv = await fetchCsvByGid(s.sheet_id, s.gid);
          const records = parsePicaCsv(csv);
          if (records.length) await PicaItems.upsertMany(s.site, records, 'auto-sync');
          await PicaItems.markSync(s.site, 'OK');
        } catch (err) {
          await PicaItems.markSync(s.site, err.message);
        }
      }
    } catch (err) {
      console.error('[pica] auto-sync gagal', err);
    }
  };
  tick();
  setInterval(tick, intervalMs);
}
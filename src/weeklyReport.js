// ── Weekly Report (Barang Masuk / Keluar per Site) ────────────────────────
// Satu modul mandiri: DDL + repo + router. Dipasang dari index.js dengan
// dua baris saja (lihat INTEGRASI.md).
//
// Sumber data: Google Spreadsheet per-site (tab "Report Weekly <SITE> RDA OUT",
// "... RDA IN", "... RCE IN", "... RCE OUT"). Sheet ditarik SERVER-SIDE sebagai
// CSV (gviz) sehingga tidak kena CORS dan bisa dijadwalkan otomatis.

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

// ── Schema ────────────────────────────────────────────────────────────────
export const WEEKLY_REPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS weekly_report_rows (
  id             TEXT PRIMARY KEY,
  site           TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('IN','OUT','ASET')),
  source_tab     TEXT NOT NULL,
  row_hash       TEXT NOT NULL,
  tanggal        DATE,
  minggu         INTEGER NOT NULL DEFAULT 0,
  bulan          INTEGER NOT NULL DEFAULT 0,
  tahun          INTEGER NOT NULL DEFAULT 0,
  kode           TEXT NOT NULL DEFAULT '',
  nama_barang    TEXT NOT NULL DEFAULT '',
  jumlah         NUMERIC NOT NULL DEFAULT 0,
  satuan         TEXT NOT NULL DEFAULT '',
  alokasi        TEXT NOT NULL DEFAULT 'OTHERS',
  detail_alokasi TEXT NOT NULL DEFAULT '',
  pic            TEXT NOT NULL DEFAULT '',
  rh             NUMERIC,
  harga          NUMERIC NOT NULL DEFAULT 0,
  total_harga    NUMERIC NOT NULL DEFAULT 0,
  no_mr          TEXT NOT NULL DEFAULT '',
  gen_bus        TEXT NOT NULL DEFAULT '',
  status_smr     TEXT NOT NULL DEFAULT '',
  no_shipment    TEXT NOT NULL DEFAULT '',
  keterangan     TEXT NOT NULL DEFAULT '',
  section        TEXT NOT NULL DEFAULT 'MAINT'
                   CHECK (section IN ('MAINT','OH','OLI','LAIN')),
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by    TEXT,
  UNIQUE (site, direction, row_hash)
);
CREATE INDEX IF NOT EXISTS idx_wrr_site_periode ON weekly_report_rows(site, tahun, bulan);
CREATE INDEX IF NOT EXISTS idx_wrr_minggu ON weekly_report_rows(site, minggu);

-- Konfigurasi sumber sheet per site (dipakai tombol Sync & auto-sync).
CREATE TABLE IF NOT EXISTS weekly_report_sources (
  site         TEXT PRIMARY KEY,
  sheet_id     TEXT NOT NULL,
  tabs         TEXT NOT NULL DEFAULT '',   -- dipisah '|'
  auto_sync    BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  last_status  TEXT NOT NULL DEFAULT ''
);

-- Target sales order (m3) per minggu, untuk baris Rp/m3 di laporan.
CREATE TABLE IF NOT EXISTS weekly_sales_volume (
  site   TEXT NOT NULL,
  tahun  INTEGER NOT NULL,
  minggu INTEGER NOT NULL,
  m3     NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (site, tahun, minggu)
);

-- Melebarkan CHECK constraint untuk DB yang sudah dibuat sebelum arah
-- 'ASET' (LIST ALL ASET) ditambahkan — CREATE TABLE IF NOT EXISTS di atas
-- tidak mengubah constraint pada tabel yang sudah ada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_report_rows_direction_check') THEN
    ALTER TABLE weekly_report_rows DROP CONSTRAINT weekly_report_rows_direction_check;
  END IF;
  ALTER TABLE weekly_report_rows ADD CONSTRAINT weekly_report_rows_direction_check
    CHECK (direction IN ('IN','OUT','ASET'));
END $$;

-- MS Wunut belum ada di seed awal (src/migrate.js hanya menanam bekasi,
-- indramayu, blora, setu). Ditanam di sini supaya laporan mingguan punya
-- site-nya tanpa perlu mengubah migrasi lama.
INSERT INTO sites (key, label, subtitle, color, image_url, is_default)
VALUES ('wunut', 'Wunut', 'Mother Station Wunut', '#38BDF8', '/assets/images/cng-cylinder.webp', FALSE)
ON CONFLICT (key) DO NOTHING;
`;

// ── Klasifikasi baris ke 4 seksi laporan ──────────────────────────────────
const ALOKASI_LAIN = [
  'jasa service & repair', 'jasa new instalasi', 'jasa kalibrasi',
  'sedot limbah b3', 'jasa analisa gas', 'jasa analisa oli', 'others', 'other',
];

export function classifySection(row) {
  const alokasi = String(row.alokasi || '').trim().toLowerCase();
  const nama = String(row.namaBarang || '').toLowerCase();
  const ket = `${row.detailAlokasi || ''} ${row.keterangan || ''}`.toLowerCase();

  // Urutan penting: baris berbasis jasa / OTHERS selalu masuk Lain-Lain,
  // meski keterangannya menyebut overhaul — sama seperti template Excel.
  if (ALOKASI_LAIN.includes(alokasi) || alokasi.startsWith('jasa')) return 'LAIN';
  if (/overhaul|overhold|\boh\b/.test(ket)) return 'OH';
  if (/\boli\b|pelumas|lubric/.test(nama)) return 'OLI';
  return 'MAINT';
}

// ── Parsing ───────────────────────────────────────────────────────────────
const BULAN_ID = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];

/** "03 Agustus 2026" | "2026-08-03" | "3/8/2026" → "YYYY-MM-DD" | null */
export function parseTanggal(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const bulan = BULAN_ID.indexOf(m[2].toLowerCase());
    if (bulan >= 0) return `${m[3]}-${String(bulan + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "Rp 3.039.780" | "3,039,780.50" | "23.383" | 3039780 → number
 *  Menebak pemisah desimal vs ribuan: pemisah yang muncul berulang, atau yang
 *  diikuti tepat 3 digit pada angka >3 digit, diperlakukan sebagai ribuan. */
export function parseAngka(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  let s = String(raw ?? '').replace(/[^0-9.,\-]/g, '').trim();
  if (!s) return 0;
  const negatif = s.startsWith('-');
  s = s.replace(/-/g, '');

  const nKoma = (s.match(/,/g) || []).length;
  const nTitik = (s.match(/\./g) || []).length;
  let hasil;

  if (nKoma && nTitik) {
    // Yang muncul terakhir adalah pemisah desimal.
    const desimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const ribuan = desimal === ',' ? '.' : ',';
    hasil = Number(s.split(ribuan).join('').replace(desimal, '.'));
  } else if (nKoma || nTitik) {
    const sep = nKoma ? ',' : '.';
    const bagian = s.split(sep);
    const ekor = bagian[bagian.length - 1];
    // Berulang, atau satu kali dengan ekor 3 digit → pemisah ribuan.
    const ribuan = bagian.length > 2 || (ekor.length === 3 && bagian[0].length <= 3 && s.replace(/\D/g, '').length > 3);
    hasil = ribuan ? Number(bagian.join('')) : Number(`${bagian.slice(0, -1).join('')}.${ekor}`);
  } else {
    hasil = Number(s);
  }

  if (!Number.isFinite(hasil)) return 0;
  return negatif ? -hasil : hasil;
}

const norm = (h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();

const HEADER_MAP = {
  'tanggal': 'tanggal', 'minggu': 'minggu', 'bulan': 'bulan', 'tahun': 'tahun',
  'kode': 'kode', 'no aset': 'kode', 'no. aset': 'kode', 'kode aset': 'kode', 'asset code': 'kode',
  'nama barang': 'namaBarang', 'nama aset': 'namaBarang', 'nama': 'namaBarang',
  'jumlah': 'jumlah', 'qty': 'jumlah', 'satuan': 'satuan',
  'alokasi': 'alokasi', 'kategori': 'alokasi', 'lokasi': 'alokasi', 'lokasi penempatan': 'alokasi',
  'detail alokasi': 'detailAlokasi', 'pic': 'pic', 'rh': 'rh',
  'harga': 'harga', 'total harga': 'totalHarga', 'nilai': 'totalHarga',
  'no mr': 'noMr', 'gen bus': 'genBus',
  'status s / mr': 'statusSmr', 'status s/mr': 'statusSmr', 'status': 'statusSmr', 'kondisi': 'statusSmr',
  'no shipment': 'noShipment', 'ket': 'keterangan', 'keterangan': 'keterangan',
};

/** CSV → array of record. Menangani kutip ganda dan newline di dalam sel. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Baris CSV mentah → record ternormalisasi. Header dicari otomatis. */
export function rowsToRecords(rows) {
  const headIdx = rows.findIndex((r) => r.some((c) => ['nama barang', 'nama aset'].includes(norm(c))));
  if (headIdx < 0) return [];
  const cols = rows[headIdx].map((c) => HEADER_MAP[norm(c)] || null);

  return rows.slice(headIdx + 1).map((r) => {
    const o = {};
    cols.forEach((key, i) => { if (key) o[key] = r[i] ?? ''; });
    if (!String(o.namaBarang || '').trim()) return null;

    const tanggal = parseTanggal(o.tanggal);
    const harga = parseAngka(o.harga);
    const jumlah = parseAngka(o.jumlah);
    const rec = {
      tanggal,
      minggu: Math.round(parseAngka(o.minggu)) || 0,
      bulan: Math.round(parseAngka(o.bulan)) || (tanggal ? Number(tanggal.slice(5, 7)) : 0),
      tahun: Math.round(parseAngka(o.tahun)) || (tanggal ? Number(tanggal.slice(0, 4)) : 0),
      kode: String(o.kode || '').trim(),
      namaBarang: String(o.namaBarang).trim(),
      jumlah,
      satuan: String(o.satuan || '').trim(),
      alokasi: String(o.alokasi || 'OTHERS').trim() || 'OTHERS',
      detailAlokasi: String(o.detailAlokasi || '').trim(),
      pic: String(o.pic || '').trim(),
      rh: o.rh ? parseAngka(o.rh) : null,
      harga,
      totalHarga: parseAngka(o.totalHarga) || harga * jumlah,
      noMr: String(o.noMr || '').trim(),
      genBus: String(o.genBus || '').trim(),
      statusSmr: String(o.statusSmr || '').trim(),
      noShipment: String(o.noShipment || '').trim(),
      keterangan: String(o.keterangan || '').trim(),
    };
    rec.section = classifySection(rec);
    return rec;
  }).filter(Boolean);
}

/** Kunci dedup — import ulang sheet yang sama tidak menggandakan baris. */
const hashRow = (r) =>
  [r.tanggal, r.kode, r.namaBarang, r.jumlah, r.alokasi, r.noMr, r.totalHarga]
    .join('|').toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

// ── Ambil sheet dari Google (server-side, tanpa CORS) ─────────────────────
export function extractSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null);
}

async function fetchTabCsv(sheetId, tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`Gagal membaca tab "${tabName}" (HTTP ${res.status}). Pastikan sheet dibagikan sebagai "Anyone with the link — Viewer".`), { status: 400 });
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw Object.assign(new Error(`Tab "${tabName}" tidak bisa diakses publik. Ubah izin berbagi sheet menjadi "Anyone with the link".`), { status: 400 });
  return text;
}

const directionOf = (tab) => {
  if (/aset/i.test(tab)) return 'ASET';
  return /\bin\b/i.test(tab) ? 'IN' : 'OUT';
};

// ── Repo ──────────────────────────────────────────────────────────────────
export const WeeklyReports = {
  async upsertMany(site, tab, records, importedBy) {
    const direction = directionOf(tab);
    let inserted = 0, updated = 0;
    for (const r of records) {
      const hash = hashRow(r);
      const { rows } = await query(
        `INSERT INTO weekly_report_rows
           (id, site, direction, source_tab, row_hash, tanggal, minggu, bulan, tahun, kode,
            nama_barang, jumlah, satuan, alokasi, detail_alokasi, pic, rh, harga, total_harga,
            no_mr, gen_bus, status_smr, no_shipment, keterangan, section, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (site, direction, row_hash) DO UPDATE SET
           source_tab=EXCLUDED.source_tab, minggu=EXCLUDED.minggu, bulan=EXCLUDED.bulan,
           tahun=EXCLUDED.tahun, jumlah=EXCLUDED.jumlah, harga=EXCLUDED.harga,
           total_harga=EXCLUDED.total_harga, status_smr=EXCLUDED.status_smr,
           no_shipment=EXCLUDED.no_shipment, keterangan=EXCLUDED.keterangan,
           section=EXCLUDED.section, imported_at=NOW(), imported_by=EXCLUDED.imported_by
         RETURNING (xmax = 0) AS is_new`,
        [`wr-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, site, direction, tab, hash,
         r.tanggal, r.minggu, r.bulan, r.tahun, r.kode, r.namaBarang, r.jumlah, r.satuan, r.alokasi,
         r.detailAlokasi, r.pic, r.rh, r.harga, r.totalHarga, r.noMr, r.genBus, r.statusSmr,
         r.noShipment, r.keterangan, r.section, importedBy]
      );
      rows[0].is_new ? inserted++ : updated++;
    }
    return { inserted, updated, total: records.length };
  },

  async list({ site, tahun, bulan, direction }) {
    const where = ['1=1'], params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
    if (site && site !== 'global') add('site = ?', site);
    if (tahun) add('tahun = ?', Number(tahun));
    if (bulan) add('bulan = ?', Number(bulan));
    if (direction) add('direction = ?', direction);
    const { rows } = await query(
      `SELECT * FROM weekly_report_rows WHERE ${where.join(' AND ')}
        ORDER BY tahun, bulan, minggu, tanggal NULLS LAST, nama_barang`, params);
    return rows.map((r) => ({
      id: r.id, site: r.site, direction: r.direction, sourceTab: r.source_tab,
      tanggal: r.tanggal ? new Date(r.tanggal).toISOString().slice(0, 10) : null,
      minggu: r.minggu, bulan: r.bulan, tahun: r.tahun, kode: r.kode,
      namaBarang: r.nama_barang, jumlah: Number(r.jumlah), satuan: r.satuan,
      alokasi: r.alokasi, detailAlokasi: r.detail_alokasi, pic: r.pic,
      rh: r.rh === null ? null : Number(r.rh), harga: Number(r.harga),
      totalHarga: Number(r.total_harga), noMr: r.no_mr, genBus: r.gen_bus,
      statusSmr: r.status_smr, noShipment: r.no_shipment, keterangan: r.keterangan,
      section: r.section, importedAt: r.imported_at, importedBy: r.imported_by,
    }));
  },

  async source(site) {
    const { rows } = await query('SELECT * FROM weekly_report_sources WHERE site = $1', [site]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { site: r.site, sheetId: r.sheet_id, tabs: r.tabs ? r.tabs.split('|') : [],
             autoSync: r.auto_sync, lastSyncAt: r.last_sync_at, lastStatus: r.last_status };
  },

  async saveSource(site, sheetId, tabs, autoSync) {
    await query(
      `INSERT INTO weekly_report_sources (site, sheet_id, tabs, auto_sync)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (site) DO UPDATE SET sheet_id=EXCLUDED.sheet_id, tabs=EXCLUDED.tabs, auto_sync=EXCLUDED.auto_sync`,
      [site, sheetId, tabs.join('|'), autoSync !== false]);
    return this.source(site);
  },

  async markSync(site, status) {
    await query('UPDATE weekly_report_sources SET last_sync_at = NOW(), last_status = $2 WHERE site = $1', [site, status]);
  },

  async volumes(site, tahun) {
    const { rows } = await query(
      'SELECT minggu, m3 FROM weekly_sales_volume WHERE site = $1 AND tahun = $2 ORDER BY minggu', [site, Number(tahun)]);
    return rows.map((r) => ({ minggu: r.minggu, m3: Number(r.m3) }));
  },

  async setVolume(site, tahun, minggu, m3) {
    await query(
      `INSERT INTO weekly_sales_volume (site, tahun, minggu, m3) VALUES ($1,$2,$3,$4)
       ON CONFLICT (site, tahun, minggu) DO UPDATE SET m3 = EXCLUDED.m3`,
      [site, Number(tahun), Number(minggu), Number(m3) || 0]);
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
export function weeklyReportRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Data mentah (frontend yang memvotasi jadi tabel laporan).
  r.get('/weekly-reports', requireAuth, wrap(async (req, res) => {
    const site = req.query.site || (req.auth.assignedSite !== 'global' ? req.auth.assignedSite : null);
    res.json(await WeeklyReports.list({ site, tahun: req.query.tahun, bulan: req.query.bulan, direction: req.query.direction }));
  }));

  // Konfigurasi sumber sheet per site.
  r.get('/weekly-reports/source', requireAuth, wrap(async (req, res) => {
    const site = req.query.site || req.auth.assignedSite;
    res.json(await WeeklyReports.source(site));
  }));

  r.post('/weekly-reports/source', requireAuth, wrap(async (req, res) => {
    const { site, sheetUrl, tabs, autoSync } = req.body || {};
    siteGuard(req, site);
    const sheetId = extractSheetId(sheetUrl);
    if (!site || !sheetId) return res.status(400).json({ error: 'Site dan URL Google Spreadsheet wajib diisi.' });
    if (!Array.isArray(tabs) || !tabs.length) return res.status(400).json({ error: 'Minimal satu nama tab wajib diisi.' });
    res.json(await WeeklyReports.saveSource(site, sheetId, tabs, autoSync));
  }));

  // Tarik ulang dari Google Sheet. Dipanggil manual maupun oleh auto-sync.
  r.post('/weekly-reports/sync', requireAuth, wrap(async (req, res) => {
    const site = req.body?.site || req.auth.assignedSite;
    siteGuard(req, site);
    const src = await WeeklyReports.source(site);
    if (!src) return res.status(400).json({ error: 'Sumber spreadsheet untuk site ini belum diatur.' });

    const hasil = [];
    for (const tab of src.tabs) {
      try {
        const csv = await fetchTabCsv(src.sheetId, tab);
        const records = rowsToRecords(parseCsv(csv));
        const stat = await WeeklyReports.upsertMany(site, tab, records, req.auth.email);
        hasil.push({ tab, ...stat });
      } catch (err) {
        hasil.push({ tab, error: err.message });
      }
    }
    const gagal = hasil.filter((h) => h.error).length;
    await WeeklyReports.markSync(site, gagal ? `${gagal} tab gagal` : 'OK');
    res.json({ site, syncedAt: new Date().toISOString(), hasil });
  }));

  // Import manual: frontend mengirim CSV hasil upload .xlsx/.csv.
  r.post('/weekly-reports/import', requireAuth, wrap(async (req, res) => {
    const { site, tab, csv } = req.body || {};
    siteGuard(req, site);
    if (!site || !csv) return res.status(400).json({ error: 'Site dan isi file wajib diisi.' });
    const records = rowsToRecords(parseCsv(csv));
    if (!records.length) return res.status(400).json({ error: 'Tidak ada baris valid — pastikan ada kolom "Nama Barang".' });
    res.json(await WeeklyReports.upsertMany(site, tab || 'UPLOAD', records, req.auth.email));
  }));

  // Volume sales order (m3) per minggu, untuk baris Rp/m3.
  r.get('/weekly-reports/volume', requireAuth, wrap(async (req, res) => {
    res.json(await WeeklyReports.volumes(req.query.site || req.auth.assignedSite, req.query.tahun || new Date().getFullYear()));
  }));

  r.post('/weekly-reports/volume', requireAuth, wrap(async (req, res) => {
    const { site, tahun, minggu, m3 } = req.body || {};
    siteGuard(req, site);
    await WeeklyReports.setVolume(site, tahun, minggu, m3);
    res.status(204).end();
  }));

  r.delete('/weekly-reports/:id', requireAuth, wrap(async (req, res) => {
    const { rowCount } = await query('DELETE FROM weekly_report_rows WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Baris tidak ditemukan.' });
    res.status(204).end();
  }));

  return r;
}

/** Auto-sync berkala untuk semua site yang mengaktifkannya. */
export function startAutoSync(intervalMs = 5 * 60 * 1000) {
  const tick = async () => {
    try {
      const { rows } = await query('SELECT site, sheet_id, tabs FROM weekly_report_sources WHERE auto_sync = TRUE');
      for (const s of rows) {
        for (const tab of (s.tabs || '').split('|').filter(Boolean)) {
          try {
            const records = rowsToRecords(parseCsv(await fetchTabCsv(s.sheet_id, tab)));
            await WeeklyReports.upsertMany(s.site, tab, records, 'auto-sync');
          } catch (err) { console.warn(`[weekly-sync] ${s.site}/${tab}:`, err.message); }
        }
        await WeeklyReports.markSync(s.site, 'OK (auto)');
      }
    } catch (err) { console.error('[weekly-sync]', err.message); }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, intervalMs);
}
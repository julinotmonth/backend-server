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
  jenis          TEXT NOT NULL DEFAULT '',
  merk           TEXT NOT NULL DEFAULT '',
  tipe           TEXT NOT NULL DEFAULT '',
  section        TEXT NOT NULL DEFAULT 'MAINT'
                   CHECK (section IN ('MAINT','OH','OLI','LAIN')),
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by    TEXT,
  UNIQUE (site, direction, row_hash)
);
CREATE INDEX IF NOT EXISTS idx_wrr_site_periode ON weekly_report_rows(site, tahun, bulan);
CREATE INDEX IF NOT EXISTS idx_wrr_minggu ON weekly_report_rows(site, minggu);

-- Kolom Jenis/Merk/Tipe ditambahkan belakangan (sheet "LIST ALL ASET ...") —
-- ALTER di sini supaya DB yang sudah ada sebelum kolom ini ada ikut terupdate
-- (CREATE TABLE IF NOT EXISTS di atas tidak mengubah tabel yang sudah dibuat).
ALTER TABLE weekly_report_rows ADD COLUMN IF NOT EXISTS jenis TEXT NOT NULL DEFAULT '';
ALTER TABLE weekly_report_rows ADD COLUMN IF NOT EXISTS merk  TEXT NOT NULL DEFAULT '';
ALTER TABLE weekly_report_rows ADD COLUMN IF NOT EXISTS tipe  TEXT NOT NULL DEFAULT '';

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

-- MS KHT juga belum ada di seed manapun sebelumnya.
INSERT INTO sites (key, label, subtitle, color, image_url, is_default)
VALUES ('kht', 'KHT', 'Mother Station KHT', '#FB923C', '/assets/images/cng-cylinder.webp', FALSE)
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
/** @param {string} raw @param {string|number} [bulanHint] kolom "Bulan" eksplisit di baris yang sama (kalau ada), dipakai buat membongkar tanggal ambigu "A/B/YYYY" */
export function parseTanggal(raw, bulanHint) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const bulan = BULAN_ID.indexOf(m[2].toLowerCase());
    if (bulan >= 0) return `${m[3]}-${String(bulan + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // Format bergaris miring "A/B/YYYY" itu ambigu — bisa D/M/Y (mis. sheet MS
  // KHT: "04/09/2026" = 4 September) atau M/D/Y (mis. sheet MS Blora yang
  // diekspor dari Sheets ber-locale AS: "9/16/2026" = 16 September, bukan
  // bulan 16). Kalau salah satu komponen > 12, itu jelas hari, jadi tak
  // perlu ditebak. Kalau dua-duanya ≤ 12 (mis. "04/09/2026" bisa jadi 4
  // September ATAU April 9), jangan menebak buta — kolom "Bulan" di baris
  // yang sama SELALU ada di tab weekly IN/OUT dan jadi sumber kebenaran;
  // baru kalau itu pun tak membantu (kosong, atau tak cocok keduanya),
  // jatuh ke asumsi D/M/Y karena itu konvensi Indonesia yang lazim dipakai
  // saat orang mengetik tanggal manual di sheet ini.
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const tahun = m[3];
    let hari, bulan;
    if (a > 12 && b <= 12) { hari = a; bulan = b; }
    else if (b > 12 && a <= 12) { bulan = a; hari = b; }
    else {
      const hint = Number(bulanHint);
      if (hint >= 1 && hint <= 12 && hint === b && hint !== a) { bulan = b; hari = a; }
      else { bulan = a; hari = b; } // default: D/M/Y
    }
    return `${tahun}-${String(bulan).padStart(2, '0')}-${String(hari).padStart(2, '0')}`;
  }
  // Sel bertipe Tanggal asli (bukan teks) di Google Sheets sering diekspor CSV
  // pakai format singkat tahun 2 digit ("17/09/26") — tanpa ini kena strip
  // parseAngka() dan jadi angka sampah ("170926").
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
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

// Titik dibuang sebelum dibandingkan supaya "No. MR", "Ket WR.", "No. PO" dst.
// (format kolom di tab RDA IN) cocok dengan entri HEADER_MAP di bawah, yang
// sebelumnya ditulis tanpa titik — sebelumnya kolom-kolom ini gagal ke-map
// sama sekali sehingga Supplier/No.MR/Ket WR./No.WR pada tab RDA IN tidak
// pernah tersimpan.
const norm = (h) => String(h || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

const HEADER_MAP = {
  'tanggal': 'tanggal', 'minggu': 'minggu', 'bulan': 'bulan', 'tahun': 'tahun',
  'kode': 'kode', 'no aset': 'kode', 'kode aset': 'kode', 'kode asset': 'kode', 'asset code': 'kode',
  'nama barang': 'namaBarang', 'nama aset': 'namaBarang', 'nama item': 'namaBarang', 'nama': 'namaBarang',
  'jumlah': 'jumlah', 'qty': 'jumlah', 'satuan': 'satuan',
  'alokasi': 'alokasi', 'kategori': 'alokasi', 'lokasi': 'alokasi', 'lokasi penempatan': 'alokasi',
  // Tab "... RDA IN" tidak punya kolom Alokasi — kolom Supplier adalah padanan
  // terdekatnya (siapa/dari mana barang masuk), jadi dipetakan ke field yang
  // sama supaya kolom ALOKASI di halaman "Barang Masuk" tidak selalu "OTHERS".
  'supplier': 'alokasi',
  'detail alokasi': 'detailAlokasi', 'pic': 'pic', 'rh': 'rh',
  'harga': 'harga', 'total harga': 'totalHarga', 'nilai': 'totalHarga',
  'no mr': 'noMr', 'gen bus': 'genBus',
  'status s / mr': 'statusSmr', 'status s/mr': 'statusSmr', 'status': 'statusSmr', 'kondisi': 'statusSmr',
  'status approval': 'statusSmr',
  'no shipment': 'noShipment', 'no wr': 'noShipment', 'no ws': 'noShipment',
  'ket': 'keterangan', 'keterangan': 'keterangan', 'ket wr': 'keterangan', 'remark': 'keterangan',
  // Kolom khusus tab "LIST ALL ASET ..." — tidak dipakai tab weekly IN/OUT.
  'jenis': 'jenis', 'merk': 'merk', 'type': 'tipe', 'tipe': 'tipe',
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
  const headIdx = rows.findIndex((r) => r.some((c) => ['nama barang', 'nama aset', 'nama item'].includes(norm(c))));
  if (headIdx < 0) return [];
  const cols = rows[headIdx].map((c) => HEADER_MAP[norm(c)] || null);

  // Sheet "LIST ALL ASET ..." punya baris judul sub-bab di antara item
  // (mis. "Main Office", "MS WUNUT") — sel-sel lain di baris itu kosong
  // karena merge cell. Baris seperti ini tidak dibuang, tapi dijadikan
  // "sub-bab berjalan" yang ditempel ke item-item di bawahnya lewat
  // detailAlokasi, supaya tampilannya bisa dikelompokkan sama seperti sheet.
  let subBabBerjalan = '';
  const out = [];

  for (const r of rows.slice(headIdx + 1)) {
    const o = {};
    cols.forEach((key, i) => { if (key) o[key] = r[i] ?? ''; });

    const namaBarangTrim = String(o.namaBarang || '').trim();
    if (!namaBarangTrim) {
      // Baris judul sub-bab (mis. "Main Office") berasal dari sel gabungan di
      // Google Sheets — sel lain di baris itu kosong karena merge, jadi cuma
      // ada SATU nilai unik yang terisi di seluruh baris.
      const isiBaris = r.map((c) => String(c || '').trim()).filter(Boolean);
      const unik = [...new Set(isiBaris)];
      if (unik.length === 1 && !/^\d+$/.test(unik[0])) subBabBerjalan = unik[0];
      continue;
    }

    const tanggalDariTahun = parseTanggal(o.tahun);
    // Kolom "Tahun" di tab "LIST ALL ASET ..." sebenarnya berisi tanggal
    // perolehan penuh (mis. "4 Maret 2026"), bukan angka tahun murni seperti
    // di tab weekly IN/OUT. parseAngka() dulu memotong itu jadi angka acak
    // ("4 Maret 2026" -> 42026). Kalau isinya berhasil dibaca sebagai tanggal,
    // pakai itu; kalau tidak, baru dianggap angka tahun biasa.
    const tanggal = parseTanggal(o.tanggal, o.bulan) || tanggalDariTahun;
    const harga = parseAngka(o.harga);
    const jumlah = parseAngka(o.jumlah);
    const rec = {
      tanggal,
      minggu: Math.round(parseAngka(o.minggu)) || 0,
      bulan: Math.round(parseAngka(o.bulan)) || (tanggal ? Number(tanggal.slice(5, 7)) : 0),
      tahun: tanggalDariTahun
        ? Number(tanggalDariTahun.slice(0, 4))
        : Math.round(parseAngka(o.tahun)) || (tanggal ? Number(tanggal.slice(0, 4)) : 0),
      kode: String(o.kode || '').trim(),
      namaBarang: namaBarangTrim,
      jumlah,
      satuan: String(o.satuan || '').trim(),
      alokasi: String(o.alokasi || 'OTHERS').trim() || 'OTHERS',
      detailAlokasi: String(o.detailAlokasi || '').trim() || subBabBerjalan,
      pic: String(o.pic || '').trim(),
      rh: o.rh ? parseAngka(o.rh) : null,
      harga,
      totalHarga: parseAngka(o.totalHarga) || harga * jumlah,
      noMr: String(o.noMr || '').trim(),
      genBus: String(o.genBus || '').trim(),
      statusSmr: String(o.statusSmr || '').trim(),
      noShipment: String(o.noShipment || '').trim(),
      keterangan: String(o.keterangan || '').trim(),
      jenis: String(o.jenis || '').trim(),
      merk: String(o.merk || '').trim(),
      tipe: String(o.tipe || '').trim(),
    };
    rec.section = classifySection(rec);
    out.push(rec);
  }
  return out;
}

/** Kunci dedup — import ulang sheet yang sama tidak menggandakan baris. */
const hashRow = (r) =>
  [r.tanggal, r.kode, r.namaBarang, r.jumlah, r.alokasi, r.noMr, r.totalHarga]
    .join('|').toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

// Menyamakan gaya penulisan ukuran inci yang sering beda antar-sheet, mis.
// `8,7"` di sheet aset vs `8,7 Inci` di catatan pembelian — tanpa ini,
// pencocokan by-name gagal walau barangnya persis sama.
const normNama = (s) => String(s || '').toLowerCase().replace(/"/g, 'inci').replace(/[^a-z0-9]/g, '');

// Kode aset ("02.01-2026-0045") kadang tampil beda gaya tanda hubung antar
// sheet (strip biasa vs en dash "–" hasil auto-format Sheets/Excel) walau
// nilainya sama — semua tanda baca dibuang supaya perbandingan tidak meleset
// gara-gara itu.
const normKode = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Fallback saat nama di dua sheet beda jauh redaksinya (mis. tambahan kode
// SKU/reseller di ujung nama) tapi jelas barang yang sama — dicocokkan lewat
// kemiripan kumpulan kata (Jaccard), bukan string persis.
const tokenSet = (s) => new Set(String(s || '').toLowerCase().replace(/"/g, ' inci ').match(/[a-z0-9]+/g) || []);
const angkaMurni = (set) => new Set([...set].filter((t) => /^\d+$/.test(t)));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  // Angka murni (ukuran, kapasitas, model) adalah pembeda paling penting —
  // "32 Inchi" vs "65 Inchi" kata-katanya mirip tapi jelas barang beda.
  // Kalau kedua nama sama-sama punya angka murni tapi TIDAK ADA yang sama
  // sekali, tolak langsung berapa pun tingginya kemiripan kata lain.
  const angkaA = angkaMurni(a), angkaB = angkaMurni(b);
  if (angkaA.size && angkaB.size && ![...angkaA].some((n) => angkaB.has(n))) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};
const AMBANG_FUZZY = 0.5; // di bawah ini dianggap barang beda, tidak dipasangkan

/**
 * Sheet "LIST ALL ASET ..." tidak punya kolom harga sama sekali. Sebagai
 * pendekatan terbaik yang bisa diambil, cocokkan tiap aset ke catatan
 * pembelian di tab "... IN" (RDA/RCE) — DIUTAMAKAN lewat Kode (Kode Aset),
 * karena kode itu unik per unit fisik dan tidak kena masalah penulisan nama
 * yang beda-beda (mis. dua "Printer Epson L3210 with Wifi" identik tapi kode
 * asetnya beda, 0045 vs 0057 — kalau dicocokkan lewat nama, salah satu bisa
 * "kehabisan" kandidat karena kandidatnya sudah kepakai unit lain). Kalau
 * kode tidak ada/tidak ketemu, baru jatuh ke pencocokan by-name+tanggal
 * seperti sebelumnya. Setiap baris pembelian cuma boleh dipasangkan ke SATU
 * aset (sekali pakai). Hasilnya SELALU ditandai sebagai estimasi
 * (hargaEstimasi), tidak pernah menimpa kolom totalHarga yang memang kosong
 * untuk baris ASET.
 *
 * Tiga tahap terpisah, BUKAN diselang-seling per aset:
 *  0) Exact-match Kode Aset — paling presisi, jadi diproses lebih dulu dan
 *     kandidatnya "diamankan" sebelum tahap nama sempat mengambilnya.
 *  1) Exact-match nama ternormalisasi, untuk aset yang kodenya tidak
 *     ketemu/tidak ada, dari sisa katalog pembelian yang belum kepakai.
 *  2) Fuzzy-match (kemiripan kata), untuk sisa aset yang masih tersisa.
 * Kalau digabung dalam satu putaran, aset yang diproses lebih dulu bisa
 * "mencuri" via fuzzy kandidat pembelian yang sebetulnya exact-match milik
 * aset lain yang belum diproses — itu pernah kejadian waktu diuji.
 */
async function attachEstimasiHarga(rowsHasil) {
  const asetRows = rowsHasil.filter((r) => r.direction === 'ASET');
  if (!asetRows.length) return;
  const sites = [...new Set(asetRows.map((r) => r.site))];
  const { rows: pembelian } = await query(
    `SELECT site, tanggal, kode, nama_barang, total_harga FROM weekly_report_rows
      WHERE direction = 'IN' AND site = ANY($1::text[]) AND total_harga > 0`,
    [sites]
  );
  const poolNama = {};
  const poolKode = {};
  const semuaPembelian = [];
  for (const p of pembelian) {
    const k = {
      site: p.site, kode: p.kode, namaBarang: p.nama_barang,
      tanggal: p.tanggal ? new Date(p.tanggal).getTime() : null,
      harga: Number(p.total_harga),
      used: false,
    };
    (poolNama[`${p.site}|${normNama(p.nama_barang)}`] ||= []).push(k);
    if (p.kode && normKode(p.kode)) (poolKode[`${p.site}|${normKode(p.kode)}`] ||= []).push(k);
    semuaPembelian.push(k);
  }
  // Urut berdasarkan tanggal supaya assignment deterministik & tidak
  // tergantung urutan hasil query.
  const asetUrut = [...asetRows].sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')));

  // Tahap 0: exact-match Kode Aset — jalan duluan, prioritas tertinggi.
  const belumKodeOrTanpaKode = [];
  for (const a of asetUrut) {
    const kodeA = normKode(a.kode);
    const kandidatKode = kodeA ? poolKode[`${a.site}|${kodeA}`] : null;
    if (!kandidatKode || !kandidatKode.length) { belumKodeOrTanpaKode.push(a); continue; }
    const tglAset = a.tanggal ? new Date(a.tanggal).getTime() : null;
    let terbaik = null, jarakTerbaik = Infinity;
    for (const k of kandidatKode) {
      if (k.used) continue;
      const jarak = (tglAset != null && k.tanggal != null) ? Math.abs(tglAset - k.tanggal) : Number.MAX_SAFE_INTEGER;
      if (jarak < jarakTerbaik) { jarakTerbaik = jarak; terbaik = k; }
    }
    if (terbaik) { terbaik.used = true; a.hargaEstimasi = terbaik.harga; }
    else belumKodeOrTanpaKode.push(a); // kode cocok tapi kandidatnya sudah kepakai unit lain
  }

  // Tahap 1: exact-match nama, hanya untuk aset yang belum dapat dari kode.
  const belumKetemu = [];
  for (const a of belumKodeOrTanpaKode) {
    const kandidat = poolNama[`${a.site}|${normNama(a.namaBarang)}`];
    if (!kandidat || !kandidat.length) { belumKetemu.push(a); continue; }
    const tglAset = a.tanggal ? new Date(a.tanggal).getTime() : null;
    let terbaik = null, jarakTerbaik = Infinity;
    for (const k of kandidat) {
      if (k.used) continue;
      const jarak = (tglAset != null && k.tanggal != null) ? Math.abs(tglAset - k.tanggal) : Number.MAX_SAFE_INTEGER;
      if (jarak < jarakTerbaik) { jarakTerbaik = jarak; terbaik = k; }
    }
    if (terbaik) { terbaik.used = true; a.hargaEstimasi = terbaik.harga; }
    else belumKetemu.push(a); // nama cocok tapi semua kandidatnya sudah kepakai aset lain
  }

  // Tahap 2: fuzzy-match, hanya untuk sisa aset yang tidak dapat exact-match,
  // hanya dari sisa pembelian yang masih belum kepakai.
  for (const a of belumKetemu) {
    const tokenAset = tokenSet(a.namaBarang);
    let terbaikFuzzy = null, skorTerbaik = AMBANG_FUZZY;
    for (const k of semuaPembelian) {
      if (k.used || k.site !== a.site) continue;
      const skor = jaccard(tokenAset, tokenSet(k.namaBarang));
      if (skor > skorTerbaik) { skorTerbaik = skor; terbaikFuzzy = k; }
    }
    if (terbaikFuzzy) { terbaikFuzzy.used = true; a.hargaEstimasi = terbaikFuzzy.harga; }
  }
}

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
  // Beberapa site pakai penamaan Bahasa Indonesia ("Barang Masuk - RDA SETU"
  // / "Barang Keluar - RDA SETU") alih-alih pola "... RDA IN"/"... RDA OUT"
  // ala MS Wunut. Kata Indonesia dicek lebih dulu karena lebih spesifik;
  // "Masuk"/"Keluar" tidak pernah mengandung kata "in" secara kebetulan,
  // jadi urutan pengecekan ini aman untuk kedua pola.
  if (/\bmasuk\b/i.test(tab)) return 'IN';
  if (/\bkeluar\b/i.test(tab)) return 'OUT';
  return /\bin\b/i.test(tab) ? 'IN' : 'OUT';
};

// ── Pengaman: pastikan isi CSV yang diambil benar-benar tab yang dimaksud ──
// Kasus nyata yang memicu ini: nama tab di Google Sheets punya spasi ganda
// ("Report Weekly  MS Wunut RDA IN") sementara nama yang disimpan di
// weekly_report_sources cuma satu spasi. Google gviz gagal cocokkan nama
// persis itu dan diam-diam balikin isi sheet PERTAMA di file (RDA OUT) tanpa
// error — akibatnya halaman "Barang Masuk" (IN) menampilkan data RDA OUT.
// Kolom di bawah cuma ada di salah satu dari dua tab, jadi dipakai buat
// mendeteksi isi CSV sebenarnya datang dari arah mana.
const HEADER_HINTS = {
  IN: ['supplier', 'no po', 'no pr'],          // cuma ada di tab "... RDA IN"
  OUT: ['alokasi', 'pic', 'no shipment'],      // cuma ada di tab "... RDA OUT"
};

function detectDirectionFromHeaders(headerRow) {
  const normed = (headerRow || []).map(norm);
  const hasIn = HEADER_HINTS.IN.some((h) => normed.includes(h));
  const hasOut = HEADER_HINTS.OUT.some((h) => normed.includes(h));
  if (hasIn && !hasOut) return 'IN';
  if (hasOut && !hasIn) return 'OUT';
  return null; // ambigu (mis. tab "LIST ALL ASET ...") — tidak divalidasi
}

/** Lempar error kalau isi CSV ternyata bukan arah yang diharapkan dari nama tab. */
function assertDirectionMatches(tab, rows) {
  const expected = directionOf(tab);
  if (expected === 'ASET') return; // sheet aset tidak punya pola IN/OUT
  const headIdx = rows.findIndex((r) => r.some((c) => ['nama barang', 'nama aset', 'nama item'].includes(norm(c))));
  if (headIdx < 0) return; // biar rowsToRecords yang menangani (hasilnya kosong)
  const actual = detectDirectionFromHeaders(rows[headIdx]);
  if (actual && actual !== expected) {
    throw Object.assign(new Error(
      `Tab "${tab}" dikonfigurasi sebagai arah ${expected}, tapi kolom yang terbaca cocok dengan tab ${actual} `
      + `(kemungkinan nama tab di pengaturan sumber tidak persis sama dengan nama tab asli di Google Sheets — `
      + `cek spasi/ejaan, lalu salin-tempel ulang nama tabnya). Sinkronisasi dibatalkan untuk mencegah data tersimpan di arah yang salah.`
    ), { status: 400 });
  }
}

// ── Repo ──────────────────────────────────────────────────────────────────
export const WeeklyReports = {
  async upsertMany(site, tab, records, importedBy) {
    const direction = directionOf(tab);
    let inserted = 0, updated = 0;
    const hashesInBatch = [];
    for (const r of records) {
      const hash = hashRow(r);
      hashesInBatch.push(hash);
      const { rows } = await query(
        `INSERT INTO weekly_report_rows
           (id, site, direction, source_tab, row_hash, tanggal, minggu, bulan, tahun, kode,
            nama_barang, jumlah, satuan, alokasi, detail_alokasi, pic, rh, harga, total_harga,
            no_mr, gen_bus, status_smr, no_shipment, keterangan, jenis, merk, tipe, section, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         ON CONFLICT (site, direction, row_hash) DO UPDATE SET
           -- Refresh SEMUA kolom yang bisa berubah antar-sync, bukan sebagian.
           -- Sebelumnya cuma sebagian kolom (mis. jenis/merk/tipe) yang
           -- disebut di sini, jadi kolom lain (detail_alokasi/pic/rh/dll)
           -- macet selamanya di nilai hasil sync PERTAMA — walau hasil parsing
           -- di sync berikutnya sudah benar, karena baris yang row_hash-nya
           -- sama kena UPDATE, bukan INSERT baru, dan kolom yg tidak disebut
           -- di sini tidak pernah tersentuh lagi.
           source_tab=EXCLUDED.source_tab, tanggal=EXCLUDED.tanggal,
           minggu=EXCLUDED.minggu, bulan=EXCLUDED.bulan, tahun=EXCLUDED.tahun,
           kode=EXCLUDED.kode, nama_barang=EXCLUDED.nama_barang,
           jumlah=EXCLUDED.jumlah, satuan=EXCLUDED.satuan, alokasi=EXCLUDED.alokasi,
           detail_alokasi=EXCLUDED.detail_alokasi, pic=EXCLUDED.pic, rh=EXCLUDED.rh,
           harga=EXCLUDED.harga, total_harga=EXCLUDED.total_harga,
           no_mr=EXCLUDED.no_mr, gen_bus=EXCLUDED.gen_bus, status_smr=EXCLUDED.status_smr,
           no_shipment=EXCLUDED.no_shipment, keterangan=EXCLUDED.keterangan,
           jenis=EXCLUDED.jenis, merk=EXCLUDED.merk, tipe=EXCLUDED.tipe,
           section=EXCLUDED.section, imported_at=NOW(), imported_by=EXCLUDED.imported_by
         RETURNING (xmax = 0) AS is_new`,
        [`wr-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, site, direction, tab, hash,
         r.tanggal, r.minggu, r.bulan, r.tahun, r.kode, r.namaBarang, r.jumlah, r.satuan, r.alokasi,
         r.detailAlokasi, r.pic, r.rh, r.harga, r.totalHarga, r.noMr, r.genBus, r.statusSmr,
         r.noShipment, r.keterangan, r.jenis, r.merk, r.tipe, r.section, importedBy]
      );
      rows[0].is_new ? inserted++ : updated++;
    }
    // Baris yang tabnya sama (site+direction+source_tab) tapi hash-nya tidak
    // ada di batch saat ini berarti sudah tidak relevan lagi → dihapus.
    // Dijaga supaya tidak jalan kalau batch kosong (mis. fetch gagal/tab
    // kosong sementara) — kalau tidak, semua baris lama malah ikut terhapus.
    let removed = 0;
    if (hashesInBatch.length > 0) {
      const res = await query(
        `DELETE FROM weekly_report_rows
          WHERE site = $1 AND direction = $2 AND source_tab = $3
            AND NOT (row_hash = ANY($4::text[]))`,
        [site, direction, tab, hashesInBatch]
      );
      removed = res.rowCount;
    }
    return { inserted, updated, removed, total: records.length };
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
    const hasil = rows.map((r) => ({
      id: r.id, site: r.site, direction: r.direction, sourceTab: r.source_tab,
      tanggal: r.tanggal ? new Date(r.tanggal).toISOString().slice(0, 10) : null,
      minggu: r.minggu, bulan: r.bulan, tahun: r.tahun, kode: r.kode,
      namaBarang: r.nama_barang, jumlah: Number(r.jumlah), satuan: r.satuan,
      alokasi: r.alokasi, detailAlokasi: r.detail_alokasi, pic: r.pic,
      rh: r.rh === null ? null : Number(r.rh), harga: Number(r.harga),
      totalHarga: Number(r.total_harga), noMr: r.no_mr, genBus: r.gen_bus,
      statusSmr: r.status_smr, noShipment: r.no_shipment, keterangan: r.keterangan,
      jenis: r.jenis, merk: r.merk, tipe: r.tipe,
      section: r.section, importedAt: r.imported_at, importedBy: r.imported_by,
    }));
    await attachEstimasiHarga(hasil);
    return hasil;
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
        const parsed = parseCsv(csv);
        assertDirectionMatches(tab, parsed);
        const records = rowsToRecords(parsed);
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
            const parsed = parseCsv(await fetchTabCsv(s.sheet_id, tab));
            assertDirectionMatches(tab, parsed);
            const records = rowsToRecords(parsed);
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
// ── Input manual Barang Masuk / Barang Keluar lewat website ──────────────────────────────────────
//
// Form dibangun dari TEMPLATE sheet sumber: header asli tiap tab (tersimpan saat sync di
// weekly_report_layouts) → tiap kolom jadi kolom form. Data yang diinput:
//   1. divalidasi di server (tanggal, jumlah, satuan, duplikat, kode vs tab, dst.),
//   2. disimpan di aplikasi SEGERA (status "pending") — tidak ada data yang hilang walau Google bermasalah,
//   3. ditulis ke baris baru di Google Spreadsheet (googleSheetsApi.js) → status "ok" + nomor baris sheet,
//   4. kalau Google gagal/belum tersambung: status "pending"/"gagal", dikirim ulang otomatis tiap sinkron
//      (atau manual lewat tombol "Kirim ulang"). Sync sheet→website tidak menghapus baris yang belum terkirim.
// Arah sebaliknya (sheet → website) tetap lewat sinkron biasa; baris yang sama dikenali lewat hash yang sama.
import express from 'express';
import { tambahBaris, deteksiKolomRumus, sheetsTersambung, emailAkunLayanan } from './googleSheetsApi.js';
import { deteksiFormatTanggal, formatTanggal, angkaKetat } from './weeklyExport.js';

const FIELD_ANGKA = new Set(['jumlah', 'harga', 'totalHarga', 'rh']);
const FIELD_AUTO = new Set(['minggu', 'bulan', 'tahun']);
const MAKS_TEKS = 300;

const galat = (pesan, status = 400, ekstra = {}) => Object.assign(new Error(pesan), { status, ...ekstra });
const kosong = (v) => String(v ?? '').trim() === '';
const bersih = (v, maks = MAKS_TEKS) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, maks);
const normKunci = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Minggu ISO (Senin = awal minggu) dari 'YYYY-MM-DD'. Sama dengan penomoran Minggu pada sheet sumber. */
export function mingguIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // Kamis minggu itu
  const kamis1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - kamis1) / 86400000 - 3 + ((kamis1.getUTCDay() + 6) % 7)) / 7);
}

const tanggalValid = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const hariIni = () => new Date().toISOString().slice(0, 10);
const geser = (iso, hari) => new Date(Date.parse(`${iso}T00:00:00Z`) + hari * 86400000).toISOString().slice(0, 10);

export function buatInputManual(d) {
  const { query, withTransaction, requireAuth, siteGuard, rowsToRecords, HEADER_MAP, norm, hashRow, entitasDariTab, entitasDariKode, catatPerubahan } = d;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ── Template → kolom form ────────────────────────────────────────────────
  function kolomDariHeader(header, direction) {
    const dipakai = new Set();
    const hasil = [];
    header.forEach((judulMentah, idx) => {
      const judul = String(judulMentah ?? '').replace(/\s+/g, ' ').trim();
      if (!judul) return;
      let field = HEADER_MAP[norm(judulMentah)] || null;
      // Dua header ke field yang sama → hanya yang pertama jadi kolom "pintar"; sisanya teks biasa.
      if (field && dipakai.has(field)) field = null;
      if (field) dipakai.add(field);
      const jenis = field === 'tanggal' ? 'tanggal' : FIELD_ANGKA.has(field) ? 'angka' : FIELD_AUTO.has(field) ? 'bilbul' : 'teks';
      const wajib = ['tanggal', 'namaBarang', 'jumlah', 'satuan'].includes(field) || (field === 'alokasi' && direction === 'OUT');
      hasil.push({ idx, judul, field, jenis, wajib, auto: FIELD_AUTO.has(field), rumus: false });
    });
    return hasil;
  }

  async function ambilLayout(site, direction, tab) {
    const { rows } = await query('SELECT header FROM weekly_report_layouts WHERE site = $1 AND direction = $2 AND source_tab = $3', [site, direction, tab]);
    if (!rows.length) throw galat(`Tab "${tab}" belum pernah disinkronkan, jadi template kolomnya belum diketahui. Klik "Sync Sekarang" dulu.`, 409);
    return rows[0].header;
  }
  const sheetIdSite = async (site) => (await query('SELECT sheet_id FROM weekly_report_sources WHERE site = $1', [site])).rows[0]?.sheet_id || null;

  async function contohTanggalTab(site, direction, tab, idxTgl) {
    if (idxTgl < 0) return [];
    const { rows } = await query(
      `SELECT raw ->> $4::int AS t FROM weekly_report_rows
        WHERE site = $1 AND direction = $2 AND source_tab = $3 AND raw IS NOT NULL AND trim(coalesce(raw ->> $4::int, '')) <> '' LIMIT 5`,
      [site, direction, tab, idxTgl]);
    return rows.map((x) => x.t);
  }

  // ── Daftar saran (satuan/alokasi/PIC/status) dari data yang sudah ada ───────────────────
  async function ambilSaran(site, direction) {
    const top = async (kolom, tambahan = '') => (await query(
      `SELECT ${kolom} AS v, COUNT(*) AS c FROM weekly_report_rows
        WHERE site = $1 AND direction = $2 AND ${kolom} <> '' ${tambahan} GROUP BY ${kolom} ORDER BY c DESC, v LIMIT 80`, [site, direction])).rows.map((x) => x.v);
    return {
      satuan: await top('satuan'),
      alokasi: await top('alokasi', "AND alokasi <> 'OTHERS'"),
      pic: await top('pic'),
      status: await top('status_smr'),
    };
  }
  const samakanEja = (nilai, daftar) => {
    const k = normKunci(nilai);
    return daftar.find((x) => normKunci(x) === k) || nilai;
  };

  // ── Validasi → baris yang siap ditulis ───────────────────────────────────────
  /** nilai: { [indeksKolom]: nilai mentah dari form }. Kembalikan { cells, nilaiKolom, ringkas } atau lempar galat per-field. */
  async function siapkanBaris({ site, direction, tab, header, kolom, nilai, abaikan }) {
    const galatField = {};
    const ambil = (field) => { const k = kolom.find((x) => x.field === field); return k ? { k, v: nilai?.[k.idx] } : { k: null, v: undefined }; };
    const saran = await ambilSaran(site, direction);

    // Tanggal
    const tg = ambil('tanggal');
    let iso = '';
    if (tg.k) {
      iso = String(tg.v ?? '').trim();
      if (!tanggalValid(iso)) galatField[tg.k.idx] = 'Tanggal tidak valid.';
      else if (iso > geser(hariIni(), 1)) galatField[tg.k.idx] = 'Tanggal tidak boleh di masa depan.';
      else if (iso < geser(hariIni(), -730)) galatField[tg.k.idx] = 'Tanggal lebih dari 2 tahun lalu — periksa kembali.';
    }
    const nomor = (field, { min = 0, maks = 1e9, wajib = false, label }) => {
      const { k, v } = ambil(field);
      if (!k) return null;
      if (kosong(v)) { if (wajib) galatField[k.idx] = `${label} wajib diisi.`; return null; }
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
      if (!Number.isFinite(n)) { galatField[k.idx] = `${label} harus berupa angka.`; return null; }
      if (wajib && n <= 0) { galatField[k.idx] = `${label} harus lebih dari 0.`; return null; }
      if (n < min || n > maks) { galatField[k.idx] = `${label} di luar batas wajar (${min}–${maks.toLocaleString('id-ID')}).`; return null; }
      return Math.round(n * 1000) / 1000;
    };
    const jumlah = nomor('jumlah', { wajib: true, maks: 1e7, label: 'Jumlah' });
    let harga = nomor('harga', { maks: 1e12, label: 'Harga' });
    let total = nomor('totalHarga', { maks: 1e13, label: 'Total harga' });
    const rh = nomor('rh', { maks: 1e7, label: 'RH' });
    if (total === null && harga !== null && jumlah) total = Math.round(harga * jumlah * 100) / 100; // total otomatis
    if (harga === null && total !== null && jumlah) harga = Math.round((total / jumlah) * 100) / 100;

    // Teks
    const teks = (field, { wajib = false, label, maks = MAKS_TEKS, min = 0, daftar = null }) => {
      const { k, v } = ambil(field);
      if (!k) return '';
      let s = bersih(v, maks);
      if (!s) { if (wajib) galatField[k.idx] = `${label} wajib diisi.`; return ''; }
      if (s.length < min) galatField[k.idx] = `${label} terlalu pendek.`;
      if (daftar) s = samakanEja(s, daftar);
      return s;
    };
    const namaBarang = teks('namaBarang', { wajib: true, label: 'Nama barang', min: 3, maks: 200 });
    let kode = teks('kode', { label: 'Kode', maks: 60 });
    if (kode) {
      kode = kode.toUpperCase();
      const kk = ambil('kode').k;
      if (!/^[A-Z0-9][A-Z0-9 ._/\-]*$/.test(kode)) galatField[kk.idx] = 'Kode hanya boleh huruf, angka, spasi, titik, garis miring, atau strip.';
    }
    const satuan = teks('satuan', { wajib: true, label: 'Satuan', maks: 20, daftar: saran.satuan });
    const alokasi = teks('alokasi', { wajib: direction === 'OUT', label: direction === 'OUT' ? 'Alokasi' : 'Supplier', maks: 120, daftar: saran.alokasi });

    if (Object.keys(galatField).length) throw galat('Periksa kembali isian yang ditandai.', 422, { galatField });

    // Kode barang harus sesuai entitas tab (kode RDA di tab Workshop biasanya salah ketik).
    const entTab = entitasDariTab(tab), entKode = entitasDariKode(kode);
    if (entKode && entTab !== 'UMUM' && entKode !== entTab && !abaikan.includes('entitas')) {
      throw galat(`Kode ${kode} berentitas ${entKode}, sedangkan tab "${tab}" adalah ${entTab}. Pastikan tab yang dipilih sudah benar.`, 409, { konflik: 'entitas' });
    }

    // Sel sesuai urutan kolom template (tampilan) + nilai bertipe untuk sheet.
    const sel = Array(header.length).fill('');
    const nilaiKolom = Array(header.length).fill(undefined);
    const mingguTgl = iso ? mingguIso(iso) : 0;
    const bulanTgl = iso ? Number(iso.slice(5, 7)) : 0;
    const tahunTgl = iso ? Number(iso.slice(0, 4)) : 0;
    const contoh = await contohTanggalTab(site, direction, tab, kolom.find((x) => x.field === 'tanggal')?.idx ?? -1);
    const fmt = deteksiFormatTanggal(contoh);
    const teksTanggal = iso ? formatTanggal(new Date(`${iso}T00:00:00Z`), fmt) : '';
    const dari = { tanggal: iso, minggu: mingguTgl, bulan: bulanTgl, tahun: tahunTgl, kode, namaBarang, jumlah, satuan, alokasi, harga, totalHarga: total, rh };
    for (const k of kolom) {
      let v;
      if (k.field === 'tanggal') { sel[k.idx] = teksTanggal; nilaiKolom[k.idx] = iso ? { iso, teks: teksTanggal } : undefined; continue; }
      if (k.field && k.field in dari) v = dari[k.field];
      else v = bersih(nilai?.[k.idx]);
      if (k.field === 'statusSmr' && v) v = samakanEja(v, saran.status);
      if (k.field === 'pic' && v) v = samakanEja(v, saran.pic);
      if (v === null || v === undefined || v === '') { sel[k.idx] = ''; nilaiKolom[k.idx] = undefined; continue; }
      sel[k.idx] = String(v);
      nilaiKolom[k.idx] = typeof v === 'number' ? v : String(v);
    }
    return { sel, nilaiKolom, iso, jumlah, total, nilaiTersimpan: Object.fromEntries(kolom.map((k) => [k.idx, nilaiKolom[k.idx] && typeof nilaiKolom[k.idx] === 'object' ? nilaiKolom[k.idx].iso : (nilaiKolom[k.idx] ?? '')])) };
  }

  // ── Kirim ke sheet ────────────────────────────────────────────────────────
  /** Susun ulang nilai bertipe dari `input_nilai` tersimpan (dipakai juga saat kirim ulang). */
  async function nilaiUntukSheet({ site, direction, tab, header, kolom, tersimpan }) {
    const idxTgl = kolom.find((k) => k.field === 'tanggal')?.idx ?? -1;
    const fmt = deteksiFormatTanggal(await contohTanggalTab(site, direction, tab, idxTgl));
    return header.map((_, i) => {
      const k = kolom.find((x) => x.idx === i);
      const v = tersimpan?.[i];
      if (!k || v === undefined || v === null || v === '') return undefined;
      if (k.field === 'tanggal') return { iso: v, teks: formatTanggal(new Date(`${v}T00:00:00Z`), fmt) };
      return v;
    });
  }

  async function kirimKeSheet(baris, { idempoten }) {
    const header = await ambilLayout(baris.site, baris.direction, baris.source_tab);
    const kolom = kolomDariHeader(header, baris.direction);
    const idxNama = kolom.find((k) => k.field === 'namaBarang')?.idx;
    const idxTgl = kolom.find((k) => k.field === 'tanggal')?.idx ?? -1;
    const sheetId = await sheetIdSite(baris.site);
    if (!sheetId) throw galat('Sumber Sheet untuk site ini belum diatur.', 409);
    const nilaiKolom = await nilaiUntukSheet({ site: baris.site, direction: baris.direction, tab: baris.source_tab, header, kolom, tersimpan: baris.input_nilai });
    const idxKode = kolom.find((k) => k.field === 'kode')?.idx ?? -1;
    const idxJml = kolom.find((k) => k.field === 'jumlah')?.idx ?? -1;
    const bacaJml = (s) => { const a = angkaKetat(s, 'ID') ?? angkaKetat(s, 'US'); return a ? a.n : Number(String(s).replace(',', '.')); };
    const samaDengan = idempoten ? (r) => (
      normKunci(r[idxNama]) === normKunci(nilaiKolom[idxNama]) &&
      (idxKode < 0 || normKunci(r[idxKode]) === normKunci(nilaiKolom[idxKode])) &&
      (idxJml < 0 || bacaJml(r[idxJml]) === Number(nilaiKolom[idxJml]))) : undefined;
    return tambahBaris({ sheetId, tab: baris.source_tab, header, idxNama, idxTanggal: idxTgl, nilaiKolom, samaDengan });
  }

  async function cobaKirim(baris, { idempoten }) {
    if (!sheetsTersambung()) {
      await query(`UPDATE weekly_report_rows SET sheet_status = 'pending', sheet_error = $2 WHERE id = $1`, [baris.id, 'Belum tersambung ke Google Sheet.']);
      return { status: 'pending', pesan: 'Tersimpan di aplikasi. Belum tersambung ke Google Sheet — akan terkirim otomatis begitu koneksi diaktifkan.' };
    }
    try {
      const { baris: nomor, sudahAda } = await kirimKeSheet(baris, { idempoten });
      await query(`UPDATE weekly_report_rows SET sheet_status = 'ok', sheet_error = '', sheet_row = $2, urut = $2 WHERE id = $1`, [baris.id, nomor]);
      return { status: 'ok', barisSheet: nomor, pesan: sudahAda ? `Baris ini sudah ada di sheet (baris ${nomor}).` : `Tersimpan di sheet "${baris.source_tab}" baris ${nomor}.` };
    } catch (err) {
      await query(`UPDATE weekly_report_rows SET sheet_status = 'gagal', sheet_error = $2 WHERE id = $1`, [baris.id, String(err.message).slice(0, 500)]);
      return { status: 'gagal', pesan: `Tersimpan di aplikasi, tetapi belum masuk ke sheet: ${err.message}` };
    }
  }

  // ── Simpan ────────────────────────────────────────────────────────────────
  async function simpanInput({ site, direction, tab, nilai, abaikan, auth }) {
    const header = await ambilLayout(site, direction, tab);
    const kolom = kolomDariHeader(header, direction);
    if (!kolom.some((k) => k.field === 'namaBarang')) throw galat('Template tab ini tidak punya kolom "Nama Barang".', 409);
    const baris = await siapkanBaris({ site, direction, tab, header, kolom, nilai, abaikan });

    // Rekam untuk DB lewat jalur parser yang sama dengan sync → hash identik dengan baris yang nanti dibaca dari sheet.
    const sel = baris.sel.map((v, i) => (kolom.find((k) => k.idx === i)?.field === 'tanggal' ? baris.iso : v));
    const rec = rowsToRecords([header, sel], site)[0];
    if (!rec) throw galat('Baris tidak bisa dibaca dengan template tab ini.', 422);
    rec.raw = baris.sel;
    const basis = hashRow(rec);

    const id = await withTransaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wr:${site}:${direction}:${tab}`]);
      const { rows: sama } = await db.query(
        `SELECT row_hash FROM weekly_report_rows WHERE site = $1 AND direction = $2 AND (row_hash = $3 OR starts_with(row_hash, $3 || '|#'))`, [site, direction, basis]);
      if (sama.length && !abaikan.includes('duplikat')) {
        throw galat('Barang yang sama (tanggal, kode, jumlah, alokasi, dan nomor dokumen sama) sudah tercatat. Pastikan ini bukan input ganda.', 409, { konflik: 'duplikat' });
      }
      const hash = sama.length ? `${basis}|#${sama.length + 1}` : basis;
      const { rows: mx } = await db.query('SELECT COALESCE(MAX(urut), 0) + 1 AS n FROM weekly_report_rows WHERE site = $1 AND direction = $2 AND source_tab = $3', [site, direction, tab]);
      const baruId = `wr-web-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      await db.query(
        `INSERT INTO weekly_report_rows (id, site, direction, source_tab, row_hash, tanggal, minggu, bulan, tahun, kode, nama_barang, jumlah, satuan, alokasi,
           detail_alokasi, pic, rh, harga, total_harga, no_mr, gen_bus, status_smr, no_shipment, keterangan, jenis, merk, tipe, section, raw, urut,
           imported_by, input_web, sheet_status, sheet_error, input_nilai, dibuat_oleh)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31,TRUE,'pending','',$32::jsonb,$33)`,
        [baruId, site, direction, tab, hash, rec.tanggal, rec.minggu, rec.bulan, rec.tahun, rec.kode, rec.namaBarang, rec.jumlah, rec.satuan, rec.alokasi,
          rec.detailAlokasi, rec.pic, rec.rh, rec.harga, rec.totalHarga, rec.noMr, rec.genBus, rec.statusSmr, rec.noShipment, rec.keterangan, rec.jenis, rec.merk, rec.tipe, rec.section,
          JSON.stringify(rec.raw), mx[0].n, `web:${auth.email}`, JSON.stringify(baris.nilaiTersimpan), auth.name || auth.email]);
      return baruId;
    });

    const { rows } = await query('SELECT * FROM weekly_report_rows WHERE id = $1', [id]);
    const hasil = await cobaKirim(rows[0], { idempoten: false });

    try {
      await catatPerubahan({ site, area: direction, sumber: `web:${auth.email}`,
        baru: [{ pic: rec.pic || auth.name || auth.email, nama: rec.namaBarang, ket: `${rec.jumlah} ${rec.satuan}`.trim() }], ubah: [], hapus: [] });
    } catch (e) { console.warn('[input-manual] gagal mencatat notifikasi:', e.message); }
    return { ok: true, id, tersambung: sheetsTersambung(), ...hasil };
  }

  async function kirimUlang(id, auth) {
    const { rows } = await query('SELECT * FROM weekly_report_rows WHERE id = $1 AND input_web = TRUE', [id]);
    if (!rows.length) throw galat('Data input tidak ditemukan.', 404);
    siteGuard({ auth }, rows[0].site);
    if (rows[0].sheet_status === 'ok') return { ok: true, status: 'ok', pesan: 'Sudah tersimpan di sheet.', barisSheet: rows[0].sheet_row };
    return { ok: true, ...(await cobaKirim(rows[0], { idempoten: true })) };
  }

  /** Dipanggil tiap putaran auto-sync: kirim ulang baris web yang belum masuk sheet. */
  async function kirimTertunda() {
    if (!sheetsTersambung()) return 0;
    const { rows } = await query(
      `SELECT * FROM weekly_report_rows WHERE input_web = TRUE AND sheet_status <> 'ok' AND imported_at > NOW() - INTERVAL '7 days' ORDER BY imported_at LIMIT 25`);
    let terkirim = 0;
    for (const b of rows) { const h = await cobaKirim(b, { idempoten: true }); if (h.status === 'ok') terkirim++; }
    return terkirim;
  }

  // ── Router ───────────────────────────────────────────────────────────────
  const router = express.Router();
  const parseSiteArah = (req) => {
    const site = String(req.query.site || req.body?.site || '').trim();
    const direction = String(req.query.direction || req.body?.direction || '').toUpperCase();
    if (!site || site === 'global') throw galat('Pilih satu site terlebih dulu.', 400);
    if (!['IN', 'OUT'].includes(direction)) throw galat('Arah harus IN (Barang Masuk) atau OUT (Barang Keluar).', 400);
    siteGuard(req, site);
    return { site, direction };
  };

  // Konfigurasi form: kolom tiap tab (dari template sheet), saran isian, katalog kode, status koneksi Google.
  router.get('/weekly-reports/input/config', requireAuth, wrap(async (req, res) => {
    const { site, direction } = parseSiteArah(req);
    const { rows: lay } = await query('SELECT source_tab, header FROM weekly_report_layouts WHERE site = $1 AND direction = $2 ORDER BY source_tab', [site, direction]);
    const sheetId = await sheetIdSite(site);
    const tersambung = sheetsTersambung() && !!sheetId;
    const tabs = [];
    for (const l of lay) {
      const kolom = kolomDariHeader(l.header, direction);
      const idxNama = kolom.find((k) => k.field === 'namaBarang')?.idx;
      if (idxNama === undefined) continue;
      if (tersambung) {
        try {
          const rumus = await deteksiKolomRumus({ sheetId, tab: l.source_tab, nCol: l.header.length, idxNama });
          kolom.forEach((k) => { k.rumus = !!rumus[k.idx]; });
        } catch { /* koneksi/izin bermasalah: form tetap jalan, kesalahan muncul saat simpan */ }
      }
      tabs.push({ tab: l.source_tab, entitas: entitasDariTab(l.source_tab), kolom });
    }
    const { rows: katalog } = await query(
      `SELECT DISTINCT ON (kode) kode, nama_barang AS nama, satuan, harga FROM weekly_report_rows
        WHERE site = $1 AND direction IN ('IN','OUT') AND kode <> ''
        ORDER BY kode, (harga > 0) DESC, (direction = $2) DESC, tanggal DESC NULLS LAST, urut DESC NULLS LAST LIMIT 6000`, [site, direction]);
    const { rows: saldo } = await query(
      `SELECT kode, SUM(CASE WHEN direction = 'IN' THEN jumlah ELSE -jumlah END) AS saldo FROM weekly_report_rows
        WHERE site = $1 AND direction IN ('IN','OUT') AND kode <> '' GROUP BY kode`, [site]);
    const peta = new Map(saldo.map((s) => [s.kode, Number(s.saldo)]));
    res.json({
      tersambung, emailLayanan: emailAkunLayanan(), sheetDiatur: !!sheetId, tabs, saran: await ambilSaran(site, direction),
      katalog: katalog.map((k) => ({ kode: k.kode, nama: k.nama, satuan: k.satuan, harga: Number(k.harga) || 0, saldo: peta.get(k.kode) ?? 0 })),
    });
  }));

  router.post('/weekly-reports/input', requireAuth, wrap(async (req, res) => {
    const { site, direction } = parseSiteArah(req);
    const tab = String(req.body?.tab || '');
    if (!tab) throw galat('Pilih tab tujuan.', 400);
    const abaikan = Array.isArray(req.body?.abaikan) ? req.body.abaikan.map(String) : [];
    try {
      res.json(await simpanInput({ site, direction, tab, nilai: req.body?.nilai || {}, abaikan, auth: req.auth }));
    } catch (err) {
      if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, konflik: err.konflik, galatField: err.galatField });
      throw err;
    }
  }));

  router.post('/weekly-reports/input/:id/kirim-ulang', requireAuth, wrap(async (req, res) => {
    try { res.json(await kirimUlang(req.params.id, req.auth)); }
    catch (err) { if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message }); throw err; }
  }));

  router.get('/weekly-reports/input/riwayat', requireAuth, wrap(async (req, res) => {
    const { site, direction } = parseSiteArah(req);
    const { rows } = await query(
      `SELECT id, source_tab, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, kode, nama_barang, jumlah, satuan, sheet_status, sheet_row, sheet_error, dibuat_oleh, imported_at
         FROM weekly_report_rows WHERE site = $1 AND direction = $2 AND input_web = TRUE ORDER BY imported_at DESC LIMIT 12`, [site, direction]);
    res.json({ riwayat: rows.map((x) => ({
      id: x.id, tab: x.source_tab, tanggal: x.tanggal || null, kode: x.kode, nama: x.nama_barang,
      jumlah: Number(x.jumlah), satuan: x.satuan, status: x.sheet_status, barisSheet: x.sheet_row, error: x.sheet_error, oleh: x.dibuat_oleh, waktu: x.imported_at,
    })) });
  }));

  return { router, kirimTertunda };
}
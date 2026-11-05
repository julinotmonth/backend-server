// ── Export Barang Masuk / Keluar ke Excel dengan template yang SAMA seperti sheet sumber ──
//
// Saat sync / import, weeklyReport.js menyimpan dua hal per tab sumber:
//   • layout  : baris judul di atas header + baris header ASLI (urutan & penamaan kolom persis sheet)
//   • raw     : isi sel ASLI tiap baris (apa adanya, tanpa dinormalisasi) + urutan barisnya
// Modul ini hanya merangkai ulang keduanya menjadi file .xlsx — satu worksheet per tab sumber,
// kolom dan isi sel identik dengan sheet, lalu diberi tampilan rapi (header tebal, garis tipis,
// lebar kolom otomatis, freeze header, filter, siap cetak).
//
// Yang TIDAK bisa dibawa: warna/font/merge-cell asli di Google Sheets, karena sheet ditarik sebagai
// CSV (CSV memang tidak membawa format). Urutan kolom, judul kolom, dan isi sel tetap sama persis.
//
// Fungsi ini murni (tanpa akses DB) supaya mudah diuji.
import ExcelJS from 'exceljs';

const norm = (h) => String(h ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

// Kolom yang isinya angka → ditulis sebagai angka sungguhan (bisa dijumlah di Excel).
const KOLOM_ANGKA = new Set(['jumlah', 'qty', 'harga', 'total harga', 'nilai', 'rh']);
const KOLOM_BILBUL = new Set(['minggu', 'bulan', 'tahun']); // bilangan bulat tanpa pemisah ribuan

/**
 * Baca angka HANYA bila bentuknya tak ambigu (format Indonesia). Selain itu kembalikan null
 * dan sel dibiarkan sebagai teks persis seperti di sheet — nilai tidak boleh berubah diam-diam.
 *   "1.234.567" → 1234567 · "1.234,5" → 1234.5 · "Rp 600.346.750" → 600346750 · "12" → 12
 */
export function angkaKetat(mentah) {
  let s = String(mentah ?? '').trim();
  if (!s) return null;
  let neg = false, rp = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  const m = /^rp\.?\s*/i.exec(s);
  if (m) { rp = true; s = s.slice(m[0].length); }
  let n, desimal = false;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ''));
  else if (/^\d{1,3}(\.\d{3})*,\d+$/.test(s) || /^\d+,\d+$/.test(s)) { n = Number(s.replace(/\./g, '').replace(',', '.')); desimal = true; }
  else if (/^\d+\.\d{1,2}$/.test(s)) { n = Number(s); desimal = true; }
  else return null;
  if (!Number.isFinite(n)) return null;
  return { n: neg ? -n : n, desimal, rp };
}

// ── Kolom standar, dipakai HANYA bila layout asli tab belum tersimpan (data sebelum sync ulang) ──
const KOLOM_STANDAR = {
  IN: [
    ['Tanggal', (r) => r.tanggal ?? ''], ['Minggu', (r) => Number(r.minggu)], ['Kode', (r) => r.kode], ['Nama Barang', (r) => r.nama_barang],
    ['Jumlah', (r) => Number(r.jumlah)], ['Satuan', (r) => r.satuan], ['Supplier', (r) => r.alokasi], ['Harga', (r) => Number(r.harga)],
    ['Total Harga', (r) => Number(r.total_harga)], ['No MR', (r) => r.no_mr], ['Ket', (r) => r.keterangan],
  ],
  OUT: [
    ['Tanggal', (r) => r.tanggal ?? ''], ['Minggu', (r) => Number(r.minggu)], ['Kode', (r) => r.kode], ['Nama Barang', (r) => r.nama_barang],
    ['Jumlah', (r) => Number(r.jumlah)], ['Satuan', (r) => r.satuan], ['Alokasi', (r) => r.alokasi], ['Detail Alokasi', (r) => r.detail_alokasi],
    ['PIC', (r) => r.pic], ['Harga', (r) => Number(r.harga)], ['Total Harga', (r) => Number(r.total_harga)], ['No MR', (r) => r.no_mr],
    ['No Shipment', (r) => r.no_shipment], ['Ket', (r) => r.keterangan],
  ],
};

const HIJAU = 'FF0B6B4F';
const GARIS = { style: 'thin', color: { argb: 'FFD5DBE1' } };
const BORDER = { top: GARIS, left: GARIS, bottom: GARIS, right: GARIS };

const namaSheetAman = (nama, dipakai) => {
  let dasar = String(nama || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let kandidat = dasar, i = 2;
  while (dipakai.has(kandidat.toLowerCase())) {
    const akhiran = ` (${i++})`;
    kandidat = dasar.slice(0, 31 - akhiran.length) + akhiran;
  }
  dipakai.add(kandidat.toLowerCase());
  return kandidat;
};

function tulisSheet(wb, nama, { preamble, header, data, tab }) {
  const nCol = Math.max(header.length, ...preamble.map((p) => p.length), ...data.map((d) => d.length), 1);
  const pad = (arr) => Array.from({ length: nCol }, (_, i) => arr[i] ?? '');
  const barisHeader = preamble.length + 1;

  const ws = wb.addWorksheet(nama, {
    views: [{ state: 'frozen', ySplit: barisHeader, showGridLines: false }],
    properties: { tabColor: { argb: HIJAU } },
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${barisHeader}:${barisHeader}`,
      margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
  });
  ws.headerFooter.oddFooter = `&L&8${String(tab).replace(/&/g, '&&')}&R&8Halaman &P dari &N`;

  // Baris judul di atas header (bila sheet punya) — isi persis, hanya ditebalkan.
  preamble.forEach((p) => {
    const r = ws.addRow(pad(p));
    r.font = { bold: true, size: 12, color: { argb: 'FF1F2937' } };
  });

  const rh = ws.addRow(pad(header));
  rh.height = 24;
  rh.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HIJAU } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  });

  // Jenis tiap kolom dari judul headernya.
  const jenis = Array.from({ length: nCol }, (_, i) => {
    const n = norm(header[i]);
    return KOLOM_ANGKA.has(n) ? 'angka' : KOLOM_BILBUL.has(n) ? 'bilbul' : 'teks';
  });

  const lebar = Array.from({ length: nCol }, (_, i) => String(header[i] ?? '').length + 4);
  data.forEach((baris, idx) => {
    const sel = pad(baris).map((v, i) => {
      const teks = v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
      lebar[i] = Math.max(lebar[i], Math.min(String(teks).length + 2, 60));
      if (jenis[i] === 'teks' || teks === '') return { v: teks, fmt: null };
      // Sudah berupa angka (kolom standar dari DB): tulis apa adanya.
      if (typeof teks === 'number') return { v: teks, fmt: jenis[i] === 'bilbul' ? '0' : Number.isInteger(teks) ? '#,##0' : '#,##0.00' };
      const a = angkaKetat(teks);
      if (!a) return { v: teks, fmt: null };
      if (jenis[i] === 'bilbul') return { v: a.n, fmt: '0' };
      return { v: a.n, fmt: a.rp ? (a.desimal ? '"Rp" #,##0.00' : '"Rp" #,##0') : (a.desimal ? '#,##0.00' : '#,##0') };
    });
    const r = ws.addRow(sel.map((x) => x.v));
    r.eachCell({ includeEmpty: true }, (c, col) => {
      const info = sel[col - 1];
      c.border = BORDER;
      c.font = { size: 10 };
      c.alignment = { vertical: 'middle', horizontal: typeof c.value === 'number' ? 'right' : 'left', wrapText: true };
      if (info?.fmt) c.numFmt = info.fmt;
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F9' } };
    });
  });

  lebar.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(8, Math.min(48, w)); });
  ws.autoFilter = { from: { row: barisHeader, column: 1 }, to: { row: barisHeader, column: nCol } };
  return ws;
}

/**
 * @param rows     baris DB (snake_case) terurut per site + tab + urutan sheet
 * @param layouts  Map "site|tab" → { header: string[], preamble: string[][] }
 * @param direction 'IN' | 'OUT'
 * @returns { buffer, sheets, standar } — `standar` = jumlah tab yang terpaksa memakai kolom standar
 */
export async function buatXlsx({ rows, layouts, direction }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reethau Inventory Admin Portal';
  wb.created = new Date();

  const grup = new Map();
  for (const r of rows) {
    const k = `${r.site}|${r.source_tab}`;
    if (!grup.has(k)) grup.set(k, []);
    grup.get(k).push(r);
  }

  const dipakai = new Set();
  const banyakSite = new Set(rows.map((r) => r.site)).size > 1;
  let standar = 0;
  for (const [k, isi] of grup) {
    const { site, source_tab: tab } = isi[0];
    const nama = namaSheetAman(banyakSite ? `${site} ${tab}` : tab, dipakai);
    const layout = layouts.get(k);
    const lengkap = layout?.header?.length && isi.every((r) => Array.isArray(r.raw));
    if (lengkap) {
      tulisSheet(wb, nama, { preamble: layout.preamble || [], header: layout.header, data: isi.map((r) => r.raw), tab });
    } else {
      standar++;
      const kolom = KOLOM_STANDAR[direction] || KOLOM_STANDAR.OUT;
      tulisSheet(wb, nama, { preamble: [], header: kolom.map(([h]) => h), data: isi.map((r) => kolom.map(([, f]) => f(r))), tab });
    }
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), sheets: grup.size, standar };
}
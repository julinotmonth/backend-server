// ── Export Barang Masuk / Keluar ke Excel dengan template yang SAMA seperti sheet sumber ──
//
// Saat sync / import, weeklyReport.js menyimpan dua hal per tab sumber:
//   • layout  : baris judul di atas header + baris header ASLI (urutan & penamaan kolom persis sheet)
//   • raw     : isi sel ASLI tiap baris (apa adanya, tanpa dinormalisasi)
// Modul ini merangkai ulang keduanya menjadi file .xlsx — satu worksheet per tab sumber, kolom dan isi
// sel identik dengan sheet — lalu merapikannya: baris diurutkan per MINGGU, tanggal yang kosong di sheet
// diisi dari nomor minggunya (ditandai kuning), angka ditulis sebagai angka sungguhan, kolom kosong di
// ujung kanan dibuang, header tebal, garis tipis, freeze header, filter, dan siap cetak.
//
// Yang TIDAK bisa dibawa: warna/font/merge-cell asli di Google Sheets, karena sheet ditarik sebagai
// CSV (CSV memang tidak membawa format). Urutan kolom, judul kolom, dan isi sel tetap sama persis.
//
// Fungsi di sini murni (tanpa akses DB) supaya mudah diuji.
import ExcelJS from 'exceljs';

const norm = (h) => String(h ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
const kosong = (v) => String(v ?? '').replace(/\u00a0/g, ' ').trim() === '';

// Kolom yang isinya angka → ditulis sebagai angka sungguhan (bisa dijumlah di Excel).
const KOLOM_ANGKA = new Set(['jumlah', 'qty', 'harga', 'total harga', 'nilai', 'rh']);
const KOLOM_BILBUL = new Set(['minggu', 'bulan', 'tahun']); // bilangan bulat tanpa pemisah ribuan

// ── Angka ─────────────────────────────────────────────────────────────────
const bersihAngka = (mentah) => {
  let s = String(mentah ?? '').replace(/\u00a0/g, ' ').trim();
  let neg = false, rp = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  const m = /^rp\.?\s*/i.exec(s);
  if (m) { rp = true; s = s.slice(m[0].length).trim(); }
  return { s, neg, rp };
};

/**
 * Baca angka HANYA bila bentuknya tak ambigu. Selain itu kembalikan null dan sel dibiarkan sebagai teks
 * persis seperti di sheet — nilai tidak boleh berubah diam-diam.
 *   lokal 'ID' (titik = ribuan, koma = desimal): "1.234.567" "1.234,5" "Rp 600.346.750"
 *   lokal 'US' (koma = ribuan, titik = desimal): "4,080,000" "1,234.5" " Rp 4,080,000 " "23382.93"
 */
export function angkaKetat(mentah, lokal = 'ID') {
  const { s, neg, rp } = bersihAngka(mentah);
  if (!s) return null;
  let n, desimal = false;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (lokal === 'US') {
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) { n = Number(s.replace(/,/g, '')); desimal = s.includes('.'); }
    else if (/^\d+\.\d+$/.test(s)) { n = Number(s); desimal = true; }
    else return null;
  } else {
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) { n = Number(s.replace(/\./g, '').replace(',', '.')); desimal = s.includes(','); }
    else if (/^\d+,\d+$/.test(s)) { n = Number(s.replace(',', '.')); desimal = true; }
    else if (/^\d+\.\d{1,2}$/.test(s)) { n = Number(s); desimal = true; }
    else return null;
  }
  if (!Number.isFinite(n)) return null;
  return { n: neg ? -n : n, desimal, rp };
}

/** Locale angka sebuah sheet, dari bentuk yang tak ambigu ("4,080,000" → US; "4.080.000" → ID). Default ID. */
export function deteksiLokal(sampel) {
  let us = 0, id = 0;
  for (const t of sampel) {
    const { s } = bersihAngka(t);
    if (/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(s) || /^\d{1,3}(,\d{3})+\.\d+$/.test(s)) us++;
    else if (/^\d{1,3}(\.\d{3}){2,}(,\d+)?$/.test(s) || /^\d{1,3}(\.\d{3})+,\d+$/.test(s)) id++;
  }
  return us > id ? 'US' : 'ID';
}

// ── Tanggal ───────────────────────────────────────────────────────────────
const BULAN_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Awal minggu ISO (Senin) tahun+minggu; bila `bulan` diberikan, hari pertama minggu itu yang jatuh di bulan tsb. */
export function tanggalDariMinggu(tahun, minggu, bulan = 0) {
  const jan4 = new Date(Date.UTC(tahun, 0, 4));
  const hariJan4 = (jan4.getUTCDay() + 6) % 7; // Senin = 0
  const senin = Date.UTC(tahun, 0, 4 - hariJan4 + (minggu - 1) * 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(senin + i * 86400000);
    if (!bulan || d.getUTCMonth() + 1 === bulan) return d;
  }
  return new Date(senin);
}

/** Pola penulisan tanggal yang dipakai sheet ini, dibaca dari sel tanggal yang sudah terisi ("29 July 2026" → nama bulan Inggris). */
export function deteksiFormatTanggal(sampel) {
  for (const t of sampel) {
    const s = String(t ?? '').trim();
    const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(s);
    if (m) {
      const b = m[2].toLowerCase();
      const en = BULAN_EN.some((x) => x.toLowerCase() === b);
      const id = BULAN_ID.some((x) => x.toLowerCase() === b);
      if (en && !id) return { jenis: 'nama', nama: BULAN_EN };
      if (id && !en) return { jenis: 'nama', nama: BULAN_ID };
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { jenis: 'iso' };
  }
  return { jenis: 'nama', nama: BULAN_ID }; // tanpa contoh yang jelas: gaya Indonesia
}

export function formatTanggal(d, fmt) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (fmt.jenis === 'iso') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${dd}`;
  return `${dd} ${fmt.nama[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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
const GARIS_MINGGU = { style: 'medium', color: { argb: 'FF8FA3B3' } };

const namaSheetAman = (nama, dipakai) => {
  const dasar = String(nama || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let kandidat = dasar, i = 2;
  while (dipakai.has(kandidat.toLowerCase())) {
    const akhiran = ` (${i++})`;
    kandidat = dasar.slice(0, 31 - akhiran.length) + akhiran;
  }
  dipakai.add(kandidat.toLowerCase());
  return kandidat;
};

/**
 * data: [{ cells: any[], minggu: number, tglIsi?: string }] — `tglIsi` berisi catatan bila tanggal diisi otomatis.
 */
function tulisSheet(wb, nama, { preamble, header, data, tab, idxTgl, lokal }) {
  const judul = header.map((h) => String(h ?? '').replace(/\s+/g, ' ').trim());

  // Buang kolom kosong di ujung kanan (sheet sering punya puluhan kolom kosong).
  let nCol = 1;
  const pakai = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (!kosong(arr[i])) { nCol = Math.max(nCol, i + 1); break; } };
  pakai(judul); preamble.forEach(pakai); data.forEach((d) => pakai(d.cells));
  const pad = (arr) => Array.from({ length: nCol }, (_, i) => arr[i] ?? '');
  const barisHeader = preamble.length + 1;

  const ws = wb.addWorksheet(nama, {
    views: [{ state: 'frozen', ySplit: barisHeader, showGridLines: false }],
    properties: { tabColor: { argb: HIJAU } },
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${barisHeader}:${barisHeader}`,
      margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
  });
  ws.headerFooter.oddFooter = `&L&8${String(tab).replace(/&/g, '&&')}&R&8Halaman &P dari &N`;

  preamble.forEach((p) => {
    const r = ws.addRow(pad(p));
    r.font = { bold: true, size: 12, color: { argb: 'FF1F2937' } };
  });

  const rh = ws.addRow(pad(judul));
  rh.height = 24;
  rh.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HIJAU } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  });

  const jenis = Array.from({ length: nCol }, (_, i) => {
    const n = norm(judul[i]);
    return KOLOM_ANGKA.has(n) ? 'angka' : KOLOM_BILBUL.has(n) ? 'bilbul' : 'teks';
  });

  const lebar = Array.from({ length: nCol }, (_, i) => String(judul[i] ?? '').length + 4);
  let pita = 0, mingguSebelumnya = null;
  data.forEach((d, idx) => {
    const barisBaru = idx > 0 && d.minggu !== mingguSebelumnya;
    if (barisBaru) pita++;
    mingguSebelumnya = d.minggu;

    const sel = pad(d.cells).map((v, i) => {
      const teks = v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v).replace(/\u00a0/g, ' ').trim());
      lebar[i] = Math.max(lebar[i], Math.min(String(teks).split('\n').reduce((a, b) => Math.max(a, b.length), 0) + 2, 60));
      if (jenis[i] === 'teks' || teks === '') return { v: teks, fmt: null };
      if (typeof teks === 'number') return { v: teks, fmt: jenis[i] === 'bilbul' ? '0' : Number.isInteger(teks) ? '#,##0' : '#,##0.00' };
      const a = angkaKetat(teks, lokal);
      if (!a) return { v: teks, fmt: null };
      if (jenis[i] === 'bilbul') return { v: a.n, fmt: '0' };
      return { v: a.n, fmt: a.rp ? (a.desimal ? '"Rp" #,##0.00' : '"Rp" #,##0') : (a.desimal ? '#,##0.00' : '#,##0') };
    });
    const r = ws.addRow(sel.map((x) => x.v));
    r.eachCell({ includeEmpty: true }, (c, col) => {
      const info = sel[col - 1];
      c.border = barisBaru ? { ...BORDER, top: GARIS_MINGGU } : BORDER;
      c.font = { size: 10 };
      c.alignment = { vertical: 'middle', horizontal: typeof c.value === 'number' ? 'right' : 'left', wrapText: true };
      if (info?.fmt) c.numFmt = info.fmt;
      if (pita % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F8' } }; // belang per MINGGU
      if (d.tglIsi && col - 1 === idxTgl) {
        c.font = { size: 10, italic: true, color: { argb: 'FF7A5B00' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } };
        c.note = d.tglIsi;
      }
    });
  });

  lebar.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(8, Math.min(48, w)); });
  ws.autoFilter = { from: { row: barisHeader, column: 1 }, to: { row: barisHeader, column: nCol } };
  return ws;
}

/**
 * @param rows     baris DB (snake_case), SUDAH terurut per minggu
 * @param layouts  Map "site|tab" → { header: string[], preamble: string[][] }
 * @param direction 'IN' | 'OUT'
 * @param contohTanggal Map "site|tab" → contoh sel tanggal dari seluruh tab (untuk meniru gaya penulisan tanggal)
 * @returns { buffer, sheets, standar, tanggalTerisi }
 *   standar = jumlah tab yang terpaksa memakai kolom standar · tanggalTerisi = jumlah tanggal kosong yang diisi dari minggu
 */
export async function buatXlsx({ rows, layouts, direction, contohTanggal = new Map() }) {
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
  let standar = 0, tanggalTerisi = 0;

  for (const [k, isi] of grup) {
    const { site, source_tab: tab } = isi[0];
    const nama = namaSheetAman(banyakSite ? `${site} ${tab}` : tab, dipakai);
    const layout = layouts.get(k);
    const lengkap = layout?.header?.length && isi.every((r) => Array.isArray(r.raw));

    let header, preamble, cellsPerBaris;
    if (lengkap) {
      header = layout.header; preamble = layout.preamble || []; cellsPerBaris = isi.map((r) => [...r.raw]);
    } else {
      standar++;
      const kolom = KOLOM_STANDAR[direction] || KOLOM_STANDAR.OUT;
      header = kolom.map(([h]) => h); preamble = []; cellsPerBaris = isi.map((r) => kolom.map(([, f]) => f(r)));
    }

    // Isi tanggal yang kosong dari nomor minggunya (format mengikuti sel tanggal lain di sheet ini).
    const idxTgl = header.findIndex((h) => norm(h) === 'tanggal');
    const data = isi.map((r, i) => ({ cells: cellsPerBaris[i], minggu: Number(r.minggu) || 0, tglIsi: '' }));
    if (idxTgl >= 0) {
      const fmt = deteksiFormatTanggal([...cellsPerBaris.map((c) => c[idxTgl]), ...(contohTanggal.get(k) || [])].filter((v) => !kosong(v)));
      data.forEach((d, i) => {
        const r = isi[i];
        if (!kosong(d.cells[idxTgl]) || !(Number(r.tahun) > 0) || !(Number(r.minggu) > 0)) return;
        const tgl = tanggalDariMinggu(Number(r.tahun), Number(r.minggu), Number(r.bulan) || 0);
        d.cells[idxTgl] = formatTanggal(tgl, fmt);
        d.tglIsi = `Tanggal kosong di sheet sumber — diisi otomatis dengan hari pertama Minggu ${r.minggu}${Number(r.bulan) ? ` pada bulan ${r.bulan}` : ''}.`;
        tanggalTerisi++;
      });
    }

    // Locale angka sheet ini ("4,080,000" = US, "4.080.000" = ID).
    const sampel = [];
    header.forEach((h, c) => {
      const n = norm(h);
      if (KOLOM_ANGKA.has(n)) data.forEach((d) => { if (typeof d.cells[c] === 'string') sampel.push(d.cells[c]); });
    });
    tulisSheet(wb, nama, { preamble, header, data, tab, idxTgl, lokal: deteksiLokal(sampel) });
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), sheets: grup.size, standar, tanggalTerisi };
}
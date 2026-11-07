// ── Menulis baris ke Google Spreadsheet (Google Sheets API v4, akun layanan) ───────────────────
//
// Membaca sheet tetap lewat CSV publik (googleFetch.js). Menulis butuh izin, jadi memakai AKUN LAYANAN
// (service account): buat sekali di Google Cloud, aktifkan "Google Sheets API", lalu BAGIKAN tiap spreadsheet
// ke email akun layanan itu sebagai "Editor". Tidak perlu OAuth per pengguna dan tidak ada dependensi baru
// (token ditandatangani dengan jsonwebtoken yang sudah ada).
//
// Env (salah satu cara):
//   GOOGLE_SERVICE_ACCOUNT_JSON     isi file JSON kunci akun layanan (satu baris)
//   GOOGLE_SERVICE_ACCOUNT_B64      isi file JSON yang di-base64 (aman untuk dashboard hosting)
//   GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY   email + private key (\n boleh ditulis sebagai teks "\n")
// Untuk uji: SHEETS_API_BASE_URL, GOOGLE_TOKEN_URL.
//
// Cara menambah baris (tambahBaris):
//   1. cari baris header & baris data terakhir di sheet (bukan dari data aplikasi — sheet adalah sumber kebenaran)
//   2. salin BARIS TERAKHIR ke baris baru (copyPaste) → format, border, dan RUMUS ikut (referensi otomatis menyesuaikan)
//   3. timpa hanya kolom yang BUKAN rumus dengan nilai baru (RAW: angka tetap angka, teks tetap teks)
//   4. baca ulang baris itu untuk memastikan tertulis benar
// Aman diulang: sebelum menulis, baris yang sama persis di 40 baris terakhir dikenali dan tidak digandakan.
import jwt from 'jsonwebtoken';

const API = () => (process.env.SHEETS_API_BASE_URL || 'https://sheets.googleapis.com').replace(/\/+$/, '');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const galat = (pesan, status = 502) => Object.assign(new Error(pesan), { status });

function kredensial() {
  let mentah = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!mentah && process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    try { mentah = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'); } catch { /* abaikan */ }
  }
  if (mentah) {
    try {
      const j = JSON.parse(mentah);
      if (j.client_email && j.private_key) return { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n'), tokenUri: j.token_uri || TOKEN_URL };
    } catch { /* JSON rusak → dianggap belum dikonfigurasi */ }
  }
  if (process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY) {
    return { email: process.env.GOOGLE_SA_EMAIL, key: String(process.env.GOOGLE_SA_PRIVATE_KEY).replace(/\\n/g, '\n'), tokenUri: TOKEN_URL };
  }
  return null;
}
export const sheetsTersambung = () => !!kredensial();
export const emailAkunLayanan = () => kredensial()?.email ?? null;

// ── Token ────────────────────────────────────────────────────────────────
let cacheToken = { token: null, habis: 0 };
async function ambilToken() {
  const k = kredensial();
  if (!k) throw galat('Penulisan ke Google Sheet belum diaktifkan (akun layanan Google belum dipasang di server).', 503);
  if (cacheToken.token && Date.now() < cacheToken.habis - 60_000) return cacheToken.token;
  const sekarang = Math.floor(Date.now() / 1000);
  const url = process.env.GOOGLE_TOKEN_URL || k.tokenUri;
  let assertion;
  try {
    assertion = jwt.sign({ iss: k.email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: url, iat: sekarang, exp: sekarang + 3600 }, k.key, { algorithm: 'RS256' });
  } catch { throw galat('Kunci akun layanan Google tidak valid (private key rusak).', 503); }
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => { throw galat(`Tidak bisa menghubungi Google (${e.message}).`, 502); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw galat(`Google menolak akun layanan: ${j.error_description || j.error || res.status}.`, 502);
  cacheToken = { token: j.access_token, habis: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cacheToken.token;
}

// ── Permintaan ke Sheets API (dengan ulang untuk 429/5xx) ──────────────────────────────
async function sheetsApi(jalur, { method = 'GET', query, body } = {}, percobaan = 0) {
  const token = await ambilToken();
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${API()}${jalur}${qs}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw galat(`Tidak bisa menghubungi Google Sheets (${e.message}).`, 502); });
  if ((res.status === 429 || res.status >= 500) && percobaan < 2) {
    await new Promise((r) => setTimeout(r, 800 * (percobaan + 1)));
    return sheetsApi(jalur, { method, query, body }, percobaan + 1);
  }
  const j = await res.json().catch(() => ({}));
  if (res.ok) return j;
  if (res.status === 401) cacheToken = { token: null, habis: 0 };
  const dari = j?.error?.message || `status ${res.status}`;
  if (res.status === 403) throw galat(`Akses ditolak Google. Bagikan spreadsheet ini ke ${emailAkunLayanan()} sebagai "Editor". (${dari})`, 403);
  if (res.status === 404) throw galat('Spreadsheet atau tab tidak ditemukan. Periksa link Sumber Sheet dan pastikan sudah dibagikan ke akun layanan.', 404);
  if (res.status === 400 && /not supported for this document/i.test(dari)) {
    throw galat('Spreadsheet ini masih berformat Excel (.xlsx) sehingga tidak bisa ditulis lewat API. Buka di Google Sheets lalu pilih File → Simpan sebagai Google Spreadsheet, kemudian atur ulang Sumber Sheet dengan link yang baru dan bagikan ke akun layanan.', 400);
  }
  throw galat(`Google Sheets: ${dari}`, res.status === 400 ? 400 : 502);
}

// ── Util A1 ──────────────────────────────────────────────────────────────
const huruf = (i) => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const kutip = (tab) => `'${String(tab).replace(/'/g, "''")}'`;
const normH = (h) => String(h ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
const blank = (v) => String(v ?? '').trim() === '';
export const serialDariIso = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000); };

async function nilai(sheetId, rentang, render = 'FORMATTED_VALUE') {
  const j = await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(rentang)}`, { query: { valueRenderOption: render, majorDimension: 'ROWS' } });
  return j.values || [];
}

async function infoTab(sheetId, tab) {
  const j = await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}`, { query: { fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))' } });
  const daftar = (j.sheets || []).map((s) => s.properties);
  const cocok = daftar.find((p) => p.title === tab) || daftar.find((p) => normH(p.title) === normH(tab));
  if (!cocok) throw galat(`Tab "${tab}" tidak ada di spreadsheet. Tab yang ada: ${daftar.map((p) => p.title).join(', ') || '(kosong)'}.`, 404);
  return { gid: cocok.sheetId, judul: cocok.title, baris: cocok.gridProperties?.rowCount ?? 1000 };
}

// ── Antrean per tab: dua penginput bersamaan tidak boleh memilih baris kosong yang sama ───────────────
const antrean = new Map();
const serial = (kunci, kerja) => {
  const sebelumnya = antrean.get(kunci) || Promise.resolve();
  const berikut = sebelumnya.catch(() => {}).then(kerja);
  antrean.set(kunci, berikut);
  berikut.finally(() => { if (antrean.get(kunci) === berikut) antrean.delete(kunci); }).catch(() => {});
  return berikut;
};

// ── Deteksi kolom rumus (untuk menampilkan "otomatis" di form) — di-cache 5 menit ───────────────────
const cacheRumus = new Map();
export async function deteksiKolomRumus({ sheetId, tab, nCol, idxNama }) {
  const kunci = `${sheetId}|${tab}|${nCol}`;
  const ada = cacheRumus.get(kunci);
  if (ada && Date.now() - ada.t < 300_000) return ada.v;
  const q = kutip(tab);
  const kolNama = huruf(idxNama);
  const kolom = await nilai(sheetId, `${q}!${kolNama}1:${kolNama}`, 'FORMATTED_VALUE');
  let terakhir = 0;
  kolom.forEach((r, i) => { if (!blank(r?.[0])) terakhir = i + 1; });
  let hasil = Array(nCol).fill(false);
  if (terakhir > 1) {
    const rumus = (await nilai(sheetId, `${q}!A${terakhir}:${huruf(nCol - 1)}${terakhir}`, 'FORMULA'))[0] || [];
    hasil = Array.from({ length: nCol }, (_, i) => typeof rumus[i] === 'string' && rumus[i].startsWith('='));
  }
  cacheRumus.set(kunci, { t: Date.now(), v: hasil });
  return hasil;
}

/**
 * @param sheetId   ID spreadsheet
 * @param tab       nama tab
 * @param header    header asli tab (dari layout tersimpan) — dipakai memastikan struktur sheet belum berubah
 * @param idxNama   indeks kolom "Nama Barang"
 * @param idxTanggal indeks kolom Tanggal (-1 bila tidak ada)
 * @param nilaiKolom array sepanjang kolom: angka | teks | undefined (kosongkan); untuk Tanggal berisi { iso, teks }
 * @param samaDengan (barisTerformat: string[]) => boolean — pengenal baris yang sama persis (agar kirim ulang tidak menggandakan)
 * @returns { baris, sudahAda, kolomRumus }
 */
export function tambahBaris({ sheetId, tab, header, idxNama, idxTanggal, nilaiKolom, samaDengan }) {
  return serial(`${sheetId}|${tab}`, async () => {
    const info = await infoTab(sheetId, tab);
    const q = kutip(info.judul);
    const nCol = header.length;
    const kolAkhir = huruf(nCol - 1);

    // 1) Header di sheet harus sama dengan header yang dipakai form (struktur belum berubah).
    const atas = await nilai(sheetId, `${q}!A1:${kolAkhir}25`);
    const idxHeader = atas.findIndex((r) => (r || []).some((c) => normH(c) === 'nama barang'));
    if (idxHeader < 0) throw galat('Baris header ("Nama Barang") tidak ditemukan di sheet. Klik "Sync Sekarang" lalu coba lagi.', 409);
    const barisHeader = idxHeader + 1;
    const beda = header.findIndex((h, i) => !blank(h) && normH(h) !== normH(atas[idxHeader]?.[i]));
    if (beda >= 0) throw galat(`Kolom sheet sudah berubah (kolom ${huruf(beda)}: "${header[beda]}" → "${atas[idxHeader]?.[beda] ?? ''}"). Klik "Sync Sekarang" supaya form mengikuti template terbaru.`, 409);

    // 2) Baris data terakhir = baris terakhir yang kolom "Nama Barang"-nya terisi.
    const kolNama = huruf(idxNama);
    const namaKol = await nilai(sheetId, `${q}!${kolNama}${barisHeader + 1}:${kolNama}`);
    let terakhir = barisHeader;
    namaKol.forEach((r, i) => { if (!blank(r?.[0])) terakhir = barisHeader + 1 + i; });

    // 3) Idempoten: baris yang sama persis di 40 baris terakhir tidak ditulis lagi.
    if (terakhir > barisHeader && samaDengan) {
      const dari = Math.max(barisHeader + 1, terakhir - 39);
      const akhir = await nilai(sheetId, `${q}!A${dari}:${kolAkhir}${terakhir}`);
      const i = akhir.findIndex((r) => samaDengan(r || []));
      if (i >= 0) return { baris: dari + i, sudahAda: true, kolomRumus: [] };
    }

    // 4) Pelajari baris terakhir: kolom mana yang rumus, dan apakah Tanggal berupa tanggal sungguhan.
    let kolomRumus = Array(nCol).fill(false), tanggalSerial = false;
    if (terakhir > barisHeader) {
      const r = `${q}!A${terakhir}:${kolAkhir}${terakhir}`;
      const rumus = (await nilai(sheetId, r, 'FORMULA'))[0] || [];
      const mentah = (await nilai(sheetId, r, 'UNFORMATTED_VALUE'))[0] || [];
      kolomRumus = Array.from({ length: nCol }, (_, i) => typeof rumus[i] === 'string' && rumus[i].startsWith('='));
      tanggalSerial = idxTanggal >= 0 && typeof mentah[idxTanggal] === 'number';
    }

    // 5) Siapkan baris baru: tambah baris grid bila perlu, salin format + rumus dari baris terakhir.
    const baru = terakhir + 1;
    const permintaan = [];
    if (baru > info.baris) permintaan.push({ appendDimension: { sheetId: info.gid, dimension: 'ROWS', length: baru - info.baris + 20 } });
    if (terakhir > barisHeader) {
      permintaan.push({ copyPaste: {
        source: { sheetId: info.gid, startRowIndex: terakhir - 1, endRowIndex: terakhir, startColumnIndex: 0, endColumnIndex: nCol },
        destination: { sheetId: info.gid, startRowIndex: baru - 1, endRowIndex: baru, startColumnIndex: 0, endColumnIndex: nCol },
        pasteType: 'PASTE_NORMAL',
      } });
    }
    if (permintaan.length) await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`, { method: 'POST', body: { requests: permintaan } });

    // 6) Timpa kolom yang bukan rumus (kolom rumus dibiarkan — dihitung sheet sendiri).
    const sel = Array.from({ length: nCol }, (_, i) => {
      if (kolomRumus[i]) return null;
      const v = nilaiKolom[i];
      if (i === idxTanggal && v && typeof v === 'object') return tanggalSerial ? serialDariIso(v.iso) : v.teks;
      return v === undefined || v === null ? '' : v;
    });
    const data = [];
    for (let i = 0; i < nCol;) {
      if (sel[i] === null) { i++; continue; }
      let j = i; while (j + 1 < nCol && sel[j + 1] !== null) j++;
      data.push({ range: `${q}!${huruf(i)}${baru}:${huruf(j)}${baru}`, values: [sel.slice(i, j + 1)] });
      i = j + 1;
    }
    await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data } });

    // 7) Baca ulang & pastikan yang tertulis memang baris kita.
    const cek = (await nilai(sheetId, `${q}!A${baru}:${kolAkhir}${baru}`))[0] || [];
    if (normH(cek[idxNama]) !== normH(String(nilaiKolom[idxNama] ?? ''))) {
      throw galat(`Baris ${baru} sheet tidak cocok setelah ditulis (kemungkinan ada yang mengedit bersamaan). Periksa sheet, lalu coba lagi.`, 409);
    }
    cacheRumus.delete(`${sheetId}|${tab}|${nCol}`);
    return { baris: baru, sudahAda: false, kolomRumus };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// UBAH & HAPUS baris yang sudah ada (CRUD lewat website)
//
// Nomor baris di DB bisa usang (orang lain menyisipkan/menghapus baris di sheet), jadi baris TIDAK dicari
// berdasarkan nomor saja: seluruh blok data dibaca sekali, lalu dicari baris yang isinya cocok dengan
// baris yang dilihat pengguna (callback `cocok`). Bila ada beberapa baris kembar, dipilih yang paling dekat
// dengan `petunjuk` (nomor baris terakhir yang diketahui). Tidak ketemu → galat 409 (jangan menimpa baris orang lain).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Validasi tab + header (struktur sheet belum berubah) → konteks kerja untuk ubah/hapus. */
async function siapkanKerja(sheetId, tab, header) {
  const info = await infoTab(sheetId, tab);
  const q = kutip(info.judul);
  const nCol = header.length;
  const kolAkhir = huruf(nCol - 1);
  const atas = await nilai(sheetId, `${q}!A1:${kolAkhir}25`);
  const idxHeader = atas.findIndex((r) => (r || []).some((c) => normH(c) === 'nama barang'));
  if (idxHeader < 0) throw galat('Baris header ("Nama Barang") tidak ditemukan di sheet. Klik "Sync Sekarang" lalu coba lagi.', 409);
  const beda = header.findIndex((h, i) => !blank(h) && normH(h) !== normH(atas[idxHeader]?.[i]));
  if (beda >= 0) throw galat(`Kolom sheet sudah berubah (kolom ${huruf(beda)}: "${header[beda]}" → "${atas[idxHeader]?.[beda] ?? ''}"). Klik "Sync Sekarang" supaya form mengikuti template terbaru.`, 409);
  return { info, q, nCol, kolAkhir, barisHeader: idxHeader + 1 };
}

// `cocok` boleh berupa satu fungsi atau daftar fungsi berurutan dari yang paling ketat ke paling longgar:
// tingkat pertama yang menemukan kandidat dipakai (pencocokan ketat dulu, longgar hanya bila ketat gagal).
async function cariBarisSheet(sheetId, ctx, { cocok, petunjuk }) {
  const blok = await nilai(sheetId, `${ctx.q}!A${ctx.barisHeader + 1}:${ctx.kolAkhir}`);
  for (const f of (Array.isArray(cocok) ? cocok : [cocok])) {
    const kandidat = [];
    blok.forEach((r, i) => { if (f(r || [])) kandidat.push(ctx.barisHeader + 1 + i); });
    if (!kandidat.length) continue;
    if (petunjuk) kandidat.sort((a, b) => Math.abs(a - petunjuk) - Math.abs(b - petunjuk));
    return kandidat[0];
  }
  return null;
}

const TIDAK_KETEMU = 'Baris ini tidak ditemukan lagi di sheet (kemungkinan sudah diubah atau dihapus langsung di sheet). Klik "Sync Sekarang", lalu coba lagi.';

/**
 * Menimpa satu baris. Hanya kolom milik form (`kolomKelola`) yang ditulis — kolom lain (mis. catatan tanpa header) dan
 * kolom RUMUS dibiarkan apa adanya.
 * @param kolomKelola Set indeks kolom yang boleh ditimpa
 * @param cocok       (barisTerformat: string[]) => boolean — pengenal baris lama
 * @param petunjuk    nomor baris terakhir yang diketahui (opsional)
 * @returns { baris }
 */
export function ubahBaris({ sheetId, tab, header, idxNama, idxTanggal, nilaiKolom, kolomKelola, cocok, petunjuk }) {
  return serial(`${sheetId}|${tab}`, async () => {
    const ctx = await siapkanKerja(sheetId, tab, header);
    const { q, nCol, kolAkhir } = ctx;
    const baris = await cariBarisSheet(sheetId, ctx, { cocok, petunjuk });
    if (!baris) throw galat(TIDAK_KETEMU, 409);

    const r = `${q}!A${baris}:${kolAkhir}${baris}`;
    const rumus = (await nilai(sheetId, r, 'FORMULA'))[0] || [];
    const mentah = (await nilai(sheetId, r, 'UNFORMATTED_VALUE'))[0] || [];
    const kolomRumus = Array.from({ length: nCol }, (_, i) => typeof rumus[i] === 'string' && rumus[i].startsWith('='));
    const tanggalSerial = idxTanggal >= 0 && typeof mentah[idxTanggal] === 'number';

    const sel = Array.from({ length: nCol }, (_, i) => {
      if (!kolomKelola.has(i) || kolomRumus[i]) return null;
      const v = nilaiKolom[i];
      if (i === idxTanggal && v && typeof v === 'object') return tanggalSerial ? serialDariIso(v.iso) : v.teks;
      return v === undefined || v === null ? '' : v;
    });
    const data = [];
    for (let i = 0; i < nCol;) {
      if (sel[i] === null) { i++; continue; }
      let j = i; while (j + 1 < nCol && sel[j + 1] !== null) j++;
      data.push({ range: `${q}!${huruf(i)}${baris}:${huruf(j)}${baris}`, values: [sel.slice(i, j + 1)] });
      i = j + 1;
    }
    if (data.length) await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data } });

    const cek = (await nilai(sheetId, r))[0] || [];
    if (normH(cek[idxNama]) !== normH(String(nilaiKolom[idxNama] ?? ''))) {
      throw galat(`Baris ${baris} sheet tidak cocok setelah ditulis (kemungkinan ada yang mengedit bersamaan). Periksa sheet, lalu coba lagi.`, 409);
    }
    cacheRumus.delete(`${sheetId}|${tab}|${nCol}`);
    return { baris };
  });
}

/**
 * Menghapus satu baris dari sheet (seperti klik kanan → Hapus baris: baris di bawahnya naik, rumus menyesuaikan).
 * Bila baris sudah tidak ada di sheet → { sudahTiada: true } (tujuannya tercapai, jadi bukan galat).
 */
export function hapusBaris({ sheetId, tab, header, cocok, petunjuk }) {
  return serial(`${sheetId}|${tab}`, async () => {
    const ctx = await siapkanKerja(sheetId, tab, header);
    const baris = await cariBarisSheet(sheetId, ctx, { cocok, petunjuk });
    if (!baris) return { baris: null, sudahTiada: true };
    if (baris <= ctx.barisHeader) throw galat('Baris header tidak boleh dihapus.', 409);
    await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`, {
      method: 'POST',
      body: { requests: [{ deleteDimension: { range: { sheetId: ctx.info.gid, dimension: 'ROWS', startIndex: baris - 1, endIndex: baris } } }] },
    });
    cacheRumus.delete(`${sheetId}|${tab}|${ctx.nCol}`);
    return { baris, sudahTiada: false };
  });
}

/**
 * Pemeriksaan koneksi bertahap (untuk panduan "Sambungkan Google Sheet" di website). Tidak pernah melempar galat:
 * setiap tahap berisi { ok, error }. Tahap berikutnya hanya diperiksa bila tahap sebelumnya lolos.
 */
export async function diagnosaSheet({ sheetId, tabs = [] }) {
  const h = {
    kredensial: { ok: sheetsTersambung(), email: emailAkunLayanan(), error: '' },
    token: { ok: false, error: '' },
    sheet: { ok: false, error: '', judul: '', status: 0 },
    tabs: [],
    tulis: { ok: false, error: '' },
  };
  if (!h.kredensial.ok) { h.kredensial.error = 'Variabel GOOGLE_SERVICE_ACCOUNT_B64 belum diisi (atau isinya bukan JSON kunci akun layanan yang valid).'; return h; }
  try { await ambilToken(); h.token.ok = true; } catch (e) { h.token.error = e.message; return h; }
  if (!sheetId) { h.sheet.error = 'Sumber Sheet untuk site ini belum diatur (tombol "Sumber Sheet" di halaman Laporan).'; return h; }
  let daftar = [];
  try {
    const j = await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}`, { query: { fields: 'properties.title,sheets.properties(sheetId,title)' } });
    h.sheet.ok = true; h.sheet.judul = j.properties?.title || '';
    daftar = (j.sheets || []).map((s) => s.properties);
  } catch (e) { h.sheet.error = e.message; h.sheet.status = e.status || 0; return h; }
  h.tabs = tabs.map((t) => ({ nama: t, ada: daftar.some((p) => p.title === t || normH(p.title) === normH(t)) }));
  try {
    // Uji izin Editor tanpa mengubah isi: menyimpan ulang judul spreadsheet dengan judul yang sama.
    await sheetsApi(`/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`, {
      method: 'POST', body: { requests: [{ updateSpreadsheetProperties: { properties: { title: h.sheet.judul }, fields: 'title' } }] },
    });
    h.tulis.ok = true;
  } catch (e) { h.tulis.error = e.message; }
  return h;
}
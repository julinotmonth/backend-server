// ── PICA: input manual & import template Excel ────────────────────────────
// Melengkapi pica.js (yang hanya menarik PICA dari Google Sheet). Tim inventory tiap site bisa
// mencatat isu langsung di aplikasi — satu per satu lewat form, atau banyak sekaligus lewat
// template Excel. Isu manual disimpan di tabel yang sama (pica_items) dengan origin = 'manual',
// sehingga tampil, terfilter, dan terbawa ke pencarian/notifikasi persis seperti isu dari sheet.
//
// Dua aturan yang menjaga data tetap utuh:
//   1. Sinkron Google Sheet hanya menyentuh baris origin = 'sheet' (lihat pica.js) — isu manual
//      tidak ikut terhapus saat sync berikutnya.
//   2. Isu asal sheet TIDAK boleh diubah dari aplikasi, sebab sync 5 menit berikutnya akan menimpanya
//      kembali. Edit/hapus/import pada isu itu ditolak dengan pesan yang jelas.

import express from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { parseTanggalPica, siteGuard, PicaItems } from './pica.js';
import { siteScope } from './siteAccess.js';
import { catatPerubahan, bandingkan } from './changeLog.js';

export const PICA_INPUT_SCHEMA = `
ALTER TABLE pica_items ADD COLUMN IF NOT EXISTS origin     TEXT NOT NULL DEFAULT 'sheet';
ALTER TABLE pica_items ADD COLUMN IF NOT EXISTS kategori   TEXT NOT NULL DEFAULT '';
ALTER TABLE pica_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE pica_items ADD COLUMN IF NOT EXISTS updated_by TEXT;
-- "No" jadi kunci isu manual (juga kunci import), jadi tidak boleh kembar dalam satu site.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pica_manual_no ON pica_items (site, lower(no)) WHERE origin = 'manual';
`;

// ── Nilai yang diizinkan ──────────────────────────────────────────────────
export const PICA_STATUS = ['On Going', 'Close', 'Overdue'];
export const PICA_KATEGORI = ['Spare Part', 'Safety Stock', 'Pengadaan / Vendor', 'Aset', 'Administrasi', 'Lainnya'];

const MAKS = { no: 20, problem: 500, identifikasi: 2000, deskripsi: 8000, pic: 120, catatan: 4000 };
const MAKS_BARIS_IMPOR = 1000;

// ── Pembersih & pemeriksa (murni — tanpa akses DB, mudah diuji) ────────────
const rapikan = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

export function normStatus(raw) {
  const s = rapikan(raw).toLowerCase();
  if (!s) return 'On Going';
  if (/^(close|closed|selesai|done|tutup|completed?)$/.test(s)) return 'Close';
  if (/^(overdue|terlambat|telat)$/.test(s)) return 'Overdue';
  if (/^(on ?going|ongoing|progress|in progress|berjalan|proses|open)$/.test(s)) return 'On Going';
  return null;
}

export function normKategori(raw) {
  const s = rapikan(raw).toLowerCase().replace(/\s*\/\s*/g, ' / ');
  if (!s) return '';
  return PICA_KATEGORI.find((k) => k.toLowerCase() === s) ?? null;
}

/** "Week 5" / "week05" / "W5" / "Minggu 5" / "5" → "Week 05". null kalau bukan minggu 1–53. */
export function normMinggu(raw) {
  const m = rapikan(raw).match(/^(?:week|minggu|mg|wk|w)?[\s._-]*0*(\d{1,2})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 53 ? `Week ${String(n).padStart(2, '0')}` : null;
}
export const nomorMinggu = (label) => Number(String(label).match(/(\d+)/)?.[1] ?? 0);

function tanggalValid(iso) {
  if (!iso) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Urutkan per nomor minggu, gabungkan label kembar (yang terakhir menang), buang catatan kosong. */
export function rapikanUpdates(daftar) {
  const peta = new Map();
  for (const u of daftar || []) {
    const week = normMinggu(u.week);
    const catatan = rapikan(u.catatan);
    if (week && catatan) peta.set(week, catatan);
  }
  return [...peta].map(([week, catatan]) => ({ week, catatan })).sort((a, b) => nomorMinggu(a.week) - nomorMinggu(b.week));
}

/** Catatan terbaru = minggu dengan nomor terbesar yang terisi (sama seperti kolom minggu terakhir di sheet). */
export function ringkasTerbaru(updates) {
  const t = updates[updates.length - 1];
  return t ? { latestWeek: t.week, latestNote: t.catatan } : { latestWeek: '', latestNote: '' };
}

/**
 * Memeriksa satu isu dari form/Excel. Mengembalikan { nilai, galat } — galat berisi SEMUA masalah sekaligus
 * (bukan berhenti di yang pertama) supaya pengguna bisa membereskan satu baris dalam sekali jalan.
 */
export function bersihkanIsu(input, { wajibNo = false } = {}) {
  const galat = [];
  const no = rapikan(input.no);
  const problem = rapikan(input.problem);
  const identifikasi = rapikan(input.identifikasi);
  const deskripsi = rapikan(input.deskripsi);
  const pic = rapikan(input.pic);
  const tanggal = parseTanggalPica(input.tanggal);
  const targetDate = rapikan(input.targetDate) ? parseTanggalPica(input.targetDate) : null;
  const status = normStatus(input.status);
  const kategori = normKategori(input.kategori);

  if (wajibNo && !no) galat.push('No wajib diisi.');
  if (no.length > MAKS.no) galat.push(`No maksimal ${MAKS.no} karakter.`);
  if (!problem) galat.push('Problem wajib diisi.');
  if (problem.length > MAKS.problem) galat.push(`Problem maksimal ${MAKS.problem} karakter — ringkas, detailnya taruh di Description.`);
  if (identifikasi.length > MAKS.identifikasi) galat.push(`Identification maksimal ${MAKS.identifikasi} karakter.`);
  if (deskripsi.length > MAKS.deskripsi) galat.push(`Description maksimal ${MAKS.deskripsi} karakter.`);
  if (pic.length > MAKS.pic) galat.push(`PIC maksimal ${MAKS.pic} karakter.`);
  if (!rapikan(input.tanggal)) galat.push('Date wajib diisi.');
  else if (!tanggalValid(tanggal)) galat.push(`Date “${rapikan(input.tanggal)}” tidak terbaca — gunakan format 17/05/2026 atau 17-Mei-2026.`);
  if (rapikan(input.targetDate) && !tanggalValid(targetDate)) galat.push(`Target Date “${rapikan(input.targetDate)}” tidak terbaca.`);
  if (tanggalValid(tanggal) && tanggalValid(targetDate) && targetDate < tanggal) galat.push('Target Date lebih awal dari Date.');
  if (status === null) galat.push(`Status “${rapikan(input.status)}” tidak dikenal — pilih ${PICA_STATUS.join(' / ')}.`);
  if (kategori === null) galat.push(`Kategori “${rapikan(input.kategori)}” tidak dikenal — pilih salah satu: ${PICA_KATEGORI.join(', ')}.`);

  const updates = [];
  for (const u of input.updates || []) {
    const catatan = rapikan(u.catatan);
    if (!catatan) continue;
    const week = normMinggu(u.week);
    if (!week) { galat.push(`Judul kolom minggu “${rapikan(u.week)}” tidak dikenal — tulis seperti “Week 46”.`); continue; }
    if (catatan.length > MAKS.catatan) galat.push(`Catatan ${week} maksimal ${MAKS.catatan} karakter.`);
    updates.push({ week, catatan });
  }

  return {
    galat,
    nilai: {
      no, tanggal: tanggal ?? null, problem, identifikasi, deskripsi, targetDate, pic,
      status: status ?? 'On Going', kategori: kategori ?? '', updates: rapikanUpdates(updates),
    },
  };
}

/** Nomor urut berikutnya: angka terbesar yang sudah dipakai di site ini + 1 (nomor non-angka diabaikan). */
export function nomorBerikut(daftarNo) {
  let maks = 0;
  for (const n of daftarNo) if (/^\d+$/.test(String(n).trim())) maks = Math.max(maks, Number(n));
  return String(maks + 1);
}

const sama = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Rencana import: tiap baris Excel → baru / ubah / sama / ditolak. Tidak menyentuh DB — dipakai untuk
 * pratinjau (simulasi) sekaligus untuk eksekusi sungguhan, jadi yang dilihat pengguna = yang terjadi.
 *
 * @param rows      [{ baris, no, tanggal, problem, ... , updates }]  (baris = nomor baris di Excel)
 * @param existing  isu yang sudah ada di site: [{ id, no, origin, tanggal, problem, ..., updates }]
 */
export function rencanaImport(rows, existing) {
  const perNo = new Map(existing.map((e) => [String(e.no).toLowerCase(), e]));
  // Baris tanpa No yang tanggal + problem-nya sama dengan isu manual yang sudah ada dianggap isu itu juga,
  // supaya mengimpor ulang file yang sama tidak menggandakan isu.
  const kunciIsu = (x) => `${x.tanggal ? String(x.tanggal).slice(0, 10) : ''}|${String(x.problem).toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const perIsu = new Map(existing.filter((e) => e.origin === 'manual').map((e) => [kunciIsu(e), e]));
  const dipakai = new Set(perNo.keys());
  const noDiFile = new Set();
  const hasil = [];
  const antrean = []; // baris tanpa No → diberi nomor setelah nomor eksplisit semuanya diketahui

  for (const r of rows) {
    const { galat, nilai } = bersihkanIsu(r);
    if (!galat.length && !nilai.no) {
      const kembar = perIsu.get(kunciIsu(nilai));
      if (kembar && !noDiFile.has(String(kembar.no).toLowerCase())) nilai.no = kembar.no;
    }
    const kunci = nilai.no.toLowerCase();
    if (galat.length) { hasil.push({ baris: r.baris, no: nilai.no, aksi: 'ditolak', pesan: galat.join(' ') }); continue; }
    if (kunci) {
      if (noDiFile.has(kunci)) { hasil.push({ baris: r.baris, no: nilai.no, aksi: 'ditolak', pesan: `No ${nilai.no} muncul lebih dari sekali di file ini.` }); continue; }
      noDiFile.add(kunci);
      dipakai.add(kunci);
      const ada = perNo.get(kunci);
      if (ada?.origin === 'sheet') {
        hasil.push({ baris: r.baris, no: nilai.no, aksi: 'ditolak', pesan: `No ${nilai.no} berasal dari Google Sheet — ubah di sheet-nya, atau pakai No lain untuk isu baru.` });
        continue;
      }
      if (ada) {
        // Minggu yang tidak ada di file dibiarkan apa adanya; minggu yang ada di file menimpa.
        const gabung = rapikanUpdates([...ada.updates, ...nilai.updates]);
        const baru = { ...nilai, updates: gabung };
        const lama = { ...pilihBanding(ada), updates: rapikanUpdates(ada.updates) };
        hasil.push(sama(pilihBanding(baru), pilihBanding(lama)) && sama(gabung, lama.updates)
          ? { baris: r.baris, no: nilai.no, aksi: 'sama' }
          : { baris: r.baris, no: nilai.no, aksi: 'ubah', id: ada.id, data: baru, lama: ada });
        continue;
      }
      hasil.push({ baris: r.baris, no: nilai.no, aksi: 'baru', data: nilai });
    } else {
      const h = { baris: r.baris, no: '', aksi: 'baru', data: nilai };
      hasil.push(h); antrean.push(h);
    }
  }
  let berikut = Number(nomorBerikut([...dipakai]));
  for (const h of antrean) {
    while (dipakai.has(String(berikut))) berikut++;
    h.no = h.data.no = String(berikut);
    dipakai.add(h.no);
    berikut++;
  }
  hasil.sort((a, b) => a.baris - b.baris);
  return hasil;
}

const pilihBanding = (x) => ({
  tanggal: x.tanggal ? String(x.tanggal).slice(0, 10) : null, problem: x.problem, identifikasi: x.identifikasi,
  deskripsi: x.deskripsi, targetDate: (x.targetDate ?? x.target_date) ? String(x.targetDate ?? x.target_date).slice(0, 10) : null,
  pic: x.pic, status: x.status, kategori: x.kategori ?? '',
});

// ── DB ────────────────────────────────────────────────────────────────────
const idBaru = () => `pica-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const namaIsu = (no, problem) => (no ? `${no}. ${problem}` : problem);

const KOLOM_UBAH = [
  { lama: 'problem', baru: 'problem', label: 'Problem' },
  { lama: 'tanggal', baru: 'tanggal', label: 'Date', tipe: 'tanggal' },
  { lama: 'status', baru: 'status', label: 'Status' },
  { lama: 'pic', baru: 'pic', label: 'PIC' },
  { lama: 'target_date', baru: 'targetDate', label: 'Target date', tipe: 'tanggal' },
  { lama: 'kategori', baru: 'kategori', label: 'Kategori' },
  { lama: 'latest_week', baru: 'latestWeek', label: 'Update minggu' },
  { lama: 'latest_note', baru: 'latestNote', label: 'Catatan terbaru' },
  { lama: 'identifikasi', baru: 'identifikasi', label: 'Identification', ringkas: true },
  { lama: 'deskripsi', baru: 'deskripsi', label: 'Description', ringkas: true },
];

const KOLOM_SELECT = `id, site, no, tanggal, problem, identifikasi, deskripsi, target_date, pic, status, kategori,
  updates, latest_week, latest_note, origin`;

const keBentukApi = (r) => ({
  id: r.id, site: r.site, no: r.no, tanggal: r.tanggal, problem: r.problem, identifikasi: r.identifikasi,
  deskripsi: r.deskripsi, targetDate: r.target_date, pic: r.pic, status: r.status, kategori: r.kategori,
  updates: r.updates, latestWeek: r.latest_week, latestNote: r.latest_note, origin: r.origin,
});

async function ambilIsu(id) {
  const { rows } = await query(`SELECT ${KOLOM_SELECT} FROM pica_items WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

function pastikanManual(it) {
  if (!it) throw Object.assign(new Error('Isu tidak ditemukan.'), { status: 404 });
  if (it.origin !== 'manual') {
    throw Object.assign(new Error('Isu ini berasal dari Google Sheet, jadi diubah di sheet-nya (sync akan menimpa perubahan dari aplikasi).'), { status: 409 });
  }
}

const dupNo = (err) => err?.code === '23505'
  ? Object.assign(new Error('No ini sudah dipakai isu lain di site ini.'), { status: 409 })
  : err;

async function sisipIsu(exec, site, d, oleh) {
  const id = idBaru();
  const t = ringkasTerbaru(d.updates);
  await exec(
    `INSERT INTO pica_items
       (id, site, row_hash, no, tanggal, problem, identifikasi, deskripsi, target_date, pic, status, kategori,
        updates, latest_week, latest_note, origin, imported_by, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'manual',$16,NOW(),$16)`,
    [id, site, `manual:${id}`, d.no, d.tanggal, d.problem, d.identifikasi, d.deskripsi, d.targetDate, d.pic, d.status,
     d.kategori, JSON.stringify(d.updates), t.latestWeek, t.latestNote, oleh]);
  return id;
}

async function ubahIsu(exec, id, d, oleh) {
  const t = ringkasTerbaru(d.updates);
  await exec(
    `UPDATE pica_items SET tanggal=$2, problem=$3, identifikasi=$4, deskripsi=$5, target_date=$6, pic=$7, status=$8,
            kategori=$9, updates=$10, latest_week=$11, latest_note=$12, updated_at=NOW(), updated_by=$13
      WHERE id = $1 AND origin = 'manual'`,
    [id, d.tanggal, d.problem, d.identifikasi, d.deskripsi, d.targetDate, d.pic, d.status, d.kategori,
     JSON.stringify(d.updates), t.latestWeek, t.latestNote, oleh]);
}

const bentukLama = (it) => ({ ...it, target_date: it.target_date, latest_week: it.latest_week, latest_note: it.latest_note });
const bentukBaru = (d) => ({ ...d, ...ringkasTerbaru(d.updates) });

// ── Router ────────────────────────────────────────────────────────────────
export function picaInputRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const galatBadRequest = (res, galat) => res.status(400).json({ error: galat.join(' '), galat });

  // Semua isu dari semua site sekaligus — tampilan "Semua Site". Hanya akun yang tidak dibatasi ke satu site
  // (Super Admin / global); akun site biasa memakai /pica?site=… untuk site-nya sendiri.
  r.get('/pica/semua', requireAuth, wrap(async (req, res) => {
    if (siteScope(req.auth)) return res.status(403).json({ error: 'Tampilan semua site hanya untuk Super Admin.' });
    res.json(await PicaItems.list(null));
  }));

  // Tambah isu
  r.post('/pica/items', requireAuth, wrap(async (req, res) => {
    const site = String(req.body?.site || '').trim();
    if (!site) return res.status(400).json({ error: 'Site wajib diisi.' });
    siteGuard(req, site);
    const { galat, nilai } = bersihkanIsu(req.body);
    if (galat.length) return galatBadRequest(res, galat);
    if (!nilai.no) {
      const { rows } = await query('SELECT no FROM pica_items WHERE site = $1', [site]);
      nilai.no = nomorBerikut(rows.map((x) => x.no));
    }
    let id;
    try { id = await sisipIsu(query, site, nilai, req.auth.email); } catch (e) { throw dupNo(e); }
    await catatPerubahan({ site, area: 'PICA', sumber: req.auth.email, baru: [{ pic: nilai.pic, nama: namaIsu(nilai.no, nilai.problem), ket: nilai.status }] });
    res.status(201).json(keBentukApi(await ambilIsu(id)));
  }));

  // Ubah isu (No tidak berubah — itu kunci import)
  r.patch('/pica/items/:id', requireAuth, wrap(async (req, res) => {
    const it = await ambilIsu(req.params.id);
    pastikanManual(it);
    siteGuard(req, it.site);
    const { galat, nilai } = bersihkanIsu({ ...req.body, no: it.no, updates: it.updates });
    if (galat.length) return galatBadRequest(res, galat);
    await ubahIsu(query, it.id, nilai, req.auth.email);
    const perubahan = bandingkan(bentukLama(it), bentukBaru(nilai), KOLOM_UBAH);
    if (perubahan.length) {
      await catatPerubahan({ site: it.site, area: 'PICA', sumber: req.auth.email,
        ubah: [{ pic: nilai.pic || it.pic, nama: namaIsu(it.no, nilai.problem), ket: nilai.status, perubahan }] });
    }
    res.json(keBentukApi(await ambilIsu(it.id)));
  }));

  // Catatan mingguan: tambah / timpa / (catatan kosong) hapus satu minggu
  r.post('/pica/items/:id/minggu', requireAuth, wrap(async (req, res) => {
    const it = await ambilIsu(req.params.id);
    pastikanManual(it);
    siteGuard(req, it.site);
    const week = normMinggu(req.body?.week);
    if (!week) return res.status(400).json({ error: 'Minggu tidak dikenal — pilih antara Week 01 dan Week 53.' });
    const catatan = rapikan(req.body?.catatan);
    if (catatan.length > MAKS.catatan) return res.status(400).json({ error: `Catatan maksimal ${MAKS.catatan} karakter.` });
    const lamaCatatan = (it.updates || []).find((u) => normMinggu(u.week) === week)?.catatan ?? '';
    const updates = rapikanUpdates([...(it.updates || []).filter((u) => normMinggu(u.week) !== week), ...(catatan ? [{ week, catatan }] : [])]);
    // Status bisa ikut diperbarui dalam satu langkah (mis. catatan "sudah selesai" → Close).
    const status = req.body?.status === undefined ? it.status : normStatus(req.body.status);
    if (status === null) return res.status(400).json({ error: `Status tidak dikenal — pilih ${PICA_STATUS.join(' / ')}.` });
    const t = ringkasTerbaru(updates);
    await query(
      `UPDATE pica_items SET updates=$2, latest_week=$3, latest_note=$4, status=$5, updated_at=NOW(), updated_by=$6 WHERE id=$1 AND origin='manual'`,
      [it.id, JSON.stringify(updates), t.latestWeek, t.latestNote, status, req.auth.email]);
    const perubahan = [
      ...(catatan !== lamaCatatan ? [{ kolom: `Update ${week}`, dari: lamaCatatan ? 'ada catatan' : '', ke: catatan ? 'diperbarui' : 'dihapus' }] : []),
      ...(status !== it.status ? [{ kolom: 'Status', dari: it.status, ke: status }] : []),
    ];
    if (perubahan.length) {
      await catatPerubahan({ site: it.site, area: 'PICA', sumber: req.auth.email,
        ubah: [{ pic: it.pic, nama: namaIsu(it.no, it.problem), ket: status, perubahan }] });
    }
    res.json(keBentukApi(await ambilIsu(it.id)));
  }));

  // Import dari template Excel. simulasi=true → hanya hitung & laporkan, tidak menulis apa pun.
  r.post('/pica/import', requireAuth, wrap(async (req, res) => {
    const site = String(req.body?.site || '').trim();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!site || !rows) return res.status(400).json({ error: 'Site dan isi file wajib ada.' });
    siteGuard(req, site);
    if (!rows.length) return res.status(400).json({ error: 'File tidak berisi baris isu. Isi minimal kolom Date dan Problem.' });
    if (rows.length > MAKS_BARIS_IMPOR) return res.status(400).json({ error: `Maksimal ${MAKS_BARIS_IMPOR} baris per import — bagi file menjadi beberapa bagian.` });

    const { rows: ada } = await query(`SELECT ${KOLOM_SELECT} FROM pica_items WHERE site = $1`, [site]);
    const rencana = rencanaImport(rows.map((x, i) => ({ baris: Number(x.baris) || i + 1, ...x })), ada);
    const hitung = (a) => rencana.filter((x) => x.aksi === a).length;
    const ringkas = { baru: hitung('baru'), ubah: hitung('ubah'), sama: hitung('sama'), ditolak: hitung('ditolak') };
    const laporan = rencana.map(({ baris, no, aksi, pesan }) => ({ baris, no, aksi, ...(pesan ? { pesan } : {}) }));

    if (req.body?.simulasi) return res.json({ simulasi: true, ...ringkas, baris: laporan });
    // Semua-atau-tidak-sama-sekali untuk baris yang valid: gagal di tengah tidak meninggalkan setengah import.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const exec = (sql, p) => c.query(sql, p);
      for (const x of rencana) {
        if (x.aksi === 'baru') await sisipIsu(exec, site, x.data, req.auth.email);
        else if (x.aksi === 'ubah') await ubahIsu(exec, x.id, x.data, req.auth.email);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw dupNo(e);
    } finally {
      c.release();
    }
    await catatPerubahan({
      site, area: 'PICA', sumber: req.auth.email,
      baru: rencana.filter((x) => x.aksi === 'baru').map((x) => ({ pic: x.data.pic, nama: namaIsu(x.no, x.data.problem), ket: x.data.status })),
      ubah: rencana.filter((x) => x.aksi === 'ubah').map((x) => ({
        pic: x.data.pic || x.lama.pic, nama: namaIsu(x.no, x.data.problem), ket: x.data.status,
        perubahan: bandingkan(bentukLama(x.lama), bentukBaru(x.data), KOLOM_UBAH),
      })).filter((u) => u.perubahan.length),
    });
    res.json({ simulasi: false, ...ringkas, baris: laporan });
  }));

  return r;
}
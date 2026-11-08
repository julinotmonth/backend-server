// Arsip dokumen Good Receipt (GR) per site — RDA (Mother Station), RCE (Workshop), RET.
//
// • Satu berkas PDF = satu baris di tabel gr_documents (isi PDF disimpan di kolom BYTEA, jadi ikut ter-backup
//   bersama database dan tidak hilang saat container hosting di-deploy ulang).
// • Anti-duplikat otomatis:
//     1. ISI yang sama persis (SHA-256)           → ditolak, di semua site  (berkas yang sama diganti namanya pun ketahuan)
//     2. NAMA berkas yang sama di site yang sama   → ditolak                 ("GR ... (1).pdf" dianggap sama dengan "GR ....pdf")
//     3. NOMOR PO yang sama tetapi isi berbeda     → peringatan, boleh dilanjutkan (penerimaan parsial memang bisa punya >1 GR)
// • Hak akses: pengguna hanya melihat/mengunggah GR site-nya sendiri; Super Admin (dan akun site "global") melihat dan
//   mengunggah untuk semua site. Hapus/ubah: Super Admin atau pengunggahnya sendiri.
import crypto from 'node:crypto';
import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

export const GOOD_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS gr_documents (
  id               BIGSERIAL PRIMARY KEY,
  site             TEXT        NOT NULL,
  entitas          TEXT        NOT NULL DEFAULT 'UMUM',      -- RDA | RCE | RET | UMUM
  nomor            TEXT        NOT NULL DEFAULT '',          -- nomor PO/GR yang terbaca dari nama berkas, mis. PO-RDA-2026-0781
  judul            TEXT        NOT NULL DEFAULT '',          -- sisa nama berkas (deskripsi pengadaan)
  nama_file        TEXT        NOT NULL,
  nama_norm        TEXT        NOT NULL,                     -- nama berkas yang dinormalkan (untuk deteksi duplikat)
  ukuran           INTEGER     NOT NULL,
  sha256           TEXT        NOT NULL,
  konten           BYTEA       NOT NULL,
  catatan          TEXT        NOT NULL DEFAULT '',
  diunggah_oleh    TEXT        NOT NULL DEFAULT '',
  email_pengunggah TEXT        NOT NULL DEFAULT '',
  diunggah_pada    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tanggal_file     DATE
);
CREATE UNIQUE INDEX IF NOT EXISTS gr_uq_sha  ON gr_documents (sha256);
CREATE UNIQUE INDEX IF NOT EXISTS gr_uq_nama ON gr_documents (site, nama_norm);
CREATE INDEX        IF NOT EXISTS gr_idx_site  ON gr_documents (site, entitas, diunggah_pada DESC);
CREATE INDEX        IF NOT EXISTS gr_idx_nomor ON gr_documents (site, nomor);
`;

const ENTITAS = ['RDA', 'RCE', 'RET', 'UMUM'];
const BATAS_BYTE = 15 * 1024 * 1024;
const galat = (pesan, status = 400, ekstra = {}) => Object.assign(new Error(pesan), { status }, ekstra);

// ── Membaca informasi dari nama berkas ─────────────────────────────────────
/** "GR PO-RDA-2026-0781 terkait Pengadaan ... .pdf" → { nomor, entitas, judul, norm } */
export function bacaNamaFile(nama) {
  const tanpaExt = String(nama || '').replace(/\.pdf$/i, '').trim();
  const spasi = (s) => s.replace(/[_\s]+/g, ' ').trim();
  const dasar = spasi(tanpaExt);
  let nomor = '', entitas = 'UMUM', sisa = dasar;
  let m = /\bPO[-\s]?(RDA|RCE|RET)[-\s]?(\d{4})[-\s]?(\d{3,5})\b/i.exec(dasar);
  if (m) { nomor = `PO-${m[1].toUpperCase()}-${m[2]}-${m[3]}`; entitas = m[1].toUpperCase(); sisa = dasar.replace(m[0], ' '); }
  else if ((m = /\bGR[-\s]+(RDA|RCE|RET)[-\s]*(\d{3,5})\b/i.exec(dasar))) { nomor = `GR-${m[1].toUpperCase()}-${m[2]}`; entitas = m[1].toUpperCase(); sisa = dasar.replace(m[0], ' '); }
  else if ((m = /\b(RDA|RCE|RET)\b/i.exec(dasar))) entitas = m[1].toUpperCase();
  const judul = spasi(sisa.replace(/^\s*GR\b/i, ' ').replace(/\bterkait\b/i, ' ')).slice(0, 300);
  // Normalisasi untuk deteksi duplikat: huruf kecil, tanpa penanda salinan "(1)", "- copy", "salinan".
  const norm = dasar.toLowerCase().replace(/\s*\(\d+\)\s*$/, '').replace(/\s*[-–]\s*(copy|salinan)\s*$/, '').replace(/\s+/g, ' ').trim();
  return { nomor, entitas, judul, norm };
}

const siteGuard = (req, site) => {
  const mine = req.auth.assignedSite;
  if (req.auth.role === 'Super Admin' || mine === 'global' || !mine) return;
  if (site && site !== mine) throw galat(`Anda hanya bisa mengelola dokumen GR Site ${String(mine).toUpperCase()}.`, 403);
};
const semuaSite = (req) => req.auth.role === 'Super Admin' || req.auth.assignedSite === 'global' || !req.auth.assignedSite;
const boleh = (req, row) => req.auth.role === 'Super Admin' || (!!row.email_pengunggah && row.email_pengunggah === req.auth.email);

const rapi = (r, req) => ({
  id: String(r.id), site: r.site, entitas: r.entitas, nomor: r.nomor, judul: r.judul, namaFile: r.nama_file, ukuran: r.ukuran,
  catatan: r.catatan, diunggahOleh: r.diunggah_oleh, diunggahPada: r.diunggah_pada, tanggalFile: r.tanggal_file ? String(r.tanggal_file).slice(0, 10) : null,
  bisaUbah: boleh(req, r),
});
const KOLOM = 'id, site, entitas, nomor, judul, nama_file, ukuran, catatan, diunggah_oleh, email_pengunggah, diunggah_pada, tanggal_file';

async function pastikanSite(site) {
  if (!site) throw galat('Pilih site tujuan.', 400);
  const { rows } = await query('SELECT 1 FROM sites WHERE key = $1', [site]);
  if (!rows.length) throw galat(`Site "${site}" tidak dikenal.`, 400);
}

/** Cek duplikat (tanpa menulis). `sha` boleh kosong (belum dihitung). */
async function periksa({ site, nama, sha }) {
  const info = bacaNamaFile(nama);
  const ringkas = (r, sebab) => ({ id: String(r.id), site: r.site, namaFile: r.nama_file, oleh: r.diunggah_oleh, pada: r.diunggah_pada, sebab });
  if (sha) {
    const { rows } = await query(`SELECT ${KOLOM} FROM gr_documents WHERE sha256 = $1 LIMIT 1`, [sha]);
    if (rows.length) return { ...info, status: 'duplikat', duplikat: ringkas(rows[0], 'isi') };
  }
  const { rows: sama } = await query(`SELECT ${KOLOM} FROM gr_documents WHERE site = $1 AND nama_norm = $2 LIMIT 1`, [site, info.norm]);
  if (sama.length) return { ...info, status: 'duplikat', duplikat: ringkas(sama[0], 'nama') };
  if (info.nomor) {
    const { rows } = await query(`SELECT ${KOLOM} FROM gr_documents WHERE site = $1 AND nomor = $2 ORDER BY diunggah_pada DESC LIMIT 5`, [site, info.nomor]);
    if (rows.length) return { ...info, status: 'po-sama', poSama: rows.map((r) => ringkas(r, 'nomor')) };
  }
  return { ...info, status: 'siap' };
}

export function goodReceiptRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const jawabGalat = (res, err) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, konflik: err.konflik, duplikat: err.duplikat, poSama: err.poSama });
    throw err;
  };

  // Daftar + pencarian + ringkasan
  r.get('/gr', requireAuth, wrap(async (req, res) => {
    const minta = String(req.query.site || '').trim();
    let site = minta && minta !== 'semua' ? minta : '';
    if (!semuaSite(req)) site = req.auth.assignedSite;           // pengguna site: selalu dikunci ke site-nya
    else if (site) siteGuard(req, site);
    const entitas = ENTITAS.includes(String(req.query.entitas)) ? String(req.query.entitas) : '';
    const qs = String(req.query.q || '').trim().slice(0, 80);
    const batas = Math.min(100, Math.max(5, Number(req.query.batas) || 20));
    const halaman = Math.max(1, Number(req.query.halaman) || 1);
    const urut = { baru: 'diunggah_pada DESC', lama: 'diunggah_pada ASC', nomor: 'nomor ASC, diunggah_pada DESC', nama: 'nama_file ASC' }[String(req.query.urut)] || 'diunggah_pada DESC';

    const p = [], where = [];
    const tambah = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (site) tambah('site = ?', site);
    if (entitas) tambah('entitas = ?', entitas);
    if (qs) {
      p.push(`%${qs.replace(/[\\%_]/g, '\\$&')}%`);
      const n = p.length;
      where.push(`(nama_file ILIKE $${n} OR nomor ILIKE $${n} OR judul ILIKE $${n} OR catatan ILIKE $${n} OR diunggah_oleh ILIKE $${n})`);
    }
    const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: [{ n: total }] } = await query(`SELECT COUNT(*)::int AS n FROM gr_documents ${W}`, p);
    const { rows } = await query(`SELECT ${KOLOM} FROM gr_documents ${W} ORDER BY ${urut}, id DESC LIMIT ${batas} OFFSET ${(halaman - 1) * batas}`, p);

    // Ringkasan (mengikuti pembatasan site, tidak mengikuti pencarian/saringan lain)
    const ps = site ? [site] : [];
    const Ws = site ? 'WHERE site = $1' : '';
    const { rows: perE } = await query(`SELECT entitas, COUNT(*)::int AS n FROM gr_documents ${Ws} GROUP BY entitas`, ps);
    const { rows: perS } = await query(`SELECT site, COUNT(*)::int AS n FROM gr_documents ${Ws} GROUP BY site ORDER BY site`, ps);
    res.json({
      total, halaman, batas, bisaPilihSite: semuaSite(req), siteAktif: site || null,
      ringkas: { total: perE.reduce((a, x) => a + x.n, 0), perEntitas: Object.fromEntries(perE.map((x) => [x.entitas, x.n])), perSite: perS },
      baris: rows.map((x) => rapi(x, req)),
    });
  }));

  // Pra-periksa banyak berkas sekaligus (sebelum diunggah): ditandai Siap / Sudah ada / PO sama.
  r.post('/gr/cek', requireAuth, wrap(async (req, res) => {
    try {
      const site = String(req.body?.site || '').trim();
      siteGuard(req, site); await pastikanSite(site);
      const daftar = Array.isArray(req.body?.berkas) ? req.body.berkas.slice(0, 60) : [];
      const hasil = [];
      for (const b of daftar) {
        const sha = /^[0-9a-f]{64}$/i.test(String(b?.sha256 || '')) ? String(b.sha256).toLowerCase() : '';
        hasil.push({ kunci: String(b?.kunci ?? b?.nama ?? ''), ...(await periksa({ site, nama: String(b?.nama || ''), sha })) });
      }
      res.json({ hasil });
    } catch (err) { jawabGalat(res, err); }
  }));

  // Unggah SATU berkas PDF (badan permintaan = byte PDF mentah; metadata lewat query string).
  r.post('/gr/upload', requireAuth, express.raw({ type: () => true, limit: BATAS_BYTE }), wrap(async (req, res) => {
    try {
      const site = String(req.query.site || '').trim();
      siteGuard(req, site); await pastikanSite(site);
      const nama = String(req.query.nama || '').trim().slice(0, 250);
      if (!nama || !/\.pdf$/i.test(nama)) throw galat('Hanya berkas PDF (.pdf) yang bisa diunggah.', 415);
      const isi = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!isi.length) throw galat('Berkas kosong atau tidak terbaca.', 400);
      if (isi.length > BATAS_BYTE) throw galat('Ukuran berkas maksimal 15 MB.', 413);
      if (isi.subarray(0, 5).toString('latin1') !== '%PDF-') throw galat('Isi berkas bukan PDF yang valid.', 415);

      const sha = crypto.createHash('sha256').update(isi).digest('hex');
      const info = bacaNamaFile(nama);
      const cek = await periksa({ site, nama, sha });
      if (cek.status === 'duplikat') {
        const d = cek.duplikat;
        throw galat(d.sebab === 'isi'
          ? `Berkas ini sudah pernah diunggah (${d.namaFile}) oleh ${d.oleh || 'pengguna lain'} pada ${new Date(d.pada).toLocaleDateString('id-ID')} — site ${String(d.site).toUpperCase()}.`
          : `Berkas dengan nama yang sama sudah ada di site ini (diunggah oleh ${d.oleh || 'pengguna lain'} pada ${new Date(d.pada).toLocaleDateString('id-ID')}).`,
        409, { konflik: 'duplikat', duplikat: d });
      }
      const abaikan = String(req.query.abaikan || '').split(',');
      if (cek.status === 'po-sama' && !abaikan.includes('po')) {
        throw galat(`Sudah ada ${cek.poSama.length} GR untuk ${info.nomor} di site ini. Lanjutkan bila ini penerimaan parsial/GR berbeda.`, 409, { konflik: 'po-sama', poSama: cek.poSama });
      }

      const entitas = ENTITAS.includes(String(req.query.entitas)) ? String(req.query.entitas) : info.entitas;
      const nomor = String(req.query.nomor || '').trim().slice(0, 60) || info.nomor;
      const tglFile = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.tanggalFile || '')) ? String(req.query.tanggalFile) : null;
      const { rows: [u] } = await query('SELECT name FROM users WHERE id = $1', [req.auth.sub]);
      let baris;
      try {
        ({ rows: [baris] } = await query(
          `INSERT INTO gr_documents (site, entitas, nomor, judul, nama_file, nama_norm, ukuran, sha256, konten, catatan, diunggah_oleh, email_pengunggah, tanggal_file)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${KOLOM}`,
          [site, entitas, nomor, info.judul, nama, info.norm, isi.length, sha, isi, String(req.query.catatan || '').slice(0, 500), u?.name || req.auth.email, req.auth.email, tglFile]));
      } catch (e) {
        if (e.code === '23505') throw galat('Berkas ini sudah ada di arsip GR (diunggah bersamaan oleh orang lain).', 409, { konflik: 'duplikat' });
        throw e;
      }
      res.status(201).json(rapi(baris, req));
    } catch (err) { jawabGalat(res, err); }
  }));

  async function muatBaris(req, kolom = KOLOM) {
    const { rows } = await query(`SELECT ${kolom} FROM gr_documents WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw galat('Dokumen GR tidak ditemukan (mungkin sudah dihapus).', 404);
    siteGuard(req, rows[0].site);
    return rows[0];
  }

  // Berkas PDF (inline untuk pratinjau, ?unduh=1 untuk mengunduh)
  r.get('/gr/:id/berkas', requireAuth, wrap(async (req, res) => {
    try {
      const b = await muatBaris(req, `${KOLOM}, konten`);
      const nama = encodeURIComponent(b.nama_file).replace(/['()]/g, escape);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(b.konten.length));
      res.setHeader('Content-Disposition', `${req.query.unduh ? 'attachment' : 'inline'}; filename*=UTF-8''${nama}`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.end(b.konten);
    } catch (err) { jawabGalat(res, err); }
  }));

  // Ubah entitas / nomor / catatan
  r.patch('/gr/:id', requireAuth, wrap(async (req, res) => {
    try {
      const b = await muatBaris(req);
      if (!boleh(req, b)) throw galat('Hanya Super Admin atau pengunggahnya yang bisa mengubah dokumen ini.', 403);
      const entitas = req.body?.entitas !== undefined ? String(req.body.entitas) : b.entitas;
      if (!ENTITAS.includes(entitas)) throw galat('Entitas harus RDA, RCE, RET, atau UMUM.', 400);
      const nomor = req.body?.nomor !== undefined ? String(req.body.nomor).trim().slice(0, 60) : b.nomor;
      const catatan = req.body?.catatan !== undefined ? String(req.body.catatan).slice(0, 500) : b.catatan;
      const { rows: [n] } = await query(`UPDATE gr_documents SET entitas = $2, nomor = $3, catatan = $4 WHERE id = $1 RETURNING ${KOLOM}`, [req.params.id, entitas, nomor, catatan]);
      res.json(rapi(n, req));
    } catch (err) { jawabGalat(res, err); }
  }));

  r.delete('/gr/:id', requireAuth, wrap(async (req, res) => {
    try {
      const b = await muatBaris(req);
      if (!boleh(req, b)) throw galat('Hanya Super Admin atau pengunggahnya yang bisa menghapus dokumen ini.', 403);
      await query('DELETE FROM gr_documents WHERE id = $1', [req.params.id]);
      res.json({ ok: true, id: String(b.id) });
    } catch (err) { jawabGalat(res, err); }
  }));

  return r;
}
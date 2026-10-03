// ── Log perubahan Laporan Mingguan (untuk notifikasi) ─────────────────────
// Dipakai tiga sumber data yang ditarik dari Google Sheet — Barang Keluar/
// Masuk/Aset (weeklyReport.js), PICA (pica.js), dan Work Target
// (workTarget.js). Tiap sinkronisasi membandingkan isi baris LAMA di database
// dengan isi BARU dari sheet, lalu mencatat apa yang benar-benar berubah:
//
//   baru  — baris yang belum ada sebelumnya
//   ubah  — baris yang sama tapi isinya berbeda (dengan daftar dari → ke)
//   hapus — baris yang sudah tidak ada di sheet
//
// Catatan dikelompokkan per (kind, PIC) dalam satu kali sinkron supaya
// notifikasi ringkas ("Teguh · 3 data baru"), bukan satu notifikasi per baris.
//
// PENTING: "PIC" di sini adalah isi kolom PIC pada baris itu di sheet —
// bukan akun yang mengedit sheet (Google Sheet CSV tidak memberi tahu siapa
// yang mengedit). Kalau kolom PIC kosong, dicatat sebagai PIC kosong.
//
// Mencatat log TIDAK BOLEH menggagalkan sinkronisasi: semua error di sini
// ditelan dan hanya dicetak sebagai peringatan.

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

export const CHANGE_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS weekly_report_changes (
  id         BIGSERIAL PRIMARY KEY,
  site       TEXT NOT NULL,                 -- 'global' untuk Work Target (sheet-nya satu untuk seluruh perusahaan)
  area       TEXT NOT NULL CHECK (area IN ('OUT','IN','ASET','PICA','WORK_TARGET')),
  kind       TEXT NOT NULL CHECK (kind IN ('baru','ubah','hapus')),
  pic        TEXT NOT NULL DEFAULT '',
  jumlah     INTEGER NOT NULL DEFAULT 1,    -- banyak baris dalam kelompok ini
  ringkasan  TEXT NOT NULL DEFAULT '',      -- nama baris pertama (untuk judul notifikasi)
  detail     JSONB NOT NULL DEFAULT '[]',   -- contoh baris: [{ nama, ket?, perubahan?: [{ kolom, dari, ke }] }]
  sumber     TEXT NOT NULL DEFAULT '',      -- 'auto-sync' atau email user yang menekan Sync/Import
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wrc_created ON weekly_report_changes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wrc_site ON weekly_report_changes(site, created_at DESC);
`;

const MAKS_CONTOH = 5;        // contoh baris yang disimpan per kelompok
const MAKS_PERUBAHAN = 4;     // "dari → ke" yang disimpan per baris contoh
const RETENSI_HARI = 60;      // catatan lebih tua dari ini dibuang

// ── Pembanding ────────────────────────────────────────────────────────────
const potong = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Menyeragamkan nilai sebelum dibandingkan supaya null / '' / "1.0" vs 1 tidak dianggap berubah. */
function seragam(v, tipe) {
  if (v === null || v === undefined) return '';
  if (tipe === 'angka') {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : String(v).trim();
  }
  if (tipe === 'tanggal') return String(v).slice(0, 10);
  if (tipe === 'json') return JSON.stringify(v);
  return String(v).replace(/\s+/g, ' ').trim();
}

function tampil(v, tipe) {
  const s = seragam(v, tipe);
  if (tipe === 'angka' && s !== '' && Number.isFinite(Number(s))) return Number(s).toLocaleString('id-ID');
  return s;
}

/**
 * Bandingkan baris lama (kolom snake_case dari DB) dengan baris baru (camelCase
 * hasil parsing sheet). `kolom` = [{ lama, baru, label, tipe?, ringkas? }].
 * `ringkas: true` untuk teks panjang — hanya ditulis "diperbarui", nilainya tak disimpan.
 */
export function bandingkan(lama, baru, kolom) {
  const hasil = [];
  for (const k of kolom) {
    const a = seragam(lama[k.lama], k.tipe);
    const b = seragam(baru[k.baru], k.tipe);
    if (a === b) continue;
    hasil.push(k.ringkas
      ? { kolom: k.label, dari: '', ke: '(diperbarui)' }
      : { kolom: k.label, dari: potong(tampil(lama[k.lama], k.tipe), 60) || '(kosong)', ke: potong(tampil(baru[k.baru], k.tipe), 60) || '(kosong)' });
  }
  return hasil;
}

/**
 * Pasangkan baris yang "hilang" dengan baris "baru" yang kuncinya sama.
 * Baris dikenali lewat row_hash yang dibentuk dari beberapa kolom; kalau salah
 * satu kolom itu diedit di sheet, hash-nya berubah sehingga tampak seperti
 * hapus + baru. Pemasangan ini mengembalikannya menjadi satu "diubah".
 * `kunci(row)` harus sama untuk baris lama dan baru yang dianggap satu entitas.
 */
export function pasangkan(barisBaru, barisHapus, kunciBaru, kunciLama) {
  const tersisa = new Map();
  for (const h of barisHapus) {
    const k = kunciLama(h);
    if (!tersisa.has(k)) tersisa.set(k, []);
    tersisa.get(k).push(h);
  }
  const baru = [], ubah = [];
  for (const b of barisBaru) {
    const antrean = tersisa.get(kunciBaru(b));
    if (antrean && antrean.length) ubah.push({ lama: antrean.shift(), baru: b });
    else baru.push(b);
  }
  const hapus = [...tersisa.values()].flat();
  return { baru, ubah, hapus };
}

// ── Pencatat ──────────────────────────────────────────────────────────────
/**
 * @param {{ site: string, area: string, sumber: string,
 *           baru: {pic:string, nama:string, ket?:string}[],
 *           ubah: {pic:string, nama:string, ket?:string, perubahan:{kolom,dari,ke}[]}[],
 *           hapus:{pic:string, nama:string, ket?:string}[] }} p
 */
export async function catatPerubahan({ site, area, sumber, baru = [], ubah = [], hapus = [] }) {
  try {
    const kelompok = new Map(); // `${kind}|${pic}` -> { kind, pic, item[] }
    const masuk = (kind, daftar) => {
      for (const it of daftar) {
        const pic = String(it.pic || '').trim();
        const key = `${kind}|${pic.toLowerCase()}`;
        if (!kelompok.has(key)) kelompok.set(key, { kind, pic, item: [] });
        kelompok.get(key).item.push(it);
      }
    };
    masuk('baru', baru);
    masuk('ubah', ubah);
    masuk('hapus', hapus);
    if (!kelompok.size) return 0;

    for (const g of kelompok.values()) {
      const contoh = g.item.slice(0, MAKS_CONTOH).map((it) => ({
        nama: potong(it.nama, 120),
        ...(it.ket ? { ket: potong(it.ket, 60) } : {}),
        ...(it.perubahan?.length ? { perubahan: it.perubahan.slice(0, MAKS_PERUBAHAN) } : {}),
      }));
      await query(
        `INSERT INTO weekly_report_changes (site, area, kind, pic, jumlah, ringkasan, detail, sumber)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [site, area, g.kind, g.pic, g.item.length, potong(g.item[0].nama, 120), JSON.stringify(contoh), sumber || '']
      );
    }
    // Rapikan catatan lama (murah: ada indeks created_at).
    await query(`DELETE FROM weekly_report_changes WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(RETENSI_HARI)]);
    return kelompok.size;
  } catch (err) {
    console.warn('[change-log] gagal mencatat perubahan:', err.message);
    return 0;
  }
}

// ── Endpoint ──────────────────────────────────────────────────────────────
export const ChangeLog = {
  async list({ limit = 40, since, site, batasSite }) {
    const where = ['1=1'], params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
    // User yang terkunci ke satu site hanya melihat site-nya + Work Target (global).
    if (batasSite) add("site IN (?, 'global')", batasSite);
    else if (site && site !== 'global') add('site = ?', site);
    if (since) add('created_at > ?', since);
    params.push(Math.min(Math.max(Number(limit) || 40, 1), 100));
    const { rows } = await query(
      `SELECT * FROM weekly_report_changes WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    return rows.map((r) => ({
      id: String(r.id), site: r.site, area: r.area, kind: r.kind, pic: r.pic, jumlah: r.jumlah,
      ringkasan: r.ringkasan, detail: r.detail, sumber: r.sumber, createdAt: r.created_at,
    }));
  },
};

export function changeLogRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Perubahan terbaru (baru → lama) untuk menu notifikasi.
  r.get('/weekly-reports/changes', requireAuth, wrap(async (req, res) => {
    const mine = req.auth.assignedSite;
    const terkunci = !(req.auth.role === 'Super Admin' || mine === 'global' || !mine);
    res.json(await ChangeLog.list({
      limit: req.query.limit, since: req.query.since, site: req.query.site, batasSite: terkunci ? mine : null,
    }));
  }));

  return r;
}
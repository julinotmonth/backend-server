// ── Pembersih site kembar ─────────────────────────────────────────────────
// Dijalankan sekali tiap server start (index.js), sesudah semua skema dibuat.
//
// Masalah yang diselesaikan: dropdown site di Laporan Mingguan menampilkan dua
// entri dengan label sama tapi beda huruf — mis. "LNG SANGKULIRANG" dan
// "LNG Sangkulirang". Satu baris dibuat lewat menu Site Operasional, satunya
// lagi ditanam otomatis oleh seed di skema Laporan Mingguan (weeklyReport.js).
//
// Aturan (semua berbasis data — tidak ada site yang dihapus berdasarkan tebakan):
//   1. Site dianggap kembar bila label-nya sama setelah trim + huruf kecil.
//   2. Yang DIPERTAHANKAN: yang datanya terbanyak; kalau seri, yang labelnya
//      BUKAN label bawaan seed; kalau masih seri, yang paling tua.
//   3. Duplikat dihapus HANYA bila tidak punya data sama sekali (laporan
//      mingguan, PICA, spare part, aset tetap, galeri, user yang di-assign).
//      Konfigurasi sumber sheet-nya (tabel *_sources) ikut dibersihkan supaya
//      auto-sync tidak terus mengisi site yang sudah tidak ada.
//   4. Duplikat yang MASIH punya data dilewati dan dilaporkan di log — tidak
//      dihapus, karena data tabel Laporan Mingguan tidak punya foreign key ke
//      sites sehingga database tidak akan mencegah data jadi yatim.
//
// Idempotent (aman dijalankan berulang) dan tidak pernah menggagalkan startup.
// Matikan dengan env SITE_CLEANUP=off.

import { query, withTransaction } from './db.js';

// Label yang ditanam otomatis oleh seed (weeklyReport.js). Saat dua site kembar
// sama-sama kosong, yang berlabel persis seperti ini-lah yang dibuang.
const LABEL_SEED = ['Wunut', 'KHT', 'LNG Sangkulirang'];

const ID_AMAN = /^[a-z0-9_]+$/;
const normLabel = (s) => String(s || '').trim().toLowerCase();
// Tabel konfigurasi sumber sheet: ikut dihapus bersama site-nya (bukan "data").
const tabelKonfigurasi = (t) => /_sources$/.test(t);

/** Semua kolom (di semua tabel) yang menyimpan key site — dicari dari katalog, bukan daftar tetap. */
async function kolomSite() {
  const { rows } = await query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name IN ('site', 'assigned_site') AND c.table_name <> 'sites'`);
  return rows.filter((r) => ID_AMAN.test(r.table_name) && ID_AMAN.test(r.column_name));
}

async function hitungKeterkaitan(key, kolom) {
  const data = [], konfigurasi = [];
  for (const { table_name: tabel, column_name: col } of kolom) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM "${tabel}" WHERE "${col}" = $1`, [key]);
    const n = rows[0].n;
    if (n > 0) (tabelKonfigurasi(tabel) ? konfigurasi : data).push({ tabel, kolom: col, n });
  }
  return { data, konfigurasi, totalData: data.reduce((a, d) => a + d.n, 0) };
}

export async function rapikanSiteKembar({ log = console } = {}) {
  const hasil = { dihapus: [], dilewati: [] };
  if (process.env.SITE_CLEANUP === 'off') return hasil;
  try {
    const { rows: sites } = await query('SELECT key, label, created_at FROM sites ORDER BY created_at ASC, key ASC');
    const grup = new Map();
    for (const s of sites) {
      const k = normLabel(s.label);
      if (!grup.has(k)) grup.set(k, []);
      grup.get(k).push(s);
    }
    const kolom = await kolomSite();

    for (const anggota of grup.values()) {
      if (anggota.length < 2) continue;
      const info = [];
      for (const s of anggota) info.push({ ...s, ...(await hitungKeterkaitan(s.key, kolom)) });
      info.sort((a, b) =>
        b.totalData - a.totalData
        || (LABEL_SEED.includes(a.label) ? 1 : 0) - (LABEL_SEED.includes(b.label) ? 1 : 0)
        || new Date(a.created_at) - new Date(b.created_at));
      const [dipertahankan, ...kembar] = info;

      for (const k of kembar) {
        const nama = `"${k.label}" (key: ${k.key})`;
        if (k.totalData > 0) {
          const rinci = k.data.map((d) => `${d.tabel}=${d.n}`).join(', ');
          log.warn(`[site-cleanup] ${nama} kembar dengan "${dipertahankan.label}" (key: ${dipertahankan.key}) tapi masih punya data (${rinci}) — TIDAK dihapus.`);
          hasil.dilewati.push({ key: k.key, label: k.label, data: k.data });
          continue;
        }
        await withTransaction(async (c) => {
          for (const { tabel, kolom: col } of k.konfigurasi) await c.query(`DELETE FROM "${tabel}" WHERE "${col}" = $1`, [k.key]);
          await c.query('DELETE FROM sites WHERE key = $1', [k.key]);
        });
        log.info(`[site-cleanup] dihapus site kembar ${nama} — dipertahankan "${dipertahankan.label}" (key: ${dipertahankan.key}).`);
        hasil.dihapus.push({ key: k.key, label: k.label, dipertahankan: dipertahankan.key });
      }
    }
  } catch (err) {
    log.warn('[site-cleanup] gagal, dilewati:', err.message);
  }
  return hasil;
}
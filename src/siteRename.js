// ── Penyesuaian daftar site (dijalankan tiap server start, idempotent) ───────
//
// Dropdown site di Laporan Mingguan dibaca dari tabel `sites` di database,
// bukan dari seed — jadi mengubah migrate.js tidak memengaruhi database yang
// sudah berjalan. File ini yang menyesuaikan database yang sudah ada:
//
//   1. Label "WS Dawuan" (key tetap "indramayu") → "WS Cibungur".
//      Hanya diubah bila label-nya masih "Dawuan", jadi kalau kamu sudah
//      mengganti nama lewat menu Site Operasional, tidak ditimpa.
//   2. Site "bekasi" dihapus — MS Bekasi dan MS Setu adalah lokasi yang sama.
//      Data yang masih menempel di Bekasi (laporan mingguan, PICA, spare part,
//      aset tetap, galeri, user yang di-assign) DIPINDAHKAN ke Setu, bukan
//      dihapus. Semuanya dalam satu transaksi: bila ada yang gagal (mis.
//      bentrok data ganda), tidak ada yang berubah dan peringatan ditulis di log.
//
// Matikan dengan env SITE_RENAME=off.

import { query, withTransaction } from './db.js';

const ID_AMAN = /^[a-z0-9_]+$/;
const tabelKonfigurasi = (t) => /_sources$/.test(t);

async function kolomSite() {
  const { rows } = await query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name IN ('site', 'assigned_site') AND c.table_name <> 'sites'`);
  return rows.filter((r) => ID_AMAN.test(r.table_name) && ID_AMAN.test(r.column_name));
}

export async function sesuaikanSite({ log = console } = {}) {
  if (process.env.SITE_RENAME === 'off') return;
  try {
    // 1. WS Dawuan → WS Cibungur
    const ren = await query(
      `UPDATE sites SET label = 'WS Cibungur'
        WHERE key = 'indramayu' AND lower(trim(label)) IN ('ws dawuan', 'dawuan')`);
    if (ren.rowCount) log.info('[site-rename] label "indramayu" diubah menjadi "WS Cibungur".');

    // 2. Hapus MS Bekasi (bila kosong)
    const { rows } = await query(`SELECT key FROM sites WHERE key = 'bekasi'`);
    if (!rows.length) return;

    const kolom = await kolomSite();
    const data = [], konfigurasi = [];
    for (const { table_name: tabel, column_name: col } of kolom) {
      const r = await query(`SELECT COUNT(*)::int AS n FROM "${tabel}" WHERE "${col}" = $1`, ['bekasi']);
      if (r.rows[0].n > 0) (tabelKonfigurasi(tabel) ? konfigurasi : data).push({ tabel, kolom: col, n: r.rows[0].n });
    }
    if (data.length) {
      // Masih ada data (mis. data contoh dari seed). MS Bekasi = MS Setu (lokasi
      // yang sama), jadi datanya DIPINDAHKAN ke Setu — tidak ada yang dihapus.
      const { rows: setu } = await query(`SELECT key FROM sites WHERE key = 'setu'`);
      if (!setu.length) {
        log.warn('[site-rename] site "bekasi" masih punya data dan site "setu" tidak ada — TIDAK dihapus.');
        return;
      }
    }
    await withTransaction(async (c) => {
      for (const d of data) await c.query(`UPDATE "${d.tabel}" SET "${d.kolom}" = 'setu' WHERE "${d.kolom}" = 'bekasi'`);
      for (const k of konfigurasi) await c.query(`DELETE FROM "${k.tabel}" WHERE "${k.kolom}" = 'bekasi'`);
      await c.query(`DELETE FROM sites WHERE key = 'bekasi'`);
    });
    const rinci = data.map((d) => `${d.tabel}=${d.n}`).join(', ');
    log.info(`[site-rename] site "bekasi" dihapus${data.length ? `; data dipindahkan ke "setu" (${rinci})` : ''}.`);
  } catch (err) {
    log.warn('[site-rename] gagal, dilewati:', err.message);
  }
}
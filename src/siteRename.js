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
//      Dihapus HANYA bila tidak punya data sama sekali (laporan mingguan,
//      PICA, spare part, aset tetap, galeri, user yang di-assign). Kalau masih
//      ada data, site dibiarkan dan diberi peringatan di log — tidak ada data
//      yang dihapus berdasarkan tebakan.
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
      const rinci = data.map((d) => `${d.tabel}=${d.n}`).join(', ');
      log.warn(`[site-rename] site "bekasi" masih punya data (${rinci}) — TIDAK dihapus. Pindahkan/hapus datanya dulu, lalu restart server.`);
      return;
    }
    await withTransaction(async (c) => {
      for (const { tabel, kolom: col } of konfigurasi) await c.query(`DELETE FROM "${tabel}" WHERE "${col}" = $1`, ['bekasi']);
      await c.query(`DELETE FROM sites WHERE key = 'bekasi'`);
    });
    log.info('[site-rename] site "bekasi" dihapus.');
  } catch (err) {
    log.warn('[site-rename] gagal, dilewati:', err.message);
  }
}
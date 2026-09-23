import pg from 'pg';
import 'dotenv/config';

const { Pool, types } = pg;

// PostgreSQL DATE (OID 1082): driver `pg` secara default mem-parsing kolom
// ini jadi objek Date JS pada TENGAH MALAM ZONA WAKTU LOKAL server. Kalau
// nanti nilai itu dikonversi lewat `.toISOString()` (yang SELALU UTC) di
// server yang berjalan di zona waktu positif (WIB/WITA/WIT — kondisi umum
// untuk deployment di Indonesia), tengah malam lokal jatuh ke SORE HARI
// SEBELUMNYA dalam UTC, sehingga tanggal yang tersimpan/ditampilkan mundur
// 1 hari dari aslinya.
//
// Bukti nyata bug ini: baris "15/09/2026" di sheet sumber Laporan Mingguan
// WS Dawuan tersimpan & tampil sebagai "2026-09-14" di aplikasi (mundur
// tepat 1 hari, konsisten di semua baris).
//
// Perbaikan: jangan biarkan `pg` mengonversi kolom DATE ke objek Date sama
// sekali — kembalikan string "YYYY-MM-DD" mentah apa adanya. Setiap kode di
// aplikasi yang membaca kolom DATE dari DB sudah menangani string (lihat
// toDateStr() di repo.js), jadi ini aman diterapkan global.
types.setTypeParser(1082, (val) => val);

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://reethau:reethau_dev_pw@localhost:5432/reethau_inventory';

export const pool = new Pool({ connectionString });

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle PostgreSQL client', err);
});

/** Thin query helper — every route goes through this, so swapping drivers
 * or adding query logging/metrics later only touches this one function. */
export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
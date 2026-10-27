// ── Global Search (sisi server) ────────────────────────────────────────────
// Menu, site, dan pengguna sudah ada di browser, jadi dicari di sana. Yang dicari
// di server adalah data yang besar dan tidak dimuat penuh di browser, yaitu data
// yang memang tampil di aplikasi (bersumber dari Google Sheet):
//   • sparePart — katalog Spare Part: baris Barang Masuk/Keluar yang kodenya
//                 berawalan I-RDA / I-RCE, dikelompokkan per kode (aturan yang sama
//                 dengan menu Spare Part, lihat sparePartData.ts di frontend)
//   • laporan   — baris Laporan Mingguan (Barang Masuk / Keluar / Aset)
//   • pica      — butir PICA
//
// Otorisasi: akun non-Super Admin yang terikat ke satu site hanya mendapat
// hasil dari site-nya sendiri (sama seperti halaman laporannya).

import express from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

const MIN_LEN = 2;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

/** Escape karakter khusus LIKE supaya "50%" atau "a_b" dicari apa adanya. */
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function siteScope(auth) {
  const mine = auth.assignedSite;
  if (auth.role === 'Super Admin' || !mine || mine === 'global') return null;
  return mine;
}

export function searchRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /**
   * Tiap kata kunci harus cocok di SALAH SATU kolom (urutan kata bebas):
   * "kompresor seal" menemukan "Seal Kit Kompresor". Mengembalikan { sql, params }
   * dengan placeholder dimulai dari $1; filter site ditambahkan di belakang.
   */
  const bangunWhere = (kolom, tokens, scope, ekstra = '') => {
    const params = tokens.map((t) => `%${likeEscape(t)}%`);
    const sql = tokens
      .map((_, i) => `(${kolom.map((c) => `lower(${c}) LIKE $${i + 1} ESCAPE '\\'`).join(' OR ')})`)
      .join(' AND ');
    let akhir = `${ekstra}${ekstra ? ' AND ' : ''}${sql}`;
    if (scope) { params.push(scope); akhir += ` AND site = $${params.length}`; }
    return { sql: akhir, params };
  };

  r.get('/search', requireAuth, wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 80);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const kosong = { q, sparePart: { total: 0, items: [] }, laporan: { total: 0, items: [] }, pica: { total: 0, items: [] } };
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    if (q.length < MIN_LEN || tokens.length === 0) return res.json(kosong);
    const scope = siteScope(req.auth);

    // Kode dirapikan seperti normKode() di frontend: huruf besar, spasi/tanda pisah → "-".
    const kodeNorm = `regexp_replace(upper(btrim(kode)), '[\\u2010-\\u2015\\s]+', '-', 'g')`;

    const lap = bangunWhere(
      ['nama_barang', 'kode', 'pic', 'no_mr', 'no_shipment', 'detail_alokasi', 'keterangan', 'merk', 'tipe', 'jenis'], tokens, scope);
    const pica = bangunWhere(['problem', 'identifikasi', 'deskripsi', 'pic', 'latest_note', 'status'], tokens, scope);
    // Katalog spare part: kode berawalan I-RDA / I-RCE; kode ternormalisasi ikut dicocokkan ("i rda" ≈ "I-RDA-…").
    const sp = bangunWhere(
      ['nama_barang', 'kode', kodeNorm, 'merk', 'tipe', 'jenis'], tokens, scope,
      `direction IN ('IN','OUT') AND ${kodeNorm} ~ '^I-(RDA|RCE)'`);

    const [spCount, spRows, lapCount, lapRows, picaCount, picaRows] = await Promise.all([
      query(`SELECT COUNT(DISTINCT ${kodeNorm})::int AS n FROM weekly_report_rows WHERE ${sp.sql}`, sp.params),
      query(
        `SELECT ${kodeNorm} AS kode, MIN(nama_barang) AS nama, MIN(satuan) AS satuan,
                COALESCE(SUM(jumlah) FILTER (WHERE direction = 'IN'), 0)  AS masuk,
                COALESCE(SUM(jumlah) FILTER (WHERE direction = 'OUT'), 0) AS keluar,
                COUNT(DISTINCT site)::int AS jml_site
           FROM weekly_report_rows WHERE ${sp.sql}
          GROUP BY ${kodeNorm}
          ORDER BY (${kodeNorm} = upper($${sp.params.length + 1})) DESC, MIN(nama_barang)
          LIMIT ${limit}`, [...sp.params, q.replace(/\s+/g, '-')]),
      query(`SELECT COUNT(*)::int AS n FROM weekly_report_rows WHERE ${lap.sql}`, lap.params),
      query(
        `SELECT id, site, direction, tanggal, minggu, bulan, tahun, kode, nama_barang, jumlah, satuan, pic, alokasi,
                detail_alokasi, no_mr, keterangan
           FROM weekly_report_rows WHERE ${lap.sql}
          ORDER BY tahun DESC, bulan DESC, minggu DESC, tanggal DESC NULLS LAST, nama_barang
          LIMIT ${limit}`, lap.params),
      query(`SELECT COUNT(*)::int AS n FROM pica_items WHERE ${pica.sql}`, pica.params),
      query(
        `SELECT id, site, no, tanggal, problem, identifikasi, status, pic, latest_week, latest_note
           FROM pica_items WHERE ${pica.sql}
          ORDER BY tanggal DESC NULLS LAST, no
          LIMIT ${limit}`, pica.params),
    ]);

    res.json({
      q,
      sparePart: {
        total: spCount.rows[0].n,
        items: spRows.rows.map((x) => ({
          kode: x.kode, nama: x.nama, satuan: x.satuan,
          masuk: Number(x.masuk), keluar: Number(x.keluar), saldo: Number(x.masuk) - Number(x.keluar), jmlSite: x.jml_site,
        })),
      },
      laporan: {
        total: lapCount.rows[0].n,
        items: lapRows.rows.map((x) => ({
          id: x.id, site: x.site, direction: x.direction, tanggal: x.tanggal, minggu: x.minggu, bulan: x.bulan, tahun: x.tahun,
          kode: x.kode, namaBarang: x.nama_barang, jumlah: Number(x.jumlah), satuan: x.satuan, pic: x.pic,
          alokasi: x.alokasi, detailAlokasi: x.detail_alokasi, noMr: x.no_mr, keterangan: x.keterangan,
        })),
      },
      pica: {
        total: picaCount.rows[0].n,
        items: picaRows.rows.map((x) => ({
          id: x.id, site: x.site, no: x.no, tanggal: x.tanggal, problem: x.problem, identifikasi: x.identifikasi,
          status: x.status, pic: x.pic, latestWeek: x.latest_week, latestNote: x.latest_note,
        })),
      },
    });
  }));

  return r;
}
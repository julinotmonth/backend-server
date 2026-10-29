// ── Pengambilan data dari Google Sheets yang tahan gangguan ────────────────
// Semua modul laporan (Weekly Report, PICA, Work Target, Safety Stock, Outstanding PR)
// menarik CSV dari Google lewat helper ini supaya perilakunya seragam:
//   • timeout — fetch polos bisa menggantung selamanya bila Google/jaringan macet
//   • ulang otomatis untuk gangguan sementara (jaringan, timeout, 429, 5xx) dengan jeda bertambah
//   • 4xx (mis. 403 "sheet tidak dibagikan") TIDAK diulang — itu salah konfigurasi, bukan gangguan
//
// SHEETS_BASE_URL hanya untuk pengujian (mengarah ke server tiruan); produksi memakai Google.
export const SHEETS_BASE = (process.env.SHEETS_BASE_URL || 'https://docs.google.com').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<{ ok: boolean, status: number, text: string }>} */
export async function fetchGoogleText(url, { retries = 2, timeoutMs = Number(process.env.SHEETS_FETCH_TIMEOUT_MS) || 25_000 } = {}) {
  let terakhir;
  for (let i = 0; i <= retries; i++) {
    try {
      // Sinyal timeout mencakup juga pembacaan isi (body), bukan hanya header.
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) terakhir = new Error(`Google sedang sibuk (HTTP ${res.status}).`);
      else return { ok: res.ok, status: res.status, text };
    } catch (err) {
      terakhir = new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Google tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik.`
        : `Tidak bisa menghubungi Google (${err?.cause?.code || err?.message || 'jaringan'}).`);
    }
    if (i < retries) await sleep(700 * 2 ** i + Math.floor(Math.random() * 300));
  }
  throw Object.assign(terakhir, { status: 502 });
}
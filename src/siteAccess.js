// ── Pembatasan akses per site untuk data "company-wide" ───────────────────
// Outstanding PR dan Pencapaian Safety Stock berasal dari SATU sheet untuk seluruh
// perusahaan. Aturannya sama seperti modul lain (weeklyReport, pica, search):
//   • Super Admin                      → melihat semua site.
//   • Akun non-Super Admin ber-site    → hanya melihat data site-nya sendiri.
//   • Akun non-Super Admin "global"    → melihat semua site (ditugaskan ke seluruh site).
//
// Nama lokasi di sheet ("RCE MS Setu", "MS Setu", "WS Cibungur", "LNG Sangkulirang",
// "RET") dicocokkan ke site akun lewat nama intinya: awalan RCE/MS/WS/LNG dibuang,
// lalu kata-kata yang tersisa dibandingkan dengan label & key site.
import { Sites } from './repo.js';

const AWALAN = new Set(['rce', 'ms', 'ws', 'lng']);
const inti = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !AWALAN.has(t));

/** Key site yang membatasi akun ini, atau null bila boleh melihat semua site. */
export function siteScope(auth) {
  const mine = auth?.assignedSite;
  if (auth?.role === 'Super Admin' || !mine || mine === 'global') return null;
  return mine;
}

/** Lengkapi scope dengan label site dari database. Null = tidak dibatasi. */
export async function muatSiteScope(auth) {
  const key = siteScope(auth);
  if (!key) return null;
  const site = await Sites.find(key);
  // Site sudah dihapus → tetap dibatasi (tidak menampilkan apa pun), bukan membuka semua.
  return site ? { key: site.key, label: site.label } : { key, label: key, hilang: true };
}

/** Apakah nama lokasi di sheet milik site dalam scope ini? */
export function lokasiCocok(namaLokasi, scope) {
  if (!scope || scope.hilang) return false;
  const a = inti(namaLokasi);
  if (!a.length) return false;
  const sa = new Set(a);
  return [inti(scope.label), inti(scope.key)]
    .filter((b) => b.length)
    .some((b) => {
      const sb = new Set(b);
      return a.every((t) => sb.has(t)) || b.every((t) => sa.has(t));
    });
}
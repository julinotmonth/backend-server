// ── Brankas password (untuk fitur "lihat password" di Kelola Pengguna) ─────
// Login tetap memakai hash bcrypt (password_hash) — itu yang menentukan
// apakah sebuah password benar. Kolom `password_enc` menyimpan salinan
// password yang DIENKRIPSI (AES-256-GCM) supaya Super Admin bisa melihat &
// membagikannya lagi. Isi database saja (tanpa kunci server) tidak cukup
// untuk membaca password.
//
// Kunci diambil dari PASSWORD_VAULT_KEY; bila tidak diatur dipakai JWT_SECRET.
// PERHATIAN: bila kunci berubah, password yang sudah tersimpan tidak bisa
// dibuka lagi (tampil "belum tersimpan") dan perlu diatur ulang dari menu
// Kelola Pengguna — login tidak terpengaruh.
import crypto from 'node:crypto';
import 'dotenv/config';

let cachedKey = null;
function key() {
  if (!cachedKey) {
    const secret = process.env.PASSWORD_VAULT_KEY || process.env.JWT_SECRET || 'reethau-dev-secret-change-me';
    cachedKey = crypto.scryptSync(secret, 'reethau-password-vault-v1', 32);
  }
  return cachedKey;
}

const b64 = (buf) => buf.toString('base64url');

/** Enkripsi password → string "v1.<iv>.<tag>.<data>" yang aman disimpan di DB. */
export function sealPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(data)}`;
}

/** Kebalikan sealPassword. Mengembalikan null bila kosong/rusak/kunci berbeda. */
export function openPassword(sealed) {
  if (!sealed || typeof sealed !== 'string') return null;
  try {
    const [ver, iv, tag, data] = sealed.split('.');
    if (ver !== 'v1' || !iv || !tag || !data) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { Users, Sites, Categories, SpareParts, Logs, Gallery, FixedAssets, WorkOrders } from './repo.js';
import { signToken, requireAuth, requireSuperAdmin } from './auth.js';
import { sealPassword } from './vault.js';
import { searchRouter } from './search.js';
import { WEEKLY_REPORT_SCHEMA, weeklyReportRouter, startAutoSync } from './weeklyReport.js';
import { PICA_SCHEMA, picaRouter, startPicaAutoSync } from './pica.js';
import { WORK_TARGET_SCHEMA, workTargetRouter, startWorkTargetAutoSync } from './workTarget.js';
import { MIN_STOCK_SCHEMA, minStockRouter, startMinStockAutoSync } from './minStock.js';
import { OUTSTANDING_PR_SCHEMA, outstandingPrRouter, startOutstandingPrAutoSync } from './outstandingPr.js';
import { CHANGE_LOG_SCHEMA, changeLogRouter } from './changeLog.js';
import { rapikanSiteKembar } from './siteCleanup.js';
import { sesuaikanSite } from './siteRename.js';

const PORT = process.env.PORT || 4000;
const DEFAULT_SITE_KEYS = ['indramayu', 'blora', 'setu'];

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || true); // di belakang nginx/Cloudflare/dll.
// Di production sebaiknya batasi origin: CORS_ORIGIN=https://domain-anda.com (pisahkan koma bila lebih dari satu).
// maxAge: browser menyimpan hasil preflight (OPTIONS) sehingga tidak ada request OPTIONS ekstra
// di setiap panggilan API (header Authorization memicu preflight) — hemat satu round trip per request.
app.use(cors({
  maxAge: 7200,
  ...(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) } : {}),
}));
app.use(express.json({ limit: '12mb' }));

// Kesiapan: server mulai mendengarkan SEGERA saat proses menyala (tanpa menunggu migrasi DB), dan
// selama belum siap menjawab 503 + Retry-After. Dulu port belum terbuka sampai migrasi selesai,
// sehingga proxy hosting membalas error tanpa header CORS — di browser tampil sebagai "CORS" /
// ERR_FAILED. Respons 503 dari sini membawa header CORS, dan frontend otomatis mencoba lagi.
let siap = false;
app.get('/api/ping', (_req, res) => res.json({ ok: true, siap })); // ringan, tanpa DB — untuk membangunkan server
app.use('/api', (_req, res, next) => {
  if (siap) return next();
  res.set('Retry-After', '2').status(503).json({ error: 'Server sedang menyiapkan diri. Coba lagi sebentar.' });
}); // generous limit — uploaded photos are sent as base64 data URLs

const nowTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const slugify = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `site-${Date.now()}`;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Health check ────────────────────────────────────────────────────────
app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: 'connected', time: new Date().toISOString() });
}));

// ── Auth ─────────────────────────────────────────────────────────────────
// Pembatas percobaan login (in-memory): maks 8 gagal per 15 menit untuk
// kombinasi IP + email. Cukup untuk satu instance; pakai store bersama
// (mis. Redis) bila server dijalankan lebih dari satu replika.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const loginFails = new Map(); // key -> { count, resetAt }
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if (v.resetAt <= now) loginFails.delete(k);
}, 5 * 60 * 1000).unref();

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'Email dan password wajib diisi.' });
  }
  const key = `${req.ip}|${email.trim().toLowerCase()}`;
  const entry = loginFails.get(key);
  if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_MAX_FAILS) {
    const mins = Math.ceil((entry.resetAt - Date.now()) / 60000);
    res.set('Retry-After', String(mins * 60));
    return res.status(429).json({ error: `Terlalu banyak percobaan login. Coba lagi dalam ${mins} menit.` });
  }

  const row = await Users.findByEmail(email.trim());
  // Selalu jalankan satu bcrypt compare agar waktu respons tidak membocorkan
  // apakah email terdaftar.
  const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH) && !!row;
  if (!ok) {
    const now = Date.now();
    const cur = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    cur.count += 1;
    loginFails.set(key, cur);
    return res.status(401).json({ error: 'Email atau password salah.' });
  }
  loginFails.delete(key);
  // Akun lama belum punya salinan terenkripsi — isi sekarang (password baru saja terverifikasi)
  // supaya muncul di Kelola Pengguna. Gagal menyimpan tidak boleh menggagalkan login.
  if (!row.password_enc) {
    try { await Users.setPassword(row.id, row.password_hash, sealPassword(password)); }
    catch (err) { console.warn('[auth] Gagal menyimpan salinan password:', err.message); }
  }
  const user = await Users.findById(row.id);
  const token = signToken(user);
  res.json({ token, user });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await Users.findById(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  res.json({ user });
}));

// ── Users ────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireSuperAdmin, asyncRoute(async (_req, res) => {
  res.json(await Users.all());
}));

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 72; // batas bcrypt
/** Mengembalikan pesan error bila password tidak layak, atau null bila OK. */
const cekPassword = (pw) => {
  if (typeof pw !== 'string') return 'Password harus berupa teks.';
  if (pw.length < MIN_PASSWORD) return `Password minimal ${MIN_PASSWORD} karakter.`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD) return `Password terlalu panjang (maksimal ${MAX_PASSWORD} karakter).`;
  if (pw !== pw.trim()) return 'Password tidak boleh diawali atau diakhiri spasi.';
  return null;
};

// Password semua akun (untuk ditampilkan di Kelola Pengguna). Hanya Super Admin; jangan di-cache.
app.get('/api/users/credentials', requireAuth, requireSuperAdmin, asyncRoute(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await Users.credentials());
}));

app.post('/api/users', requireAuth, requireSuperAdmin, asyncRoute(async (req, res) => {
  const { name, email, position, role, assignedSite, avatarUrl, password } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Nama dan email wajib diisi.' });
  if (await Users.findByEmail(email)) {
    return res.status(409).json({ error: 'Email tersebut sudah terdaftar.' });
  }
  // Password dipilih sendiri oleh Super Admin; bila dikosongkan dibuatkan password acak.
  const diisiSendiri = password !== undefined && password !== null && password !== '';
  if (diisiSendiri) {
    const salah = cekPassword(password);
    if (salah) return res.status(400).json({ error: salah });
  }
  const finalPassword = diisiSendiri ? password : crypto.randomBytes(9).toString('base64url'); // 12 karakter acak
  const user = await Users.insert({
    id: `user-${Date.now().toString(36)}`,
    name,
    email,
    passwordHash: bcrypt.hashSync(finalPassword, 10),
    passwordEnc: sealPassword(finalPassword),
    position: position || role || 'Anggota Tim',
    role: role || 'Site Manager',
    assignedSite: assignedSite || 'global',
  });
  if (avatarUrl) await Users.update(user.id, { avatarUrl });
  res.status(201).json({
    ...(await Users.findById(user.id)),
    ...(diisiSendiri ? {} : { temporaryPassword: finalPassword }),
  });
}));

app.patch('/api/users/:id', requireAuth, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const isSelf = req.auth.sub === id;
  const isSuperAdmin = req.auth.role === 'Super Admin';
  if (!isSelf && !isSuperAdmin) {
    return res.status(403).json({ error: 'Anda hanya bisa mengubah profil Anda sendiri.' });
  }
  const patch = { ...req.body };
  const newPassword = patch.password;
  delete patch.password; // ditangani terpisah di bawah — bukan kolom biasa
  delete patch.id;
  delete patch.email; // email is immutable after creation, matching the frontend form
  if (!isSuperAdmin) {
    // Self-edit is limited to display fields — role/site changes must go
    // through a Super Admin, even if someone tampers with the request body.
    delete patch.role;
    delete patch.assignedSite;
  }
  // Mengganti password hanya boleh oleh Super Admin (kolom kosong = tidak diubah).
  const mauGantiPassword = newPassword !== undefined && newPassword !== null && newPassword !== '';
  if (mauGantiPassword) {
    if (!isSuperAdmin) return res.status(403).json({ error: 'Hanya Super Admin yang bisa mengganti password.' });
    const salah = cekPassword(newPassword);
    if (salah) return res.status(400).json({ error: salah });
  }
  const updated = await Users.update(id, patch);
  if (!updated) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (mauGantiPassword) await Users.setPassword(id, bcrypt.hashSync(newPassword, 10), sealPassword(newPassword));
  res.json(updated);
}));

app.delete('/api/users/:id', requireAuth, requireSuperAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (id === req.auth.sub) {
    return res.status(400).json({ error: 'Anda tidak bisa menghapus akun Anda sendiri.' });
  }
  const target = await Users.findById(id);
  if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (target.role === 'Super Admin' && (await Users.countByRole('Super Admin')) <= 1) {
    return res.status(400).json({ error: 'Tidak bisa menghapus Super Admin terakhir.' });
  }
  await Users.remove(id);
  res.status(204).end();
}));

// ── Sites ────────────────────────────────────────────────────────────────
app.get('/api/sites', requireAuth, asyncRoute(async (_req, res) => res.json(await Sites.all())));

app.post('/api/sites', requireAuth, asyncRoute(async (req, res) => {
  const { label, subtitle, color, imageUrl } = req.body || {};
  if (!label?.trim()) return res.status(400).json({ error: 'Nama site wajib diisi.' });
  const existing = await Sites.all();
  let key = slugify(label);
  if (existing.some((s) => s.key === key)) key = `${key}-${Date.now().toString(36)}`;
  const palette = ['#00D084', '#60A5FA', '#FBBF24', '#C084FC', '#F472B6', '#38BDF8', '#A3E635', '#F87171'];
  const site = await Sites.insert({
    key,
    label: label.trim(),
    subtitle: subtitle?.trim() || 'Site Operasional',
    color: color || palette[existing.length % palette.length],
    imageUrl: imageUrl || '/assets/images/cng-cylinder.webp',
  });
  res.status(201).json(site);
}));

app.patch('/api/sites/:key', requireAuth, asyncRoute(async (req, res) => {
  const updated = await Sites.update(req.params.key, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Site tidak ditemukan.' });
  res.json(updated);
}));

app.delete('/api/sites/:key', requireAuth, asyncRoute(async (req, res) => {
  const { key } = req.params;
  if (DEFAULT_SITE_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Site bawaan tidak bisa dihapus.' });
  }
  if (await SpareParts.existsForSite(key)) {
    return res.status(400).json({ error: 'Tidak bisa menghapus site yang masih memiliki spare part terdaftar.' });
  }
  const removed = await Sites.remove(key);
  if (!removed) return res.status(404).json({ error: 'Site tidak ditemukan.' });
  res.status(204).end();
}));

// ── Categories ───────────────────────────────────────────────────────────
app.get('/api/categories', requireAuth, asyncRoute(async (_req, res) => res.json(await Categories.get())));

app.post('/api/categories/spare-part', requireAuth, asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nama kategori wajib diisi.' });
  res.status(201).json({ sparePart: await Categories.addSparePart(name.trim()) });
}));

app.post('/api/categories/product-energy', requireAuth, asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nama lini produk wajib diisi.' });
  res.status(201).json({ productEnergy: await Categories.addProductEnergy(name.trim()) });
}));

// ── Spare Parts ──────────────────────────────────────────────────────────
app.get('/api/spare-parts', requireAuth, asyncRoute(async (_req, res) => res.json(await SpareParts.all())));

app.post('/api/spare-parts', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.sku || !b.name || !b.site) return res.status(400).json({ error: 'SKU, nama, dan site wajib diisi.' });
  const part = await SpareParts.insert({
    id: `sp-${Date.now().toString(36)}`,
    sku: b.sku,
    name: b.name,
    category: b.category,
    productEnergy: b.productEnergy,
    site: b.site,
    stock: Number(b.stock) || 0,
    minStock: Number(b.minStock) || 0,
    unit: b.unit || 'Units',
    priceEstimate: Number(b.priceEstimate) || 0,
    status: b.status || 'In Stock',
    lastInspected: b.lastInspected || new Date().toISOString().split('T')[0],
    specifications: b.specifications || '',
    imageUrl: b.imageUrl,
  });
  res.status(201).json(part);
}));

app.patch('/api/spare-parts/:id', requireAuth, asyncRoute(async (req, res) => {
  const updated = await SpareParts.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Spare part tidak ditemukan.' });
  res.json(updated);
}));

app.delete('/api/spare-parts/:id', requireAuth, asyncRoute(async (req, res) => {
  const removed = await SpareParts.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Spare part tidak ditemukan.' });
  res.status(204).end();
}));

// Moves stock from one item to its counterpart at another site (creating it
// there if needed) and writes the log entry — all as one DB transaction.
app.post('/api/spare-parts/:id/transfer', requireAuth, asyncRoute(async (req, res) => {
  const { quantity, targetSite } = req.body || {};
  const qty = Number(quantity);
  if (!qty || qty <= 0 || !targetSite) {
    return res.status(400).json({ error: 'Jumlah dan site tujuan wajib diisi dengan benar.' });
  }
  try {
    const result = await SpareParts.transfer({
      sourceId: req.params.id,
      quantity: qty,
      targetSite,
      performedBy: req.body.performedBy || req.auth.email,
      newId: `sp-${Date.now().toString(36)}`,
      logId: `log-${Date.now().toString(36)}`,
      timestamp: nowTimestamp(),
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// ── Activity Logs ────────────────────────────────────────────────────────
app.get('/api/logs', requireAuth, asyncRoute(async (_req, res) => res.json(await Logs.all())));

app.post('/api/logs', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.action || !b.description || !b.performedBy) {
    return res.status(400).json({ error: 'action, description, dan performedBy wajib diisi.' });
  }
  const entry = await Logs.insert({
    id: `log-${Date.now().toString(36)}`,
    timestamp: b.timestamp || nowTimestamp(),
    action: b.action,
    description: b.description,
    performedBy: b.performedBy,
    siteFrom: b.siteFrom,
    siteTo: b.siteTo,
  });
  res.status(201).json(entry);
}));

// ── Gallery ──────────────────────────────────────────────────────────────
app.get('/api/gallery', requireAuth, asyncRoute(async (_req, res) => res.json(await Gallery.all())));

app.post('/api/gallery', requireAuth, asyncRoute(async (req, res) => {
  const { site, src, caption, description } = req.body || {};
  if (!site || !src || !caption?.trim()) {
    return res.status(400).json({ error: 'Site, foto, dan judul wajib diisi.' });
  }
  const item = await Gallery.insert({
    id: `gal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    site,
    src,
    caption: caption.trim(),
    description: description?.trim(),
    uploadedBy: req.body.uploadedBy || req.auth.email,
  });
  res.status(201).json(item);
}));

app.delete('/api/gallery/:id', requireAuth, asyncRoute(async (req, res) => {
  const item = await Gallery.find(req.params.id);
  if (!item) return res.status(404).json({ error: 'Foto tidak ditemukan.' });
  if (item.isDefault) return res.status(400).json({ error: 'Foto dokumentasi bawaan tidak bisa dihapus.' });
  await Gallery.remove(req.params.id);
  res.status(204).end();
}));

// ── Fixed Assets (Asset Registry / Depreciation) ──────────────────────────
app.get('/api/fixed-assets', requireAuth, asyncRoute(async (_req, res) => res.json(await FixedAssets.all())));

app.post('/api/fixed-assets', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.assetCode || !b.name || !b.site) {
    return res.status(400).json({ error: 'Kode aset, nama, dan site wajib diisi.' });
  }
  const asset = await FixedAssets.insert({
    id: `fa-${Date.now().toString(36)}`,
    assetCode: b.assetCode,
    name: b.name,
    category: b.category || 'Umum',
    site: b.site,
    acquisitionDate: b.acquisitionDate || new Date().toISOString().split('T')[0],
    acquisitionCost: Number(b.acquisitionCost) || 0,
    usefulLifeYears: Number(b.usefulLifeYears) || 5,
    salvageValue: Number(b.salvageValue) || 0,
    status: b.status || 'Active',
    serialNumber: b.serialNumber,
    warrantyExpiry: b.warrantyExpiry,
    notes: b.notes,
    imageUrl: b.imageUrl,
  });

  await Logs.insert({
    id: `log-${Date.now().toString(36)}`,
    timestamp: nowTimestamp(),
    action: 'ADD_SPARE_PART',
    description: `Aset tetap baru terdaftar: ${asset.name} (${asset.assetCode}) di Site ${String(asset.site).toUpperCase()}`,
    performedBy: req.body.performedBy || req.auth.email,
  });

  res.status(201).json(asset);
}));

app.patch('/api/fixed-assets/:id', requireAuth, asyncRoute(async (req, res) => {
  const updated = await FixedAssets.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Aset tidak ditemukan.' });
  res.json(updated);
}));

app.delete('/api/fixed-assets/:id', requireAuth, asyncRoute(async (req, res) => {
  const removed = await FixedAssets.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Aset tidak ditemukan.' });
  res.status(204).end();
}));

// ── Work Orders (Scheduled / Preventive Maintenance) ──────────────────────
app.get('/api/work-orders', requireAuth, asyncRoute(async (_req, res) => res.json(await WorkOrders.all())));

app.post('/api/work-orders', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.assetId || !b.title || !b.dueDate) {
    return res.status(400).json({ error: 'Aset, judul pekerjaan, dan tanggal jatuh tempo wajib diisi.' });
  }
  const wo = await WorkOrders.insert({
    id: `wo-${Date.now().toString(36)}`,
    assetId: b.assetId,
    title: b.title,
    type: b.type || 'Preventive',
    priority: b.priority || 'Medium',
    status: b.status || 'Scheduled',
    dueDate: b.dueDate,
    assignedTo: b.assignedTo,
    notes: b.notes,
  });
  res.status(201).json(wo);
}));

app.patch('/api/work-orders/:id', requireAuth, asyncRoute(async (req, res) => {
  const updated = await WorkOrders.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Work order tidak ditemukan.' });
  res.json(updated);
}));

app.post('/api/work-orders/:id/complete', requireAuth, asyncRoute(async (req, res) => {
  const updated = await WorkOrders.complete(req.params.id, req.body?.completedDate || new Date().toISOString().split('T')[0]);
  if (!updated) return res.status(404).json({ error: 'Work order tidak ditemukan.' });
  res.json(updated);
}));

app.delete('/api/work-orders/:id', requireAuth, asyncRoute(async (req, res) => {
  const removed = await WorkOrders.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Work order tidak ditemukan.' });
  res.status(204).end();
}));

// ── Reports (aggregated KPIs for the Reports view) ────────────────────────
app.get('/api/reports/summary', requireAuth, asyncRoute(async (_req, res) => {
  const [assets, workOrders, spareParts] = await Promise.all([FixedAssets.all(), WorkOrders.all(), SpareParts.all()]);

  const totalAcquisitionValue = assets.reduce((sum, a) => sum + a.acquisitionCost, 0);
  const totalBookValue = assets.reduce((sum, a) => sum + a.bookValue, 0);
  const totalAccumulatedDepreciation = assets.reduce((sum, a) => sum + a.accumulatedDepreciation, 0);

  const byCategory = {};
  for (const a of assets) {
    byCategory[a.category] = byCategory[a.category] || { category: a.category, acquisitionCost: 0, bookValue: 0, count: 0 };
    byCategory[a.category].acquisitionCost += a.acquisitionCost;
    byCategory[a.category].bookValue += a.bookValue;
    byCategory[a.category].count += 1;
  }

  const overdueWorkOrders = workOrders.filter((w) => w.status === 'Overdue').length;
  const upcomingWorkOrders = workOrders.filter((w) => w.status === 'Scheduled').length;
  const completedWorkOrders = workOrders.filter((w) => w.status === 'Completed').length;
  const totalInventoryValue = spareParts.reduce((sum, p) => sum + p.priceEstimate * p.stock, 0);

  res.json({
    totalAssets: assets.length,
    totalAcquisitionValue,
    totalBookValue,
    totalAccumulatedDepreciation,
    totalInventoryValue,
    assetsByCategory: Object.values(byCategory),
    workOrders: { overdue: overdueWorkOrders, upcoming: upcomingWorkOrders, completed: completedWorkOrders, total: workOrders.length },
  });
}));

app.use('/api', weeklyReportRouter());
app.use('/api', picaRouter());
app.use('/api', workTargetRouter());
app.use('/api', minStockRouter());          // ← Pencapaian Minimum Stok
app.use('/api', outstandingPrRouter());     // ← Outstanding PR
app.use('/api', changeLogRouter());       // ← notifikasi perubahan Laporan Mingguan
app.use('/api', searchRouter());          // ← Global Search (Laporan Mingguan + PICA)

app.use((req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

// Centralized error handler — catches anything asyncRoute() forwarded via next(err)
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Terjadi kesalahan pada server.' });
});

async function start() {
  const server = app.listen(PORT, () => {
    console.log(`[server] Reethau Inventory API listening on http://localhost:${PORT}`);
  });
  // Di belakang proxy/load balancer (SnapDeploy, Cloudflare, nginx, …) keep-alive Node bawaan hanya 5 dtk —
  // lebih pendek dari timeout idle proxy, sehingga sesekali proxy memakai koneksi yang sudah ditutup Node
  // dan pengguna melihat error acak. Dibuat lebih panjang dari proxy pada umumnya (60 dtk).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await migrate();
  await pool.query(WEEKLY_REPORT_SCHEMA);   // ← tabel laporan mingguan
  await pool.query(PICA_SCHEMA);            // ← tabel PICA tracker
  await pool.query(WORK_TARGET_SCHEMA);     // ← tabel Work Target tracker
  await pool.query(MIN_STOCK_SCHEMA);       // ← tabel Pencapaian Minimum Stok
  await pool.query(OUTSTANDING_PR_SCHEMA);  // ← tabel Outstanding PR
  await pool.query(CHANGE_LOG_SCHEMA);      // ← tabel log perubahan (notifikasi)
  await sesuaikanSite();                    // ← WS Dawuan → WS Cibungur, hapus MS Bekasi (bila kosong)
  await rapikanSiteKembar();                // ← buang site kembar yang kosong (mis. "LNG Sangkulirang" ganda)
  siap = true;
  console.log('[server] Siap melayani permintaan.');

  // Auto-sync dinyalakan SETELAH server siap dan dengan jeda bertingkat. Dulu keempatnya langsung
  // jalan serentak saat server bangun — tepat ketika pengguna mengirim request pertamanya — sehingga
  // request itu lambat atau gagal.
  startAutoSync();                           // ← Laporan Mingguan (mulai +30 dtk)
  startPicaAutoSync();                       // ← PICA            (+45 dtk)
  startWorkTargetAutoSync();                 // ← Work Target     (+60 dtk)
  startMinStockAutoSync();                   // ← Safety Stock    (+75 dtk)
  startOutstandingPrAutoSync();              // ← Outstanding PR  (+90 dtk)

  // Berhenti dengan rapi saat container dimatikan/tidur: selesaikan request yang berjalan, tutup koneksi DB.
  let berhenti = false;
  const matikan = (sinyal) => {
    if (berhenti) return;
    berhenti = true;
    console.log(`[server] ${sinyal} diterima — berhenti dengan rapi…`);
    setTimeout(() => process.exit(0), 8_000).unref();
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', () => matikan('SIGTERM'));
  process.on('SIGINT', () => matikan('SIGINT'));
}

// Kegagalan di pekerjaan latar belakang (mis. satu sync) tidak boleh mematikan seluruh server —
// proses yang mati = container restart = semua request pengguna gagal sesaat.
process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err));

start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
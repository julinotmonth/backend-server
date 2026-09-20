import jwt from 'jsonwebtoken';

// In a real deployment this must come from an environment variable. It's
// inlined here only so the demo runs with zero setup — rotate it (and
// invalidate existing sessions) before using this anywhere but locally.
const JWT_SECRET = process.env.JWT_SECRET || 'reethau-dev-secret-change-me';
const TOKEN_TTL = '7d';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, assignedSite: user.assignedSite },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid `Authorization: Bearer <token>`
 * header, attaches the decoded payload to req.auth, else 401s. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized — silakan login kembali.' });
  }
  req.auth = payload;
  next();
}

/** Route guard: only allows Super Admin accounts through. Use after requireAuth. */
export function requireSuperAdmin(req, res, next) {
  if (req.auth?.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Hanya Super Admin yang bisa melakukan aksi ini.' });
  }
  next();
}

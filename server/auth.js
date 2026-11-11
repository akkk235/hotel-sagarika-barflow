import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, getSetting, setSetting } from './db.js';
import { nowISO } from './util.js';

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - bar staff stay logged in offline

function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let secret = getSetting('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    setSetting('jwt_secret', secret);
  }
  return secret;
}

const SECRET = resolveSecret();

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function issueToken(user, device = 'web') {
  const jti = crypto.randomUUID();
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (user_id, jti, device, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(user.id, jti, device, createdAt, expiresAt);
  const token = jwt.sign({ sub: user.id, role: user.role, name: user.name, jti }, SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
  return { token, expiresAt };
}

export function revokeToken(jti) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(nowISO(), jti);
}

export function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone };
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, SECRET);
    const session = db.prepare('SELECT * FROM sessions WHERE jti = ?').get(payload.jti);
    if (!session || session.revoked_at) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = publicUser(user);
    req.jti = payload.jti;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires ${roles.join(' or ')} access` });
    }
    next();
  };
}

export const manager = requireRole('owner', 'manager');

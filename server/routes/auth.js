import express from 'express';
import { db, audit } from '../db.js';
import { authenticate, issueToken, publicUser, revokeToken, verifyPassword } from '../auth.js';
import { nowISO } from '../util.js';

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password, device } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'This login has been disabled by the owner' });
  const { token, expiresAt } = issueToken(user, device || req.headers['user-agent'] || 'web');
  db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowISO(), user.id);
  audit(user, 'auth.login', 'user', user.id, { device: device || 'web' });
  res.json({ token, expiresAt, user: publicUser(user) });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post('/logout', authenticate, (req, res) => {
  revokeToken(req.jti);
  audit(req.user, 'auth.logout', 'user', req.user.id, null);
  res.json({ ok: true });
});

export default router;

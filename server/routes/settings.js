/**
 * Admin Settings API — user accounts, roles, permissions and database backup.
 *
 * Every route here requires the Admin (owner) role. Granular permissions are
 * stored on the user row so an Admin can, for example, let a Billing Staff
 * member add stock without giving them reports or settings access.
 */
import express from 'express';
import fs from 'node:fs';
import { db, DB_PATH, audit, getSettings } from '../db.js';
import { authenticate, requireRole, hashPassword, verifyPassword } from '../auth.js';
import {
  PERMISSION_DEFS,
  ROLE_DEFAULTS,
  ROLE_LABELS,
  permissionsFor,
  roleLabel,
  sanitizePermissions,
} from '../permissions.js';
import { HttpError, nowISO } from '../util.js';

const router = express.Router();
const admin = requireRole('owner');
const ROLES = Object.keys(ROLE_LABELS);

function account(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    role_label: roleLabel(row.role),
    phone: row.phone,
    is_active: row.is_active,
    created_at: row.created_at,
    permissions: permissionsFor(row),
  };
}

function accountById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'User not found');
  return row;
}

function assertPassword(password) {
  if (String(password ?? '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
}

function revokeSessions(userId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowISO(), userId);
}

/** Settings catalogue + accounts. */
router.get('/', authenticate, admin, (req, res) => {
  const users = db
    .prepare('SELECT * FROM users ORDER BY CASE role WHEN \'owner\' THEN 0 WHEN \'manager\' THEN 1 ELSE 2 END, name')
    .all()
    .map(account);
  res.json({
    users,
    roles: ROLES.map((key) => ({ key, label: ROLE_LABELS[key], defaults: ROLE_DEFAULTS[key] })),
    permissions: PERMISSION_DEFS,
    me: req.user,
    hotel: getSettings(),
  });
});

/** Create a login ID with a role and optional permission overrides. */
router.post('/users', authenticate, admin, (req, res) => {
  const { name, username, password, role = 'staff', phone, permissions } = req.body || {};
  if (!name || !username || !password) throw new HttpError(400, 'Name, username and password are required');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be Admin, Manager or Billing Staff');
  assertPassword(password);
  const handle = String(username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(handle)) {
    throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore');
  }
  const perms = sanitizePermissions(role, permissions) ?? ROLE_DEFAULTS[role];
  const now = nowISO();
  try {
    const result = db
      .prepare(
        `INSERT INTO users (name, username, password_hash, role, phone, is_active, permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        String(name).trim(),
        handle,
        hashPassword(String(password)),
        role,
        phone || null,
        JSON.stringify(perms),
        now,
        now,
      );
    const created = accountById(Number(result.lastInsertRowid));
    audit(req.user, 'user.create', 'user', created.id, { username: handle, role, permissions: perms });
    res.status(201).json({ user: account(created) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(400, 'That username is already taken');
    throw err;
  }
});

/** Edit name, role, phone, active flag and permissions. */
router.patch('/users/:id', authenticate, admin, (req, res) => {
  const id = Number(req.params.id);
  const user = accountById(id);
  const { name, role, phone, is_active, permissions } = req.body || {};
  if (role && !ROLES.includes(role)) throw new HttpError(400, 'Invalid role');

  const nextRole = role || user.role;
  if (user.role === 'owner' && nextRole !== 'owner') {
    const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND is_active = 1").get().c;
    if (owners <= 1) throw new HttpError(400, 'At least one Admin login must remain');
  }
  if (user.id === req.user.id && is_active === false) {
    throw new HttpError(400, 'You cannot deactivate the account you are signed in with');
  }
  if (user.role === 'owner' && is_active === false) {
    const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND is_active = 1").get().c;
    if (owners <= 1) throw new HttpError(400, 'At least one active Admin login must remain');
  }

  const nextActive = is_active === undefined ? user.is_active : is_active ? 1 : 0;
  const nextPerms =
    permissions === undefined ? permissionsFor(user) : sanitizePermissions(nextRole, permissions) ?? permissionsFor(user);

  db.prepare(
    'UPDATE users SET name = ?, role = ?, phone = ?, is_active = ?, permissions = ?, updated_at = ? WHERE id = ?',
  ).run(
    name ? String(name).trim() : user.name,
    nextRole,
    phone ?? user.phone,
    nextActive,
    JSON.stringify(nextPerms),
    nowISO(),
    id,
  );
  if (!nextActive) revokeSessions(id);
  audit(req.user, 'user.update', 'user', id, {
    role: nextRole,
    is_active: Boolean(nextActive),
    permissions: nextPerms,
  });
  res.json({ user: account(accountById(id)) });
});

/** Admin sets a new password for any account (forces that account to sign in again). */
router.post('/users/:id/password', authenticate, admin, (req, res) => {
  const id = Number(req.params.id);
  const user = accountById(id);
  const password = req.body?.password;
  assertPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(String(password)),
    nowISO(),
    id,
  );
  revokeSessions(id);
  audit(req.user, 'user.password.reset', 'user', id, { username: user.username });
  res.json({ ok: true });
});

/** Any signed-in user changes their own password by confirming the current one. */
router.post('/password', authenticate, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const row = accountById(req.user.id);
  if (!verifyPassword(String(current_password ?? ''), row.password_hash)) {
    throw new HttpError(403, 'Current password is incorrect');
  }
  assertPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(String(new_password)),
    nowISO(),
    row.id,
  );
  audit(req.user, 'user.password.change', 'user', row.id, {});
  res.json({ ok: true });
});

/** Storage diagnostics: where the database lives and what it holds. */
router.get('/storage', authenticate, admin, (req, res) => {
  let size = null;
  try {
    size = fs.statSync(DB_PATH).size;
  } catch {
    size = null;
  }
  const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  res.json({
    database_path: DB_PATH,
    database_size: size,
    counts: {
      users: count('users'),
      products: count('products'),
      stock_entries: count('stock_ledger'),
      bills: count('bills'),
      purchases: count('purchases'),
    },
  });
});

/** Download a consistent SQLite snapshot (Admin only). */
router.get('/backup', authenticate, admin, (req, res) => {
  if (!fs.existsSync(DB_PATH)) throw new HttpError(404, 'Database file not found');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  audit(req.user, 'database.backup', 'database', null, { stamp });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="barflow-backup-${stamp}.db"`);
  fs.createReadStream(DB_PATH).pipe(res);
});

export default router;

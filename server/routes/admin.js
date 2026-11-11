import express from 'express';
import { db, audit, getSettings, setSetting } from '../db.js';
import { authenticate, manager, hashPassword, hashPin, verifyOwnerPin, requireRole } from '../auth.js';
import { HttpError, money, nowISO, toNum } from '../util.js';

const router = express.Router();
const owner = requireRole('owner');

// ---------- Owner PIN (authorises bill deletion) ----------
router.get('/pin', authenticate, owner, (req, res) => {
  const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.user.id);
  res.json({ pin_set: Boolean(row?.pin_hash) });
});

router.put('/pin', authenticate, owner, (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4 to 8 digits');
  const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.user.id);
  if (row?.pin_hash) {
    const check = verifyOwnerPin(req.user, req.body?.current_pin);
    if (!check.ok) throw new HttpError(check.status, check.message);
  }
  db.prepare('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?').run(hashPin(pin), nowISO(), req.user.id);
  audit(req.user, 'user.pin.update', 'user', req.user.id, {});
  res.json({ ok: true, pin_set: true });
});

// ---------- Users ----------
router.get('/users', authenticate, manager, (req, res) => {
  const users = db
    .prepare('SELECT id, name, username, role, phone, is_active, created_at FROM users ORDER BY id')
    .all();
  res.json({ users });
});

router.post('/users', authenticate, owner, (req, res) => {
  const { name, username, password, role, phone } = req.body || {};
  if (!name || !username || !password) throw new HttpError(400, 'Name, username and password are required');
  if (!['owner', 'manager', 'staff'].includes(role)) throw new HttpError(400, 'Role must be owner, manager or staff');
  if (String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  const now = nowISO();
  try {
    const result = db
      .prepare(
        `INSERT INTO users (name, username, password_hash, role, phone, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(String(name).trim(), String(username).trim().toLowerCase(), hashPassword(String(password)), role, phone || null, now, now);
    audit(req.user, 'user.create', 'user', Number(result.lastInsertRowid), { username, role });
    res.status(201).json({
      user: db.prepare('SELECT id, name, username, role, phone, is_active FROM users WHERE id = ?').get(result.lastInsertRowid),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(400, 'That username is already taken');
    throw err;
  }
});

router.patch('/users/:id', authenticate, owner, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'User not found');
  const { name, role, phone, is_active, password } = req.body || {};
  if (role && !['owner', 'manager', 'staff'].includes(role)) throw new HttpError(400, 'Invalid role');
  if (user.role === 'owner' && role && role !== 'owner') {
    const owners = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND is_active = 1`).get().c;
    if (owners <= 1) throw new HttpError(400, 'At least one owner login must remain');
  }
  db.prepare('UPDATE users SET name = ?, role = ?, phone = ?, is_active = ?, updated_at = ? WHERE id = ?').run(
    name ? String(name).trim() : user.name,
    role || user.role,
    phone ?? user.phone,
    is_active === undefined ? user.is_active : is_active ? 1 : 0,
    nowISO(),
    id,
  );
  if (password) {
    if (String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(String(password)), nowISO(), id);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowISO(), id);
  }
  audit(req.user, 'user.update', 'user', id, { role, is_active, password_reset: Boolean(password) });
  res.json({ user: db.prepare('SELECT id, name, username, role, phone, is_active FROM users WHERE id = ?').get(id) });
});

// ---------- Settings ----------
router.get('/settings', authenticate, (req, res) => {
  res.json({ settings: getSettings() });
});

router.put('/settings', authenticate, manager, (req, res) => {
  const allowed = [
    'hotel_name',
    'tagline',
    'address',
    'phone',
    'upi_id',
    'currency',
    'allow_negative_stock',
    'low_stock_alert',
    'invoice_footer',
  ];
  const body = req.body || {};
  const changed = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      setSetting(key, body[key]);
      changed[key] = body[key];
    }
  }
  audit(req.user, 'settings.update', 'settings', null, changed);
  res.json({ settings: getSettings() });
});

// ---------- Audit ----------
router.get('/audit', authenticate, manager, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ audit: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) });
});

// ---------- Suppliers & purchases ----------
router.get('/suppliers', authenticate, manager, (req, res) => {
  res.json({ suppliers: db.prepare('SELECT * FROM suppliers ORDER BY name').all() });
});

router.post('/suppliers', authenticate, manager, (req, res) => {
  const { name, phone, gstin, address } = req.body || {};
  if (!name) throw new HttpError(400, 'Supplier name is required');
  const result = db
    .prepare('INSERT INTO suppliers (name, phone, gstin, address, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(String(name).trim(), phone || null, gstin || null, address || null, nowISO());
  res.status(201).json({ supplier: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid) });
});

/** Stock inward: adds bottles to stock and writes the ledger. */
router.post('/purchases', authenticate, manager, (req, res) => {
  const { supplier_id, invoice_no, items, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Add at least one purchase line');
  const now = nowISO();
  const purchaseDate = req.body?.purchase_date || now.slice(0, 10);
  const create = db.transaction(() => {
    let total = 0;
    const prepared = items.map((item) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(item.product_id));
      if (!product) throw new HttpError(400, 'Product not found on purchase line');
      const bottles = toNum(item.bottles, 0);
      const mlPerBottle = toNum(item.ml_per_bottle, product.bottle_size_ml || 0);
      const totalMl = product.unit_type === 'ml' ? bottles * mlPerBottle : bottles;
      const unitCost = toNum(item.unit_cost, product.cost_price);
      const amount = money(bottles * unitCost);
      total = money(total + amount);
      return { product, bottles, mlPerBottle, totalMl, unitCost, amount };
    });
    const result = db
      .prepare(
        `INSERT INTO purchases (supplier_id, invoice_no, purchase_date, total_amount, paid_amount, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(supplier_id ? Number(supplier_id) : null, invoice_no || null, purchaseDate, total, money(req.body?.paid_amount || total), notes || null, req.user.id, now);
    const purchaseId = Number(result.lastInsertRowid);
    for (const line of prepared) {
      db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, bottles, ml_per_bottle, total_ml, unit_cost, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(purchaseId, line.product.id, line.bottles, line.mlPerBottle, line.totalMl, line.unitCost, line.amount);
      const next = money(line.product.stock_qty + line.totalMl);
      db.prepare('UPDATE products SET stock_qty = ?, cost_price = ?, updated_at = ? WHERE id = ?').run(
        next,
        line.unitCost,
        now,
        line.product.id,
      );
      db.prepare(
        `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, ref_id, note, created_by, created_at)
         VALUES (?, ?, ?, 'purchase', 'purchase', ?, ?, ?, ?)`,
      ).run(line.product.id, line.totalMl, next, purchaseId, `Purchase ${invoice_no || purchaseId}`, req.user.id, now);
    }
    return purchaseId;
  });
  const purchaseId = create();
  audit(req.user, 'purchase.create', 'purchase', purchaseId, { items: items.length });
  res.status(201).json({ purchase: db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) });
});

router.get('/purchases', authenticate, manager, (req, res) => {
  const rows = db
    .prepare(
      `SELECT pu.*, s.name AS supplier_name FROM purchases pu
       LEFT JOIN suppliers s ON s.id = pu.supplier_id ORDER BY pu.id DESC LIMIT 100`,
    )
    .all();
  res.json({ purchases: rows });
});

export default router;

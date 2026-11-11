import express from 'express';
import { db, getSettings, audit } from '../db.js';
import { authenticate } from '../auth.js';
import { createBill } from '../billing.js';
import { HttpError, localDate, money, nowISO, today, toNum } from '../util.js';
import { productsWithVariants, tableList } from './catalog.js';

const router = express.Router();

/** Everything a device needs to work offline, plus rows changed since the last pull. */
router.get('/state', authenticate, (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  res.json({
    server_time: nowISO(),
    today: today(),
    settings: getSettings(),
    categories: db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all(),
    products: productsWithVariants(),
    tables: tableList(),
    open_orders: db
      .prepare(
        `SELECT o.*, (SELECT COALESCE(SUM(line_total),0) FROM order_items WHERE order_id = o.id) AS amount
         FROM orders o WHERE o.status = 'open' ORDER BY o.id`,
      )
      .all(),
    bills: db.prepare('SELECT * FROM bills WHERE created_at > ? ORDER BY id LIMIT 500').all(since),
    expenses: db.prepare('SELECT * FROM expenses WHERE created_at > ? ORDER BY id LIMIT 500').all(since),
    counts: {
      bills: db.prepare('SELECT COUNT(*) AS c FROM bills').get().c,
      orders: db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
      products: db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
    },
  });
});

/** Accept queued offline writes. Each item is idempotent through its client_uuid. */
router.post('/push', authenticate, (req, res) => {
  const deviceId = req.body?.device_id || req.headers['x-device-id'] || 'unknown-device';
  const bills = Array.isArray(req.body?.bills) ? req.body.bills : [];
  const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
  const stockAdjustments = Array.isArray(req.body?.stock_adjustments) ? req.body.stock_adjustments : [];
  const results = [];

  for (const payload of bills) {
    if (!payload?.client_uuid) {
      results.push({ type: 'bill', client_uuid: null, status: 'rejected', message: 'Missing client_uuid' });
      continue;
    }
    try {
      const { bill, duplicate } = createBill({
        user: req.user,
        payload: { ...payload, offline: true },
        deviceId,
        offline: true,
      });
      results.push({
        type: 'bill',
        client_uuid: payload.client_uuid,
        status: duplicate ? 'duplicate' : 'synced',
        bill_id: bill.id,
        bill_no: bill.bill_no,
      });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Could not save offline bill';
      db.prepare(
        `INSERT INTO sync_log (device_id, client_uuid, entity, status, message, payload, created_at)
         VALUES (?, ?, 'bill', 'failed', ?, ?, ?)`,
      ).run(deviceId, payload.client_uuid, message, JSON.stringify(payload).slice(0, 4000), nowISO());
      results.push({ type: 'bill', client_uuid: payload.client_uuid, status: 'failed', message });
    }
  }

  for (const expense of expenses) {
    const uuid = expense?.client_uuid;
    if (!uuid) {
      results.push({ type: 'expense', client_uuid: null, status: 'rejected', message: 'Missing client_uuid' });
      continue;
    }
    const existing = db.prepare('SELECT id FROM expenses WHERE client_uuid = ?').get(uuid);
    if (existing) {
      results.push({ type: 'expense', client_uuid: uuid, status: 'duplicate', expense_id: existing.id });
      continue;
    }
    const amount = toNum(expense.amount, 0);
    if (amount <= 0 || !expense.category) {
      results.push({ type: 'expense', client_uuid: uuid, status: 'rejected', message: 'Invalid expense' });
      continue;
    }
    const result = db
      .prepare(
        `INSERT INTO expenses (expense_date, category, amount, note, spent_by, created_by, client_uuid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        expense.expense_date || localDate(expense.created_at || new Date()),
        String(expense.category),
        money(amount),
        expense.note || null,
        expense.spent_by || req.user.name,
        req.user.id,
        uuid,
        expense.created_at || nowISO(),
      );
    db.prepare(
      `INSERT INTO sync_log (device_id, client_uuid, entity, status, message, created_at)
       VALUES (?, ?, 'expense', 'synced', ?, ?)`,
    ).run(deviceId, uuid, `Expense ${amount}`, nowISO());
    results.push({ type: 'expense', client_uuid: uuid, status: 'synced', expense_id: Number(result.lastInsertRowid) });
  }

  for (const adj of stockAdjustments) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(adj?.product_id));
    const change = toNum(adj?.change_qty, 0);
    if (!product || change === 0) {
      results.push({ type: 'stock', product_id: adj?.product_id, status: 'rejected', message: 'Invalid stock adjustment' });
      continue;
    }
    const now = nowISO();
    const next = money(product.stock_qty + change);
    db.transaction(() => {
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(next, now, product.id);
      db.prepare(
        `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
         VALUES (?, ?, ?, 'adjustment', 'offline-sync', ?, ?, ?)`,
      ).run(product.id, change, next, adj.note || 'Offline adjustment', req.user.id, now);
    })();
    results.push({ type: 'stock', product_id: product.id, status: 'synced', balance_qty: next });
  }

  audit(req.user, 'sync.push', 'device', null, { deviceId, bills: bills.length, expenses: expenses.length });
  res.json({ device_id: deviceId, synced_at: nowISO(), results });
});

router.get('/log', authenticate, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ log: db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit) });
});

export default router;

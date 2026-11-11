import express from 'express';
import { db, audit } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError, money, nowISO, toInt } from '../util.js';
import { tableList } from './catalog.js';

const router = express.Router();

router.get('/', authenticate, (req, res) => {
  const tables = tableList();
  const summary = {
    total: tables.length,
    free: tables.filter((t) => t.status === 'free').length,
    occupied: tables.filter((t) => t.status === 'occupied').length,
    reserved: tables.filter((t) => t.status === 'reserved').length,
    cleaning: tables.filter((t) => t.status === 'cleaning').length,
  };
  res.json({ tables, summary });
});

router.post('/:id/status', authenticate, (req, res) => {
  const id = Number(req.params.id);
  const table = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id);
  if (!table) throw new HttpError(404, 'Table not found');
  const status = String(req.body?.status || '');
  if (!['free', 'occupied', 'reserved', 'cleaning'].includes(status)) {
    throw new HttpError(400, 'Invalid table status');
  }
  if (status === 'free' && table.current_order_id) {
    const open = db.prepare(`SELECT * FROM orders WHERE id = ? AND status = 'open'`).get(table.current_order_id);
    if (open) throw new HttpError(400, 'Settle or void the open tab before freeing this table');
  }
  db.prepare('UPDATE dining_tables SET status = ?, updated_at = ? WHERE id = ?').run(status, nowISO(), id);
  audit(req.user, 'table.status', 'table', id, { status });
  res.json({ table: db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id) });
});

/** Open a running tab on a table. */
router.post('/:id/open', authenticate, (req, res) => {
  const id = Number(req.params.id);
  const table = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id);
  if (!table) throw new HttpError(404, 'Table not found');
  if (table.current_order_id) {
    const open = db.prepare(`SELECT * FROM orders WHERE id = ? AND status = 'open'`).get(table.current_order_id);
    if (open) return res.json({ order: open, existing: true });
  }
  const now = nowISO();
  const date = req.body?.order_date || new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }).format(new Date());
  const guests = toInt(req.body?.guests, 1) || 1;
  const open = db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_date = ?').get(date).c;
    const orderNo = `ORD-${date.replaceAll('-', '')}-${String(count + 1).padStart(4, '0')}`;
    const result = db
      .prepare(
        `INSERT INTO orders (order_no, table_id, order_date, status, guests, subtotal, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, 0, ?, ?, ?)`,
      )
      .run(orderNo, id, date, guests, req.user.id, now, now);
    const orderId = Number(result.lastInsertRowid);
    db.prepare(`UPDATE dining_tables SET status = 'occupied', current_order_id = ?, updated_at = ? WHERE id = ?`).run(
      orderId,
      now,
      id,
    );
    db.prepare(
      `INSERT INTO table_sessions (table_id, order_id, guests, opened_by, opened_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, orderId, guests, req.user.id, now);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  })();
  audit(req.user, 'table.open', 'table', id, { order_no: open.order_no, guests });
  res.status(201).json({ order: open, table: db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id) });
});

export default router;

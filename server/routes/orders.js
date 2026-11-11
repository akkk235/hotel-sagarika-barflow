import express from 'express';
import { db, audit } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError, money, nowISO } from '../util.js';
import { createBill, billWithItems } from '../billing.js';

const router = express.Router();

function orderWithItems(orderId) {
  const order = db
    .prepare(
      `SELECT o.*, t.label AS table_label, t.zone AS table_zone
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id WHERE o.id = ?`,
    )
    .get(orderId);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  const subtotal = money(items.reduce((s, i) => s + i.line_total, 0));
  return { ...order, items, subtotal };
}

router.get('/', authenticate, (req, res) => {
  const status = req.query.status || 'open';
  const rows = db
    .prepare(
      `SELECT o.*, t.label AS table_label, t.zone AS table_zone,
              (SELECT COALESCE(SUM(oi.line_total),0) FROM order_items oi WHERE oi.order_id = o.id) AS amount,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
       WHERE o.status = ? ORDER BY o.id DESC LIMIT 100`,
    )
    .all(status);
  res.json({ orders: rows });
});

router.get('/:id', authenticate, (req, res) => {
  const order = orderWithItems(Number(req.params.id));
  if (!order) throw new HttpError(404, 'Tab not found');
  res.json({ order });
});

router.post('/:id/items', authenticate, (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new HttpError(404, 'Tab not found');
  if (order.status !== 'open') throw new HttpError(400, 'This tab is already closed');

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(req.body?.product_id));
  if (!product) throw new HttpError(400, 'Product not available');
  const variant = db
    .prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1')
    .get(Number(req.body?.variant_id), product.id);
  if (!variant) throw new HttpError(400, 'Select a valid serving size');
  const qty = Number(req.body?.qty ?? 1);
  if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');

  const now = nowISO();
  const add = db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? AND variant_id = ?')
      .get(orderId, variant.id);
    if (existing) {
      const newQty = money(existing.qty + qty);
      db.prepare('UPDATE order_items SET qty = ?, line_total = ? WHERE id = ?').run(
        newQty,
        money(newQty * existing.unit_price),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, ml, qty, unit_price, line_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        orderId,
        product.id,
        variant.id,
        product.name,
        variant.label,
        variant.ml,
        qty,
        money(variant.price),
        money(variant.price * qty),
        now,
      );
    }
    const subtotal = db
      .prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM order_items WHERE order_id = ?')
      .get(orderId).s;
    db.prepare('UPDATE orders SET subtotal = ?, updated_at = ? WHERE id = ?').run(money(subtotal), now, orderId);
  });
  add();
  res.status(201).json({ order: orderWithItems(orderId) });
});

router.patch('/:id/items/:itemId', authenticate, (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId);
  if (!item) throw new HttpError(404, 'Item not on this tab');
  const qty = Number(req.body?.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
  db.prepare('UPDATE order_items SET qty = ?, line_total = ? WHERE id = ?').run(
    money(qty),
    money(qty * item.unit_price),
    itemId,
  );
  const subtotal = db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM order_items WHERE order_id = ?').get(orderId).s;
  db.prepare('UPDATE orders SET subtotal = ?, updated_at = ? WHERE id = ?').run(money(subtotal), nowISO(), orderId);
  res.json({ order: orderWithItems(orderId) });
});

router.delete('/:id/items/:itemId', authenticate, (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(itemId, orderId);
  const subtotal = db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM order_items WHERE order_id = ?').get(orderId).s;
  db.prepare('UPDATE orders SET subtotal = ?, updated_at = ? WHERE id = ?').run(money(subtotal), nowISO(), orderId);
  res.json({ order: orderWithItems(orderId) });
});

/** Settle an open tab: creates the bill, records payment and deducts stock. */
router.post('/:id/pay', authenticate, (req, res) => {
  const orderId = Number(req.params.id);
  const order = orderWithItems(orderId);
  if (!order) throw new HttpError(404, 'Tab not found');
  if (order.status !== 'open') throw new HttpError(400, 'This tab is already settled');
  if (order.items.length === 0) throw new HttpError(400, 'Add at least one item before payment');

  const { bill, duplicate, warnings } = createBill({
    user: req.user,
    payload: {
      ...req.body,
      order_id: orderId,
      table_id: order.table_id,
      items: order.items.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id, qty: i.qty })),
    },
    deviceId: req.body?.device_id || req.headers['x-device-id'] || null,
    offline: Boolean(req.body?.offline),
  });
  res.status(duplicate ? 200 : 201).json({ bill: billWithItems(bill.id), duplicate, warnings });
});

router.post('/:id/void', authenticate, (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new HttpError(404, 'Tab not found');
  if (order.status !== 'open') throw new HttpError(400, 'Only an open tab can be cancelled');
  const now = nowISO();
  db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'void', updated_at = ? WHERE id = ?`).run(now, orderId);
    if (order.table_id) {
      db.prepare(`UPDATE dining_tables SET status = 'free', current_order_id = NULL, updated_at = ? WHERE id = ?`).run(
        now,
        order.table_id,
      );
      db.prepare('UPDATE table_sessions SET closed_at = ? WHERE table_id = ? AND closed_at IS NULL').run(now, order.table_id);
    }
  })();
  audit(req.user, 'order.void', 'order', orderId, { order_no: order.order_no });
  res.json({ ok: true });
});

export default router;

import express from 'express';
import { db, audit } from '../db.js';
import { authenticate, manager } from '../auth.js';
import { HttpError, addDays, firstOfMonth, money, nowISO, today, toNum } from '../util.js';
import { dashboardSummary } from '../billing.js';

const router = express.Router();

function range(req) {
  const to = req.query.to || today();
  const from = req.query.from || firstOfMonth(to);
  return { from, to };
}

router.get('/dashboard', authenticate, (req, res) => {
  const date = req.query.date || today();
  const summary = dashboardSummary(date);
  const recent = db
    .prepare(
      `SELECT id, bill_no, total, payment_mode, table_label, cashier_name, created_at
       FROM bills WHERE bill_date = ? AND status = 'paid' ORDER BY id DESC LIMIT 8`,
    )
    .all(date);
  const topItems = db
    .prepare(
      `SELECT oi.product_name, oi.variant_label, SUM(oi.qty) AS qty, SUM(oi.line_total) AS amount
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       WHERE b.bill_date = ? AND b.status = 'paid'
       GROUP BY oi.product_name, oi.variant_label ORDER BY amount DESC LIMIT 6`,
    )
    .all(date);
  const openTabs = db
    .prepare(
      `SELECT o.id, o.order_no, o.created_at, t.label AS table_label,
              (SELECT COALESCE(SUM(line_total),0) FROM order_items WHERE order_id = o.id) AS amount
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
       WHERE o.status = 'open' ORDER BY o.id DESC`,
    )
    .all();
  const lowStock = db
    .prepare(
      `SELECT id, name, stock_qty, low_stock_qty, unit_type FROM products
       WHERE is_active = 1 AND stock_qty <= low_stock_qty ORDER BY stock_qty LIMIT 8`,
    )
    .all();
  const weekTrend = db
    .prepare(
      `SELECT bill_date AS date, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills
       FROM bills WHERE status = 'paid' AND bill_date BETWEEN ? AND ?
       GROUP BY bill_date ORDER BY bill_date`,
    )
    .all(addDays(date, -6), date);
  res.json({ summary, recent, top_items: topItems, open_tabs: openTabs, low_stock: lowStock, trend: weekTrend });
});

router.get('/sales', authenticate, (req, res) => {
  const { from, to } = range(req);
  const daily = db
    .prepare(
      `SELECT bill_date AS date, COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue,
              COALESCE(SUM(cash_amount),0) AS cash, COALESCE(SUM(upi_amount),0) AS upi,
              COALESCE(SUM(card_amount),0) AS card
       FROM bills WHERE status = 'paid' AND deleted_at IS NULL AND bill_date BETWEEN ? AND ?
       GROUP BY bill_date ORDER BY bill_date DESC`,
    )
    .all(from, to);
  const totals = daily.reduce(
    (acc, d) => ({
      bills: acc.bills + d.bills,
      revenue: money(acc.revenue + d.revenue),
      cash: money(acc.cash + d.cash),
      upi: money(acc.upi + d.upi),
      card: money(acc.card + d.card),
    }),
    { bills: 0, revenue: 0, cash: 0, upi: 0, card: 0 },
  );
  const byMode = db
    .prepare(
      `SELECT payment_mode AS mode, COUNT(*) AS bills, COALESCE(SUM(total),0) AS amount
       FROM bills WHERE status = 'paid' AND deleted_at IS NULL AND bill_date BETWEEN ? AND ?
       GROUP BY payment_mode ORDER BY amount DESC`,
    )
    .all(from, to);
  const byCashier = db
    .prepare(
      `SELECT cashier_name AS cashier, COUNT(*) AS bills, COALESCE(SUM(total),0) AS amount
       FROM bills WHERE status = 'paid' AND bill_date BETWEEN ? AND ?
       GROUP BY cashier_name ORDER BY amount DESC`,
    )
    .all(from, to);
  res.json({ from, to, daily, totals, by_mode: byMode, by_cashier: byCashier });
});

router.get('/items', authenticate, (req, res) => {
  const { from, to } = range(req);
  const items = db
    .prepare(
      `SELECT oi.product_name, oi.variant_label, SUM(oi.qty) AS qty, SUM(oi.line_total) AS amount,
              SUM(oi.ml * oi.qty) AS total_ml
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       WHERE b.status = 'paid' AND b.bill_date BETWEEN ? AND ?
       GROUP BY oi.product_id, oi.variant_label ORDER BY amount DESC LIMIT 100`,
    )
    .all(from, to);
  res.json({ from, to, items });
});

router.get('/stock', authenticate, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.unit_type, p.stock_qty, p.low_stock_qty, p.bottle_size_ml, p.cost_price,
              c.name AS category_name,
              (SELECT COALESCE(SUM(l.change_qty),0) FROM stock_ledger l WHERE l.product_id = p.id AND l.movement = 'sale') AS sold_qty,
              (SELECT COALESCE(SUM(oi.line_total),0) FROM order_items oi WHERE oi.product_id = p.id) AS sales_value
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 ORDER BY c.sort_order, p.name`,
    )
    .all();
  const value = money(rows.reduce((s, r) => s + r.stock_qty * r.cost_price, 0));
  res.json({
    stock: rows,
    totals: {
      products: rows.length,
      low: rows.filter((r) => r.stock_qty <= r.low_stock_qty).length,
      out: rows.filter((r) => r.stock_qty <= 0).length,
      stock_value: value,
    },
  });
});

router.get('/expenses', authenticate, (req, res) => {
  const { from, to } = range(req);
  const rows = db
    .prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC')
    .all(from, to);
  const total = money(rows.reduce((s, r) => s + r.amount, 0));
  res.json({ from, to, expenses: rows, total });
});

router.post('/expenses', authenticate, manager, (req, res) => {
  const { category, amount, note, spent_by, expense_date, client_uuid } = req.body || {};
  const amt = toNum(amount, 0);
  if (!category || amt <= 0) throw new HttpError(400, 'Category and a positive amount are required');
  if (client_uuid) {
    const dup = db.prepare('SELECT * FROM expenses WHERE client_uuid = ?').get(client_uuid);
    if (dup) return res.json({ expense: dup, duplicate: true });
  }
  const result = db
    .prepare(
      `INSERT INTO expenses (expense_date, category, amount, note, spent_by, created_by, client_uuid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(expense_date || today(), String(category), money(amt), note || null, spent_by || req.user.name, req.user.id, client_uuid || null, nowISO());
  audit(req.user, 'expense.create', 'expense', Number(result.lastInsertRowid), { category, amount: amt });
  res.status(201).json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid) });
});

router.delete('/expenses/:id', authenticate, manager, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
  audit(req.user, 'expense.delete', 'expense', Number(req.params.id), null);
  res.json({ ok: true });
});

router.get('/customers', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY loyalty_points DESC, id DESC LIMIT 200').all();
  res.json({ customers: rows });
});

export default router;

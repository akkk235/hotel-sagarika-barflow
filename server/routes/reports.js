import express from 'express';
import { db, audit } from '../db.js';
import { authenticate, manager, requireRole, verifyOwnerPin } from '../auth.js';
import { HttpError, addDays, firstOfMonth, money, nowISO, today, toNum } from '../util.js';
import { dashboardSummary } from '../billing.js';
import {
  REPORT_DEFS,
  assertReportAccess,
  buildReport,
  parseFilters,
  reportCompare,
} from '../reports.js';
import { buildPdf, buildReportHtml, buildXlsx } from '../export.js';

const ownerOnly = requireRole('owner');

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
      `SELECT id, bill_no, total, payment_mode, table_label, cashier_name, created_at, status, deleted_at
       FROM bills WHERE bill_date = ? AND status = 'paid' AND deleted_at IS NULL ORDER BY id DESC LIMIT 8`,
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

/* ============================================================ ANALYTICS API */

const BUSINESS = 'Hotel Sagarika';
const periodLabel = (f) => (f.from === f.to ? f.from : `${f.from} to ${f.to}`);
const stamp = () =>
  new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Parse filters and enforce the role rules before any data is read. */
function scopedFilters(name, req, override) {
  const f = parseFilters(req.query);
  const denied = assertReportAccess(name, req.user, f, override);
  if (denied) throw new HttpError(denied.status, denied.message);
  return f;
}

function totalsLine(totals) {
  const parts = Object.entries(totals || {})
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  return parts.length ? `Totals — ${parts.join(' · ')}` : '';
}

/** Every report: /api/reports/report/daily?from=&to=&staff_id=&product_id=... */
router.get('/report/:name', authenticate, (req, res) => {
  const name = String(req.params.name);
  if (!REPORT_DEFS[name]) throw new HttpError(404, 'Unknown report');
  const f = scopedFilters(name, req);
  const report = buildReport(name, f, req.user);
  if (!report) throw new HttpError(404, 'Unknown report');
  res.json({ report, filters: f, role: req.user.role, generated_at: nowISO() });
});

/** Two-period comparison (Owner only — it spans historical periods). */
router.get('/compare', authenticate, (req, res) => {
  if (req.user.role !== 'owner') {
    throw new HttpError(403, 'Period comparison is available to the Owner only');
  }
  const { from_a, to_a, from_b, to_b } = req.query;
  const report = reportCompare(from_a, to_a, from_b, to_b);
  res.json({ report });
});

/** Excel / PDF / printable HTML for any report the caller may view. */
router.get('/export', authenticate, (req, res) => {
  const name = String(req.query.report || 'daily');
  const format = String(req.query.format || 'pdf').toLowerCase();
  let report;
  let f;
  if (name === 'compare') {
    if (req.user.role !== 'owner') {
      throw new HttpError(403, 'Period comparison is available to the Owner only');
    }
    f = { from: req.query.from_a || '', to: req.query.to_b || req.query.to_a || '' };
    report = reportCompare(req.query.from_a, req.query.to_a, req.query.from_b, req.query.to_b);
  } else {
    if (!REPORT_DEFS[name]) throw new HttpError(404, 'Unknown report');
    f = scopedFilters(name, req);
    report = buildReport(name, f, req.user);
  }
  if (!report) throw new HttpError(404, 'Nothing to export');

  const columns = (report.columns || []).map((c) => (Array.isArray(c) ? c[0] : String(c?.label ?? c)));
  const rows = (report.rows || []).map((r) => (Array.isArray(r) ? r : Object.values(r)));
  const meta = [
    BUSINESS,
    report.title || name,
    `Period: ${periodLabel(f)}`,
    `Generated: ${stamp()}`,
    `Generated by: ${req.user.name} (${req.user.role})`,
  ];
  const totals = totalsLine(report.totals);
  if (totals) meta.push(totals);

  const base = `hotel-sagarika-${name}-${(f.from || 'from')}_${(f.to || 'to')}`;
  if (format === 'xlsx' || format === 'excel') {
    const buf = buildXlsx({ title: `${BUSINESS} — ${report.title || name}`, meta, columns, rows, sheetName: (report.title || name).slice(0, 28) });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(buf);
  }
  if (format === 'html' || format === 'print') {
    return res.type('html').send(
      buildReportHtml({ title: `${BUSINESS} — ${report.title || name}`, meta, columns, rows, note: [report.note, totals].filter(Boolean).join(' ') }),
    );
  }
  const buf = buildPdf({
    title: `${BUSINESS} — ${report.title || name}`,
    meta,
    columns,
    rows,
    footerNote: [report.note, totals].filter(Boolean).join(' '),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
  return res.send(buf);
});

/** Declare opening / closing cash for a business day (daily closing statement). */
router.post('/cash-session', authenticate, manager, (req, res) => {
  const sessionDate = String(req.body?.session_date || today()).slice(0, 10);
  const opening = req.body?.opening_cash === undefined ? null : toNum(req.body.opening_cash, 0);
  const closing = req.body?.closing_cash === undefined ? null : toNum(req.body.closing_cash, 0);
  const now = nowISO();
  const existing = db.prepare('SELECT * FROM cash_sessions WHERE session_date = ?').get(sessionDate);
  if (existing) {
    db.prepare(
      `UPDATE cash_sessions SET opening_cash = ?, closing_cash = ?, note = ?, closed_by = ?, updated_at = ?
       WHERE session_date = ?`,
    ).run(
      opening === null ? existing.opening_cash : opening,
      closing === null ? existing.closing_cash : closing,
      req.body?.note ?? existing.note,
      closing === null ? existing.closed_by : req.user.id,
      now,
      sessionDate,
    );
  } else {
    db.prepare(
      `INSERT INTO cash_sessions (session_date, opening_cash, closing_cash, note, opened_by, closed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionDate, opening ?? 0, closing, req.body?.note || null, req.user.id, closing === null ? null : req.user.id, now, now);
  }
  audit(req.user, 'cash_session.save', 'cash_session', sessionDate, { opening, closing });
  res.json({ session: db.prepare('SELECT * FROM cash_sessions WHERE session_date = ?').get(sessionDate) });
});

/** Owner-authorised refund against an original bill (bill and payment record are kept). */
router.post('/refunds', authenticate, ownerOnly, (req, res) => {
  const billId = Number(req.body?.bill_id);
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) throw new HttpError(404, 'Bill not found');
  if (bill.deleted_at) throw new HttpError(400, 'This bill was deleted; it cannot be refunded');
  const pinCheck = verifyOwnerPin(req.user, req.body?.pin);
  if (!pinCheck.ok) throw new HttpError(pinCheck.status || 403, pinCheck.message || 'Owner PIN is incorrect');
  const already = toNum(bill.refund_amount, 0);
  const amount = money(toNum(req.body?.amount, 0));
  if (amount <= 0) throw new HttpError(400, 'Refund amount must be greater than zero');
  if (money(already + amount) > money(bill.total)) throw new HttpError(400, 'Refund exceeds the bill amount');
  const now = nowISO();
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 240) : null;
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE bills SET refund_amount = ?, refund_reason = ?, refunded_at = ?, refunded_by = ?, status = 'refunded'
       WHERE id = ?`,
    ).run(money(already + amount), reason, now, req.user.id, billId);
    db.prepare(
      `INSERT INTO refunds (bill_id, bill_no, amount, reason, approved_by, performed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(billId, bill.bill_no, amount, reason, req.user.id, req.user.id, now);
  });
  run();
  audit(req.user, 'bill.refund', 'bill', billId, { amount, reason });
  res.json({ bill: db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) });
});

/** Staff list for the report filters (management only). */
router.get('/staff-options', authenticate, manager, (req, res) => {
  const staff = db
    .prepare("SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, name")
    .all();
  res.json({ staff });
});

export default router;

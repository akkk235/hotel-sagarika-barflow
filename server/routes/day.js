import express from 'express';
import { db, audit } from '../db.js';
import { authenticate, manager, requireRole, verifyOwnerPin } from '../auth.js';
import { HttpError, addDays, money, nowISO, today, toNum } from '../util.js';
import { buildPdf, buildReportHtml, buildXlsx } from '../export.js';
import {
  addCashMovement,
  addStockAdjustment,
  businessDate,
  cashMovementsForDay,
  cashReceivedEnabled,
  cashSummary,
  closeDay,
  dayHistory,
  daySession,
  dayStatus,
  dayTransactions,
  openDay,
  openingPreview,
  refundsForDay,
  reopenDay,
  saveStockCount,
  setCashReceivedEnabled,
  staffSalesForDay,
  stockReconciliation,
} from '../daybook.js';

const router = express.Router();
const owner = requireRole('owner');
const BUSINESS = 'Hotel Sagarika';

function dateParam(req) {
  return businessDate(req.query.date || req.body?.date || today());
}

/** Managers may only touch today's figures; the Owner can look back. */
function assertRangeAccess(user, from, to) {
  if (user?.role === 'owner') return;
  if (from !== today() || to !== today()) {
    throw new HttpError(403, "Managers can only access today's closing figures");
  }
}

function requirePin(user, pin) {
  const check = verifyOwnerPin(user, pin);
  if (!check.ok) throw new HttpError(check.status || 403, check.message || 'Owner PIN verification failed');
  return check;
}

/** Staff see the day state but not the financial detail. */
function staffView(date, status) {
  return {
    date,
    status: status.status,
    label: status.label,
    opened: Boolean(status.session),
    opening_cash: status.session ? money(status.session.opening_cash) : null,
    closed: status.session?.status === 'closed',
    stock: { products: status.stock.products, counted: status.stock.counted, pending: status.stock.pending },
    permissions: { canOpen: false, canClose: false, canCount: false, canReopen: false, canAdjust: false },
  };
}

function permissionsFor(user, date, status) {
  const role = user?.role;
  const closed = status.session?.status === 'closed';
  return {
    role,
    canOpen: role === 'manager' || role === 'owner',
    canClose: (role === 'manager' || role === 'owner') && Boolean(status.session) && !closed,
    canCount: (role === 'manager' || role === 'owner') && Boolean(status.session) && !closed,
    canAdjust: role === 'owner' && !closed,
    canReopen: role === 'owner' && closed,
    canViewHistory: role === 'owner',
    canExportAll: role === 'owner',
    cashReceivedEnabled: cashReceivedEnabled(),
    date_is_today: date === today(),
  };
}

router.get('/status', authenticate, (req, res) => {
  const date = dateParam(req);
  const status = dayStatus(date);
  if (req.user.role === 'staff') return res.json(staffView(date, status));
  res.json({
    ...status,
    permissions: permissionsFor(req.user, date, status),
    opening_preview: daySession(date) ? undefined : openingPreview(date),
  });
});

router.get('/opening', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  res.json({
    date,
    session: daySession(date),
    preview: openingPreview(date),
    is_today: date === today(),
    cash_received_enabled: cashReceivedEnabled(),
  });
});

router.post('/opening', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  const result = openDay({
    user: req.user,
    date,
    opening_cash: req.body?.opening_cash,
    opening_upi: req.body?.opening_upi,
    remarks: req.body?.remarks,
  });
  res.status(201).json({ ...result, status: dayStatus(date) });
});

router.post('/opening/correct', authenticate, owner, (req, res) => {
  const date = dateParam(req);
  requirePin(req.user, req.body?.pin);
  const result = openDay({
    user: req.user,
    date,
    opening_cash: req.body?.opening_cash,
    opening_upi: req.body?.opening_upi,
    remarks: req.body?.remarks,
    correction: true,
  });
  res.json({ ...result, status: dayStatus(date) });
});

router.get('/summary', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  assertRangeAccess(req.user, date, date);
  const status = dayStatus(date);
  res.json({
    date,
    status,
    permissions: permissionsFor(req.user, date, status),
    cash: cashSummary(date),
    staff_sales: staffSalesForDay(date),
    refunds: refundsForDay(date),
    transactions: dayTransactions(date),
    cash_movements: cashMovementsForDay(date),
    stock: status.stock,
  });
});

router.get('/stock', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  assertRangeAccess(req.user, date, date);
  const session = daySession(date);
  res.json({
    date,
    session,
    closed: session?.status === 'closed',
    products: stockReconciliation(date),
    permissions: permissionsFor(req.user, date, dayStatus(date)),
  });
});

router.post('/stock/count', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  const productId = req.body?.product_id;
  const row = saveStockCount({
    user: req.user,
    date,
    product_id: productId,
    actual_bottles: req.body?.actual_bottles,
    actual_loose_ml: req.body?.actual_loose_ml,
    reason: req.body?.reason,
  });
  res.json({ product: row, status: dayStatus(date) });
});

router.post('/stock/adjustment', authenticate, owner, (req, res) => {
  const date = dateParam(req);
  const result = addStockAdjustment({
    user: req.user,
    date,
    product_id: req.body?.product_id,
    direction: req.body?.direction,
    qty: req.body?.qty,
    loose_ml: req.body?.loose_ml,
    reason: req.body?.reason,
    client_uuid: req.body?.client_uuid,
  });
  res.status(201).json({ ...result, products: stockReconciliation(date), status: dayStatus(date) });
});

router.get('/cash', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  assertRangeAccess(req.user, date, date);
  res.json({
    date,
    cash: cashSummary(date),
    movements: cashMovementsForDay(date),
    cash_received_enabled: cashReceivedEnabled(),
  });
});

router.post('/cash', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  const kind = req.body?.kind === 'in' ? 'in' : 'out';
  if (kind === 'in' && req.user.role !== 'owner') {
    throw new HttpError(403, 'Only the Owner can record cash received from other sources');
  }
  const result = addCashMovement({
    user: req.user,
    date,
    kind,
    amount: req.body?.amount,
    note: req.body?.note,
    client_uuid: req.body?.client_uuid,
  });
  res.status(201).json({ ...result, cash: cashSummary(date) });
});

router.post('/close', authenticate, manager, (req, res) => {
  const date = dateParam(req);
  const status = closeDay({
    user: req.user,
    date,
    actual_cash: req.body?.actual_cash,
    remarks: req.body?.remarks,
  });
  res.json({ ...status, permissions: permissionsFor(req.user, date, status) });
});

router.post('/reopen', authenticate, owner, (req, res) => {
  const date = dateParam(req);
  requirePin(req.user, req.body?.pin);
  const status = reopenDay({ user: req.user, date, reason: req.body?.reason });
  res.json({ ...status, permissions: permissionsFor(req.user, date, status) });
});

router.get('/history', authenticate, (req, res) => {
  const to = businessDate(req.query.to || today());
  const from = businessDate(req.query.from || addDays(to, -30));
  if (req.user.role === 'staff') throw new HttpError(403, 'Staff cannot access closing history');
  assertRangeAccess(req.user, from, to);
  res.json({ from, to, days: dayHistory({ from, to }) });
});

router.get('/audit', authenticate, owner, (req, res) => {
  const date = dateParam(req);
  const rows = db
    .prepare(
      `SELECT * FROM audit_log
        WHERE (entity = 'day_session' AND entity_id = ?)
           OR (entity = 'product' AND action IN ('stock_count','stock_adjustment')
               AND detail LIKE ?)
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
    )
    .all(date, `%${date}%`);
  res.json({ date, audit: rows });
});

router.get('/settings', authenticate, manager, (req, res) => {
  res.json({ cash_received_enabled: cashReceivedEnabled() });
});

router.put('/settings', authenticate, owner, (req, res) => {
  const enabled = Boolean(req.body?.cash_received_enabled);
  setCashReceivedEnabled(enabled);
  audit(req.user, 'day_settings', 'setting', 'cash_received_enabled', { enabled });
  res.json({ cash_received_enabled: cashReceivedEnabled() });
});

/* ---------------------------- day reports ---------------------------- */

const REPORT_DEFS = {
  daily_cash: { title: 'Daily Opening & Closing Cash', kind: 'range' },
  upi: { title: 'Daily UPI Collection', kind: 'date' },
  sales: { title: 'Daily Sales', kind: 'date' },
  expenses: { title: 'Daily Expenses', kind: 'date' },
  stock: { title: 'Daily Product-wise Stock', kind: 'date' },
  liquor: { title: 'Liquor Bottle-wise Stock', kind: 'date' },
  difference: { title: 'Physical Stock Difference', kind: 'date' },
  staff: { title: 'Staff-wise Sales', kind: 'date' },
  monthly_cash: { title: 'Monthly Cash Closing Summary', kind: 'range' },
  monthly_stock: { title: 'Monthly Stock Movement', kind: 'range' },
};

function reportPayload(name, { from, to }) {
  const def = REPORT_DEFS[name];
  if (!def) throw new HttpError(404, 'Unknown report');

  if (name === 'daily_cash') {
    const days = dayHistory({ from, to });
    const columns = [
      'Date', 'Opening Cash', 'Cash Sales', 'Cash Received', 'Cash Expenses', 'Cash Refunds',
      'Expected Cash', 'Actual Cash', 'Difference', 'UPI Collected', 'Total Sales', 'Status',
    ];
    const rows = days
      .slice()
      .reverse()
      .map((d) => [
        d.business_date,
        d.cash.opening_cash,
        d.cash.cash_sales,
        d.cash.cash_received,
        d.cash.cash_expenses,
        d.cash.cash_refunds,
        d.cash.expected_cash,
        d.cash.actual_cash ?? '',
        d.cash.cash_difference ?? '',
        d.cash.upi_sales,
        d.cash.total_sales,
        d.status === 'closed' ? 'Closed' : 'Open',
      ]);
    return {
      title: def.title,
      meta: [`Period: ${from} to ${to}`],
      columns,
      rows,
      note: 'Expected cash = opening + cash sales + cash received - cash expenses - cash refunds. UPI is shown separately and never counted as physical cash.',
    };
  }

  if (name === 'upi') {
    const bills = db
      .prepare(
        `SELECT b.bill_no, b.created_at, b.upi_amount, b.upi_ref, b.total, u.name AS staff_name, t.name AS table_name
           FROM bills b
           LEFT JOIN users u ON u.id = b.created_by
           LEFT JOIN restaurant_tables t ON t.id = b.table_id
          WHERE b.bill_date = ? AND b.status = 'paid' AND b.deleted_at IS NULL AND b.upi_amount > 0
          ORDER BY b.created_at`,
      )
      .all(from);
    const total = bills.reduce((s, b) => s + Number(b.upi_amount || 0), 0);
    return {
      title: def.title,
      meta: [`Date: ${from}`],
      columns: ['Bill No', 'Time', 'Table', 'Staff', 'UPI Reference', 'Bill Total', 'UPI Amount'],
      rows: bills.map((b) => [
        b.bill_no,
        String(b.created_at || '').slice(11, 16),
        b.table_name || '-',
        b.staff_name || '-',
        b.upi_ref || '-',
        money(b.total),
        money(b.upi_amount),
      ]),
      note: `Total UPI collected: INR ${money(total).toFixed(2)} across ${bills.length} bill(s).`,
    };
  }

  if (name === 'sales') {
    const tx = dayTransactions(from);
    return {
      title: def.title,
      meta: [`Date: ${from}`],
      columns: ['Bill No', 'Time', 'Table', 'Staff', 'Payment', 'Cash', 'UPI', 'Total'],
      rows: tx.bills.map((b) => [
        b.bill_no,
        String(b.created_at || '').slice(11, 16),
        b.table_name || '-',
        b.staff_name || '-',
        b.payment_mode,
        money(b.cash_amount),
        money(b.upi_amount),
        money(b.total),
      ]),
      note: 'Only paid bills are listed. Deleted and void bills are excluded from active sales.',
    };
  }

  if (name === 'expenses') {
    const rows = db
      .prepare('SELECT * FROM expenses WHERE expense_date = ? ORDER BY created_at')
      .all(from);
    return {
      title: def.title,
      meta: [`Date: ${from}`],
      columns: ['Category', 'Note', 'Spent By', 'Amount'],
      rows: rows.map((e) => [e.category, e.note || '-', e.spent_by || '-', money(e.amount)]),
      note: `Total cash expenses: INR ${money(rows.reduce((s, e) => s + Number(e.amount || 0), 0)).toFixed(2)}`,
    };
  }

  if (name === 'stock' || name === 'liquor' || name === 'difference') {
    const products = stockReconciliation(from);
    if (name === 'difference') {
      const rows = products.filter((p) => p.counted && Math.abs(p.difference || 0) > 0.0001);
      return {
        title: def.title,
        meta: [`Date: ${from}`],
        columns: ['Product', 'Category', 'Expected', 'Actual', 'Difference', 'Reason', 'Counted By'],
        rows: rows.map((p) => [
          p.name,
          p.category_name,
          p.expected,
          p.actual,
          p.difference,
          p.reason || '-',
          p.counted_by_name || '-',
        ]),
        note: `${rows.length} product(s) with a physical stock difference.`,
      };
    }
    if (name === 'liquor') {
      const liquor = products.filter((p) => p.is_liquor);
      return {
        title: def.title,
        meta: [`Date: ${from}`],
        columns: [
          'Brand', 'Opening (bottles)', 'Sold (ml)', 'Sold (bottles)', 'Expected Sealed', 'Expected Loose (ml)',
          'Actual Sealed', 'Actual Loose (ml)', 'Difference', 'Revenue',
        ],
        rows: liquor.map((p) => [
          p.name,
          p.opening,
          p.sales_ml,
          p.sales,
          p.sealed_bottles,
          p.loose_ml,
          p.actual_sealed_bottles ?? '',
          p.actual_loose_ml ?? '',
          p.difference ?? '',
          p.sales_amount,
        ]),
        note: 'Liquor is maintained in sealed 180 ml bottles: 30 ml = 1/6, 60 ml = 1/3, 90 ml = 1/2, 120 ml = 2/3, 150 ml = 5/6, 180 ml = 1 bottle.',
      };
    }
    return {
      title: def.title,
      meta: [`Date: ${from}`],
      columns: [
        'Product', 'Category', 'Opening', 'Purchases', 'Sold', 'Adj In', 'Adj Out',
        'Expected', 'Actual', 'Difference', 'Reason',
      ],
      rows: products.map((p) => [
        p.name,
        p.category_name,
        p.opening,
        p.purchases,
        p.sales,
        p.adjustments_in,
        p.adjustments_out,
        p.expected,
        p.actual ?? '',
        p.difference ?? '',
        p.reason || '-',
      ]),
      note: 'Expected closing = opening + purchases + adjustments in - sales - adjustments out.',
    };
  }

  if (name === 'staff') {
    const staff = staffSalesForDay(from);
    return {
      title: def.title,
      meta: [`Date: ${from}`],
      columns: ['Staff', 'Role', 'Bills', 'Cash Collected', 'UPI Collected', 'Total Sales'],
      rows: staff.map((s) => [s.staff_name, s.role || '-', s.bills, s.cash, s.upi, s.total]),
      note: 'Only paid, non-deleted bills are counted.',
    };
  }

  if (name === 'monthly_cash') {
    const days = dayHistory({ from, to });
    const buckets = new Map();
    for (const d of days) {
      const month = d.business_date.slice(0, 7);
      const b = buckets.get(month) || { month, days: 0, opening: 0, cash: 0, upi: 0, expenses: 0, refunds: 0, expected: 0, actual: 0, diff: 0 };
      b.days += 1;
      b.cash += d.cash.cash_sales;
      b.upi += d.cash.upi_sales;
      b.expenses += d.cash.cash_expenses;
      b.refunds += d.cash.cash_refunds;
      b.expected += d.cash.expected_cash;
      b.actual += d.cash.actual_cash ?? 0;
      b.diff += d.cash.cash_difference ?? 0;
      b.opening += d.cash.opening_cash;
      buckets.set(month, b);
    }
    const rows = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
    return {
      title: def.title,
      meta: [`Period: ${from} to ${to}`],
      columns: ['Month', 'Days Closed', 'Opening Cash', 'Cash Sales', 'UPI Sales', 'Expenses', 'Refunds', 'Expected Cash', 'Actual Cash', 'Difference'],
      rows: rows.map((b) => [
        b.month, b.days, money(b.opening), money(b.cash), money(b.upi),
        money(b.expenses), money(b.refunds), money(b.expected), money(b.actual), money(b.diff),
      ]),
      note: 'Monthly totals are summed from the locked daily closing records.',
    };
  }

  // monthly_stock
  const products = db.prepare('SELECT id, name FROM products WHERE is_active = 1 ORDER BY name').all();
  const rows = products.map((p) => {
    const first = db
      .prepare('SELECT opening_qty FROM day_stock_openings WHERE product_id = ? AND business_date BETWEEN ? AND ? ORDER BY business_date LIMIT 1')
      .get(p.id, from, to);
    const purchases = db
      .prepare(
        `SELECT COALESCE(SUM(pi.bottles), 0) AS qty FROM purchase_items pi
           JOIN purchases pu ON pu.id = pi.purchase_id
          WHERE pi.product_id = ? AND pu.purchase_date BETWEEN ? AND ?`,
      )
      .get(p.id, from, to);
    const sales = db
      .prepare(
        `SELECT COALESCE(SUM(oi.qty), 0) AS qty, COALESCE(SUM(COALESCE(oi.ml,0) * oi.qty), 0) AS ml
           FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
          WHERE oi.product_id = ? AND b.bill_date BETWEEN ? AND ?
            AND b.status = 'paid' AND b.deleted_at IS NULL`,
      )
      .get(p.id, from, to);
    const product = db.prepare('SELECT unit_type, bottle_size_ml FROM products WHERE id = ?').get(p.id);
    const soldBottles = product.unit_type === 'ml' ? Number(sales.ml || 0) / (Number(product.bottle_size_ml) || 180) : Number(sales.qty || 0);
    const lastCount = db
      .prepare('SELECT actual_qty FROM day_stock_counts WHERE product_id = ? AND business_date BETWEEN ? AND ? ORDER BY business_date DESC LIMIT 1')
      .get(p.id, from, to);
    const opening = Number(first?.opening_qty || 0);
    const closing = lastCount ? Number(lastCount.actual_qty) : opening + Number(purchases.qty || 0) - soldBottles;
    return [p.name, opening, Number(purchases.qty || 0), Math.round(soldBottles * 10000) / 10000, Math.round(closing * 10000) / 10000];
  });
  return {
    title: def.title,
    meta: [`Period: ${from} to ${to}`],
    columns: ['Product', 'Opening', 'Purchases', 'Sold', 'Closing'],
    rows,
    note: 'Closing uses the last physical count in the period when one exists.',
  };
}

router.get('/reports/:name', authenticate, manager, (req, res) => {
  const name = String(req.params.name);
  const def = REPORT_DEFS[name];
  if (!def) throw new HttpError(404, 'Unknown report');
  const to = businessDate(req.query.to || req.query.date || today());
  const from = businessDate(req.query.from || (def.kind === 'range' ? addDays(to, -30) : to));
  assertRangeAccess(req.user, from, to);

  const report = reportPayload(name, { from, to });
  const format = String(req.query.format || 'json').toLowerCase();
  const generatedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
  const meta = [
    `Business: ${BUSINESS}`,
    ...report.meta,
    `Generated: ${generatedAt}`,
    `By: ${req.user.name} (${req.user.role})`,
  ];

  if (format === 'json') {
    return res.json({ name, title: report.title, from, to, meta, columns: report.columns, rows: report.rows, note: report.note });
  }

  const safe = `${name}-${from}${from === to ? '' : `_${to}`}`;
  if (format === 'xlsx' || format === 'excel') {
    const buf = buildXlsx({
      title: `${BUSINESS} — ${report.title}`,
      meta,
      columns: report.columns,
      rows: report.rows,
      sheetName: report.title.slice(0, 28),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
    return res.send(buf);
  }
  if (format === 'html' || format === 'print') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(
      buildReportHtml({ title: `${BUSINESS} — ${report.title}`, meta, columns: report.columns, rows: report.rows, note: report.note || '' }),
    );
  }
  const buf = buildPdf({
    title: `${BUSINESS} — ${report.title}`,
    meta,
    columns: report.columns,
    rows: report.rows,
    footerNote: report.note || '',
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
  return res.send(buf);
});

router.get('/report-list', authenticate, manager, (req, res) => {
  res.json({
    reports: Object.entries(REPORT_DEFS).map(([name, def]) => ({ name, title: def.title, kind: def.kind })),
    generated_at: nowISO(),
  });
});

export default router;

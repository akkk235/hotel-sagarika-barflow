/**
 * Hotel Sagarika BarFlow — reports engine.
 *
 * Every report is built once here and reused by the JSON API, the Excel/PDF/HTML
 * exporters and the daily closing statement, so all outputs agree with each other
 * and with the transaction records.
 *
 * Rules enforced here:
 *  - Only paid, non-deleted bills count as active sales (deleted bills stay visible
 *    in the cancellation report and in bill_deletions).
 *  - Liquor stock is 180 ml bottle equivalents; 30 ml = 1/6 bottle etc.
 *  - Purchases are inventory, never a second operating expense next to COGS.
 *  - Missing purchase costs are reported as incomplete instead of being treated as 0.
 */
import { db } from './db.js';
import { addDays, today } from './util.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n = (v) => Number(v) || 0;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const POURS = [
  { ml: 30, fraction: 1 / 6, label: '30 ml' },
  { ml: 60, fraction: 1 / 3, label: '60 ml' },
  { ml: 90, fraction: 1 / 2, label: '90 ml' },
  { ml: 120, fraction: 2 / 3, label: '120 ml' },
  { ml: 150, fraction: 5 / 6, label: '150 ml' },
  { ml: 180, fraction: 1, label: '180 ml' },
];

export function parseFilters(query = {}) {
  const to = String(query.to || today());
  const from = String(query.from || to);
  const f = { from, to };
  if (query.product_id) f.product_id = Number(query.product_id);
  if (query.category_id) f.category_id = Number(query.category_id);
  if (query.staff_id) f.staff_id = Number(query.staff_id);
  if (query.payment_mode && query.payment_mode !== 'all') f.payment_mode = String(query.payment_mode);
  if (query.table_id) f.table_id = Number(query.table_id);
  if (query.group) f.group = String(query.group);
  return f;
}

function salesWhere(f, alias = 'b') {
  const params = { from: f.from, to: f.to };
  const clauses = [
    `${alias}.bill_date BETWEEN @from AND @to`,
    `${alias}.status = 'paid'`,
    `${alias}.deleted_at IS NULL`,
  ];
  if (f.staff_id) {
    clauses.push(`${alias}.cashier_id = @staff_id`);
    params.staff_id = f.staff_id;
  }
  if (f.payment_mode) {
    clauses.push(`${alias}.payment_mode = @payment_mode`);
    params.payment_mode = f.payment_mode;
  }
  if (f.table_id) {
    clauses.push(`${alias}.table_id = @table_id`);
    params.table_id = f.table_id;
  }
  if (f.product_id) {
    clauses.push(
      `EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = ${alias}.order_id AND oi.product_id = @product_id)`,
    );
    params.product_id = f.product_id;
  }
  if (f.category_id) {
    clauses.push(
      `EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ${alias}.order_id AND p.category_id = @category_id)`,
    );
    params.category_id = f.category_id;
  }
  return { sql: clauses.join(' AND '), params };
}

/** Bill lines that belong to active sales in range (used by product/liquor reports). */
function activeLineWhere(f, extra = []) {
  const where = salesWhere(f);
  return { sql: `${where.sql}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}`, params: where.params };
}

const money0 = (v) => r2(v);

/* ------------------------------------------------------------------ A. DAILY */
export function reportDaily(f) {
  const w = salesWhere(f);
  const rows = db
    .prepare(
      `SELECT b.bill_date AS date,
              COUNT(*) AS bills,
              COALESCE(SUM(b.total),0) AS sales,
              COALESCE(SUM(b.cash_amount),0) AS cash,
              COALESCE(SUM(b.upi_amount),0) AS upi,
              COALESCE(SUM(b.card_amount),0) AS card,
              COALESCE(SUM(CASE WHEN b.payment_mode='split' THEN b.total ELSE 0 END),0) AS split_amount,
              COALESCE(SUM(CASE WHEN b.payment_mode='split' THEN 1 ELSE 0 END),0) AS split_bills
       FROM bills b WHERE ${w.sql}
       GROUP BY b.bill_date ORDER BY b.bill_date`,
    )
    .all(w.params);

  const items = db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty),0) AS qty, COUNT(DISTINCT oi.product_id) AS products
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id WHERE ${w.sql}`,
    )
    .get(w.params);

  const deleted = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(amount),0) AS amount FROM bill_deletions
       WHERE bill_date BETWEEN ? AND ?`,
    )
    .get(f.from, f.to);

  const refunds = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(refund_amount),0) AS amount FROM bills b
       WHERE b.bill_date BETWEEN ? AND ? AND b.status = 'refunded' AND COALESCE(b.refund_amount,0) > 0`,
    )
    .get(f.from, f.to);

  const totals = rows.reduce(
    (a, r) => ({
      bills: a.bills + n(r.bills),
      sales: money0(a.sales + n(r.sales)),
      cash: money0(a.cash + n(r.cash)),
      upi: money0(a.upi + n(r.upi)),
      card: money0(a.card + n(r.card)),
      split_amount: money0(a.split_amount + n(r.split_amount)),
      split_bills: a.split_bills + n(r.split_bills),
    }),
    { bills: 0, sales: 0, cash: 0, upi: 0, card: 0, split_amount: 0, split_bills: 0 },
  );
  totals.items_sold = r2(items.qty);
  totals.avg_bill = totals.bills ? r2(totals.sales / totals.bills) : 0;
  totals.deleted_bills = n(deleted.bills);
  totals.deleted_amount = money0(deleted.amount);
  totals.refunds = money0(refunds.amount);
  totals.refund_bills = n(refunds.bills);
  totals.net_collected = money0(totals.sales - totals.refunds);

  return {
    title: 'Daily Sales Report',
    columns: ['Date', 'Bills', 'Sales', 'Cash', 'UPI', 'Split', 'Avg bill'],
    rows: rows.map((r) => [
      r.date,
      n(r.bills),
      money0(r.sales),
      money0(r.cash),
      money0(r.upi),
      money0(r.split_amount),
      n(r.bills) ? r2(n(r.sales) / n(r.bills)) : 0,
    ]),
    totals,
    note: `Items sold ${totals.items_sold} · Deleted bills ${totals.deleted_bills} (₹${totals.deleted_amount}) · Refunds ₹${totals.refunds} · Net collected ₹${totals.net_collected}`,
    data: { days: rows, totals },
  };
}

/* --------------------------------------------------- B. DATE-WISE / TRENDS */
export function reportTrend(f, group = 'day') {
  const w = salesWhere(f);
  const key =
    group === 'month' ? "substr(b.bill_date,1,7)" : group === 'week' ? "strftime('%Y-W%W', b.bill_date)" : 'b.bill_date';
  const rows = db
    .prepare(
      `SELECT ${key} AS period, MIN(b.bill_date) AS start_date, MAX(b.bill_date) AS end_date,
              COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales,
              COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi
       FROM bills b WHERE ${w.sql} GROUP BY period ORDER BY period`,
    )
    .all(w.params);

  const totals = rows.reduce(
    (a, r) => ({
      bills: a.bills + n(r.bills),
      sales: money0(a.sales + n(r.sales)),
      cash: money0(a.cash + n(r.cash)),
      upi: money0(a.upi + n(r.upi)),
    }),
    { bills: 0, sales: 0, cash: 0, upi: 0 },
  );

  const daily = rows.filter((r) => r.period === r.start_date);
  const highest = daily.length ? daily.reduce((m, r) => (n(r.sales) > n(m.sales) ? r : m)) : null;
  const lowest = daily.length ? daily.reduce((m, r) => (n(r.sales) < n(m.sales) ? r : m)) : null;

  return {
    title: group === 'month' ? 'Monthly Sales Summary' : group === 'week' ? 'Weekly Sales Summary' : 'Date-wise Sales Report',
    columns: ['Period', 'From', 'To', 'Bills', 'Sales', 'Cash', 'UPI'],
    rows: rows.map((r) => [r.period, r.start_date, r.end_date, n(r.bills), money0(r.sales), money0(r.cash), money0(r.upi)]),
    totals,
    note: `Highest day ${highest ? `${highest.start_date} (₹${money0(highest.sales)})` : '—'} · Lowest day ${
      lowest ? `${lowest.start_date} (₹${money0(lowest.sales)})` : '—'
    }`,
    data: { periods: rows, totals, highest, lowest },
  };
}

export function reportCompare(fromA, toA, fromB, toB) {
  const agg = (from, to) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS sales, COALESCE(SUM(cash_amount),0) AS cash,
                COALESCE(SUM(upi_amount),0) AS upi
         FROM bills b WHERE b.bill_date BETWEEN ? AND ? AND b.status='paid' AND b.deleted_at IS NULL`,
      )
      .get(from, to);
    const items = db
      .prepare(
        `SELECT COALESCE(SUM(oi.qty),0) AS qty FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
         WHERE b.bill_date BETWEEN ? AND ? AND b.status='paid' AND b.deleted_at IS NULL`,
      )
      .get(from, to);
    return {
      from,
      to,
      bills: n(row.bills),
      sales: money0(row.sales),
      cash: money0(row.cash),
      upi: money0(row.upi),
      items: r2(items.qty),
      avg_bill: n(row.bills) ? r2(n(row.sales) / n(row.bills)) : 0,
    };
  };
  const a = agg(fromA, toA);
  const b = agg(fromB, toB);
  const delta = {
    sales: money0(b.sales - a.sales),
    bills: b.bills - a.bills,
    cash: money0(b.cash - a.cash),
    upi: money0(b.upi - a.upi),
    items: r2(b.items - a.items),
  };
  const pct = (prev, next) => (n(prev) ? r2(((n(next) - n(prev)) / n(prev)) * 100) : null);
  return {
    title: 'Period Comparison',
    columns: ['Metric', `Period A (${fromA} → ${toA})`, `Period B (${fromB} → ${toB})`, 'Difference', 'Change %'],
    rows: [
      ['Bills', a.bills, b.bills, delta.bills, pct(a.bills, b.bills) ?? '—'],
      ['Sales', a.sales, b.sales, delta.sales, pct(a.sales, b.sales) ?? '—'],
      ['Cash', a.cash, b.cash, delta.cash, pct(a.cash, b.cash) ?? '—'],
      ['UPI', a.upi, b.upi, delta.upi, pct(a.upi, b.upi) ?? '—'],
      ['Items sold', a.items, b.items, delta.items, pct(a.items, b.items) ?? '—'],
      ['Average bill', a.avg_bill, b.avg_bill, money0(b.avg_bill - a.avg_bill), pct(a.avg_bill, b.avg_bill) ?? '—'],
    ],
    data: { a, b, delta },
  };
}

/* -------------------------------------------------------- C. PRODUCT SALES */
export function reportProduct(f, { includeCost = false } = {}) {
  const w = activeLineWhere(f, f.product_id ? ['oi.product_id = @product_id'] : []);
  if (f.category_id) {
    w.params.category_id = f.category_id;
    w.sql += ' AND p.category_id = @category_id';
  }
  const rows = db
    .prepare(
      `SELECT p.id AS product_id, p.name, COALESCE(c.name,'Uncategorised') AS category, p.unit_type,
              p.bottle_size_ml, p.cost_price,
              COALESCE(SUM(oi.qty),0) AS qty,
              COALESCE(SUM(oi.ml * oi.qty),0) AS ml,
              COALESCE(SUM(oi.line_total),0) AS sales
       FROM order_items oi
       JOIN bills b ON b.order_id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${w.sql}
       GROUP BY p.id ORDER BY sales DESC`,
    )
    .all(w.params);

  const enriched = rows.map((r) => {
    const size = n(r.bottle_size_ml) || 180;
    const costPerMl = n(r.cost_price) / size;
    const cost = r.unit_type === 'ml' ? r2(n(r.ml) * costPerMl) : r2(n(r.qty) * n(r.cost_price));
    const missingCost = n(r.cost_price) <= 0;
    return {
      ...r,
      qty: r2(r.qty),
      ml: r2(r.ml),
      bottles: r.unit_type === 'ml' ? r2(n(r.ml) / size) : r2(r.qty),
      sales: money0(r.sales),
      cost: missingCost ? null : cost,
      profit: missingCost ? null : money0(n(r.sales) - cost),
      cost_complete: !missingCost,
    };
  });

  const totals = {
    sales: money0(enriched.reduce((s, r) => s + n(r.sales), 0)),
    qty: r2(enriched.reduce((s, r) => s + n(r.qty), 0)),
    cost: money0(enriched.reduce((s, r) => s + (r.cost === null ? 0 : r.cost), 0)),
    incomplete: enriched.filter((r) => !r.cost_complete).length,
  };
  totals.profit = money0(totals.sales - totals.cost);

  const columns = includeCost
    ? ['Product', 'Category', 'Qty', 'Bottles', 'Sales', 'Cost', 'Gross profit']
    : ['Product', 'Category', 'Qty', 'Bottles', 'Sales'];
  const table = enriched.map((r) =>
    includeCost
      ? [r.name, r.category, r.qty, r.bottles, r.sales, r.cost === null ? 'INCOMPLETE' : r.cost, r.profit === null ? '—' : r.profit]
      : [r.name, r.category, r.qty, r.bottles, r.sales],
  );

  return {
    title: 'Product-wise Sales Report',
    columns,
    rows: table,
    totals,
    note: totals.incomplete
      ? `${totals.incomplete} product(s) have no purchase cost recorded — profit is marked INCOMPLETE, not zero.`
      : 'All products have purchase cost recorded.',
    data: { products: enriched, totals },
  };
}

/* ------------------------------------------------------ D. LIQUOR CONSUMPTION */
export function reportLiquor(f) {
  const w = salesWhere(f);
  const rows = db
    .prepare(
      `SELECT p.id AS product_id, p.name, COALESCE(c.name,'Liquor') AS category, p.bottle_size_ml,
              oi.ml AS serve_ml,
              COALESCE(SUM(oi.qty),0) AS serves,
              COALESCE(SUM(oi.line_total),0) AS revenue
       FROM order_items oi
       JOIN bills b ON b.order_id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${w.sql} AND p.unit_type = 'ml'
       GROUP BY p.id, oi.ml ORDER BY p.name, oi.ml`,
    )
    .all(w.params);

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) {
      byProduct.set(r.product_id, {
        product_id: r.product_id,
        name: r.name,
        category: r.category,
        bottle_size_ml: n(r.bottle_size_ml) || 180,
        pours: Object.fromEntries(POURS.map((p) => [p.ml, 0])),
        total_ml: 0,
        revenue: 0,
      });
    }
    const entry = byProduct.get(r.product_id);
    const ml = n(r.serve_ml);
    if (entry.pours[ml] === undefined) entry.pours[ml] = 0;
    entry.pours[ml] = r2(entry.pours[ml] + n(r.serves));
    entry.total_ml = r2(entry.total_ml + ml * n(r.serves));
    entry.revenue = money0(entry.revenue + n(r.revenue));
  }
  const products = [...byProduct.values()].map((p) => ({
    ...p,
    bottles_consumed: r2(p.total_ml / p.bottle_size_ml),
    sealed_left: null,
  }));
  for (const p of products) {
    const live = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(p.product_id);
    p.sealed_left = live ? r2(live.stock_bottles) : 0;
  }

  const totals = products.reduce(
    (a, p) => ({
      total_ml: r2(a.total_ml + p.total_ml),
      bottles: r2(a.bottles + p.bottles_consumed),
      revenue: money0(a.revenue + p.revenue),
    }),
    { total_ml: 0, bottles: 0, revenue: 0 },
  );

  return {
    title: 'Liquor Consumption Report',
    columns: ['Brand', 'Category', ...POURS.map((p) => p.label), 'Total ml', '180ml bottles', 'Revenue'],
    rows: products.map((p) => [
      p.name,
      p.category,
      ...POURS.map((pour) => r2(p.pours[pour.ml] || 0)),
      p.total_ml,
      p.bottles_consumed,
      p.revenue,
    ]),
    totals,
    note: `Bottle maths: 30 ml = 1/6, 60 ml = 1/3, 90 ml = 1/2, 120 ml = 2/3, 150 ml = 5/6, 180 ml = 1 bottle.`,
    data: { products, totals, pours: POURS },
  };
}

/* ------------------------------------------------------------------ E. BEER */
/**
 * Beer is sold as whole bottles of one specific size. Every size is its own SKU
 * with its own price and stock, so beer is reported separately from liquor
 * (which is measured in ml pours of a 180 ml bottle).
 *
 * Stock maths comes from the stock ledger (opening = closing - movements in range)
 * and revenue from bill lines, so purchases, sales and closing stock reconcile.
 * Cost and gross profit are only included for the Owner.
 */
export function reportBeer(f, { includeCost = false } = {}) {
  const w = salesWhere(f);
  const sizes = db
    .prepare(
      `SELECT v.id AS variant_id, v.label, v.ml, v.stock_qty, v.cost_price,
              p.id AS product_id, p.name, p.low_stock_qty, COALESCE(c.name,'Beer') AS category,
              s.name AS supplier
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN suppliers s ON s.id = v.supplier_id
       WHERE p.stock_mode = 'variant' AND p.is_active = 1 AND v.is_active = 1
         ${f.product_id ? 'AND p.id = @product_id' : ''} ${f.category_id ? 'AND p.category_id = @category_id' : ''}
       ORDER BY p.name, v.ml DESC`,
    )
    .all(f);

  const sold = new Map();
  for (const row of db
    .prepare(
      `SELECT oi.variant_id, SUM(oi.qty) AS qty, SUM(oi.line_total) AS revenue
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       WHERE ${w.sql} AND oi.variant_id IS NOT NULL
       GROUP BY oi.variant_id`,
    )
    .all(w.params)) {
    sold.set(Number(row.variant_id), row);
  }

  const purchased = new Map();
  for (const row of db
    .prepare(
      `SELECT pi.variant_id, SUM(pi.bottles) AS bottles, SUM(pi.amount) AS amount
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
       WHERE pi.variant_id IS NOT NULL AND pu.purchase_date BETWEEN ? AND ?
       GROUP BY pi.variant_id`,
    )
    .all(f.from, f.to)) {
    purchased.set(Number(row.variant_id), row);
  }

  // opening = closing - every stock movement recorded inside the range. The 'opening'
  // movement states the balance itself, so counting it would cancel the opening stock.
  const moved = new Map();
  for (const row of db
    .prepare(
      `SELECT variant_id, SUM(change_qty) AS qty FROM stock_ledger
       WHERE variant_id IS NOT NULL AND movement != 'opening'
         AND substr(created_at,1,10) BETWEEN ? AND ?
       GROUP BY variant_id`,
    )
    .all(f.from, f.to)) {
    moved.set(Number(row.variant_id), n(row.qty));
  }

  const products = sizes.map((s) => {
    const sSold = sold.get(Number(s.variant_id)) || { qty: 0, revenue: 0 };
    const sPurch = purchased.get(Number(s.variant_id)) || { bottles: 0, amount: 0 };
    const closing = r2(s.stock_qty);
    const opening = r2(closing - (moved.get(Number(s.variant_id)) || 0));
    const unitCost = n(s.cost_price);
    const cost = r2(unitCost * n(sSold.qty));
    return {
      product_id: s.product_id,
      name: s.name,
      category: s.category,
      variant_id: s.variant_id,
      size: s.label,
      ml: n(s.ml),
      supplier: s.supplier || '—',
      opening,
      purchased: r2(sPurch.bottles),
      sold: r2(sSold.qty),
      closing,
      purchase_value: money0(sPurch.amount),
      sales_value: money0(sSold.revenue),
      unit_cost: unitCost,
      cost_of_goods: cost,
      gross_profit: money0(n(sSold.revenue) - cost),
      cost_missing: !unitCost,
      low_stock: closing <= n(s.low_stock_qty),
    };
  });

  const totals = products.reduce(
    (a, p) => ({
      opening: r2(a.opening + p.opening),
      purchased: r2(a.purchased + p.purchased),
      sold: r2(a.sold + p.sold),
      closing: r2(a.closing + p.closing),
      purchase_value: money0(a.purchase_value + p.purchase_value),
      sales_value: money0(a.sales_value + p.sales_value),
      cost_of_goods: r2(a.cost_of_goods + p.cost_of_goods),
      gross_profit: money0(a.gross_profit + p.gross_profit),
    }),
    { opening: 0, purchased: 0, sold: 0, closing: 0, purchase_value: 0, sales_value: 0, cost_of_goods: 0, gross_profit: 0 },
  );

  const columns = [
    'Product',
    'Bottle size',
    'Supplier',
    'Opening',
    'Purchased',
    'Sold',
    'Closing',
    'Purchase value',
    'Sales value',
    ...(includeCost ? ['Cost of goods', 'Gross profit'] : []),
  ];
  const rows = products.map((p) => [
    p.name,
    p.size,
    p.supplier,
    p.opening,
    p.purchased,
    p.sold,
    p.closing,
    p.purchase_value,
    p.sales_value,
    ...(includeCost ? [p.cost_of_goods, p.gross_profit] : []),
  ]);

  return {
    title: 'Beer Report (by bottle size)',
    columns,
    rows,
    totals,
    note:
      'Each beer bottle size is an independent product with its own price and stock. ' +
      'Opening = closing minus all stock movements in the selected range. Stock is counted in bottles.',
    data: { products, totals, include_cost: includeCost },
  };
}

/* --------------------------------------------------------------- E. STOCK */
function stockMovements(whereSql, params, key = 'in') {
  return db.prepare(whereSql).all(params);
}

export function reportStock(f) {
  const products = db
    .prepare(
      `SELECT p.id, p.name, p.unit_type, p.bottle_size_ml, p.stock_qty, p.stock_bottles,
              p.cost_price, p.low_stock_qty, COALESCE(c.name,'Uncategorised') AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 ${f.product_id ? 'AND p.id = @product_id' : ''} ${f.category_id ? 'AND p.category_id = @category_id' : ''}
       ORDER BY category, p.name`,
    )
    .all(f);

  const purchasesIn = new Map();
  for (const row of db
    .prepare(
      `SELECT pi.product_id, SUM(pi.bottles) AS bottles, SUM(pi.total_ml) AS ml, SUM(pi.amount) AS amount
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
       WHERE pu.purchase_date BETWEEN ? AND ? GROUP BY pi.product_id`,
    )
    .all(f.from, f.to)) {
    purchasesIn.set(row.product_id, row);
  }
  const purchasesAfter = new Map();
  for (const row of db
    .prepare(
      `SELECT pi.product_id, SUM(pi.bottles) AS bottles, SUM(pi.total_ml) AS ml
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
       WHERE pu.purchase_date > ? GROUP BY pi.product_id`,
    )
    .all(f.to)) {
    purchasesAfter.set(row.product_id, row);
  }

  const soldIn = new Map();
  for (const row of db
    .prepare(
      `SELECT oi.product_id, SUM(oi.qty) AS qty, SUM(oi.ml * oi.qty) AS ml
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       WHERE b.status='paid' AND b.deleted_at IS NULL AND b.bill_date BETWEEN ? AND ?
       GROUP BY oi.product_id`,
    )
    .all(f.from, f.to)) {
    soldIn.set(row.product_id, row);
  }
  const soldAfter = new Map();
  for (const row of db
    .prepare(
      `SELECT oi.product_id, SUM(oi.qty) AS qty, SUM(oi.ml * oi.qty) AS ml
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       WHERE b.status='paid' AND b.deleted_at IS NULL AND b.bill_date > ?
       GROUP BY oi.product_id`,
    )
    .all(f.to)) {
    soldAfter.set(row.product_id, row);
  }

  const adjIn = new Map();
  for (const row of db
    .prepare(
      `SELECT product_id, SUM(change_qty) AS qty FROM stock_ledger
       WHERE movement IN ('adjustment','wastage','return') AND substr(created_at,1,10) BETWEEN ? AND ?
       GROUP BY product_id`,
    )
    .all(f.from, f.to)) {
    adjIn.set(row.product_id, row);
  }
  const adjAfter = new Map();
  for (const row of db
    .prepare(
      `SELECT product_id, SUM(change_qty) AS qty FROM stock_ledger
       WHERE movement IN ('adjustment','wastage','return') AND substr(created_at,1,10) > ?
       GROUP BY product_id`,
    )
    .all(f.to)) {
    adjAfter.set(row.product_id, row);
  }

  const rows = products.map((p) => {
    const isMl = p.unit_type === 'ml';
    const size = n(p.bottle_size_ml) || 180;
    const unit = (row) => {
      if (!row) return 0;
      if (!isMl) return n(row.bottles ?? row.qty);
      return n(row.ml ?? 0) / size || n(row.qty);
    };
    const soldUnits = (row) => (isMl ? n(row?.ml) / size : n(row?.qty));

    const current = isMl ? n(p.stock_bottles) : n(p.stock_qty);
    const boughtPeriod = isMl ? n(purchasesIn.get(p.id)?.ml) / size : n(purchasesIn.get(p.id)?.bottles);
    const boughtAfter = isMl ? n(purchasesAfter.get(p.id)?.ml) / size : n(purchasesAfter.get(p.id)?.bottles);
    const soldPeriod = soldUnits(soldIn.get(p.id));
    const soldAfterTo = soldUnits(soldAfter.get(p.id));
    const adjPeriod = n(adjIn.get(p.id)?.qty);
    const adjAfterTo = n(adjAfter.get(p.id)?.qty);

    const closing = r2(current - boughtAfter + soldAfterTo - adjAfterTo);
    const opening = r2(closing - boughtPeriod + soldPeriod - adjPeriod);
    const costPrice = n(p.cost_price);
    const lowLimit = n(p.low_stock_qty) || (isMl ? 1 : 5);

    return {
      id: p.id,
      name: p.name,
      category: p.category,
      unit_type: p.unit_type,
      unit_label: isMl ? 'bottles (180 ml)' : 'units',
      opening: Math.max(0, opening),
      purchased: r2(boughtPeriod),
      sold: r2(soldPeriod),
      adjustments: r2(adjPeriod),
      closing: Math.max(0, closing),
      sealed_bottles: isMl ? Math.max(0, Math.floor(closing)) : null,
      low_stock: closing <= lowLimit,
      cost_price: costPrice,
      cost_complete: costPrice > 0,
      valuation: costPrice > 0 ? money0(closing * costPrice) : null,
      sold_ml: isMl ? r2(n(soldIn.get(p.id)?.ml)) : 0,
    };
  });

  const totals = {
    products: rows.length,
    low: rows.filter((r) => r.low_stock).length,
    valuation: money0(rows.reduce((s, r) => s + n(r.valuation), 0)),
    incomplete: rows.filter((r) => !r.cost_complete).length,
  };

  return {
    title: 'Stock Report',
    columns: ['Product', 'Unit', 'Opening', 'Purchases', 'Sold', 'Adjust', 'Closing', 'Value'],
    rows: rows.map((r) => [
      r.name,
      r.unit_label,
      r.opening,
      r.purchased,
      r.sold,
      r.adjustments,
      r.closing,
      r.valuation === null ? 'INCOMPLETE' : r.valuation,
    ]),
    totals,
    note: `Liquor is shown in sealed 180 ml bottle equivalents. Stock valuation ₹${totals.valuation}.`,
    data: { stock: rows, totals },
  };
}

/* ------------------------------------------------------------ F. PURCHASES */
export function reportPurchases(f) {
  const rows = db
    .prepare(
      `SELECT pu.id, pu.purchase_date, COALESCE(s.name,'(no supplier)') AS supplier, pu.invoice_no,
              p.name AS product, pi.bottles, pi.ml_per_bottle, pi.total_ml, pi.unit_cost, pi.amount,
              pu.total_amount, pu.paid_amount, pu.notes
       FROM purchases pu
       LEFT JOIN suppliers s ON s.id = pu.supplier_id
       JOIN purchase_items pi ON pi.purchase_id = pu.id
       JOIN products p ON p.id = pi.product_id
       WHERE pu.purchase_date BETWEEN ? AND ?
       ORDER BY pu.purchase_date, pu.id`,
    )
    .all(f.from, f.to);

  const list = rows.map((r) => ({
    ...r,
    outstanding: money0(n(r.total_amount) - n(r.paid_amount)),
    payment: n(r.paid_amount) >= n(r.total_amount) ? 'Paid' : n(r.paid_amount) > 0 ? 'Part paid' : 'Unpaid',
  }));

  const bySupplier = new Map();
  const byMonth = new Map();
  for (const r of list) {
    const s = bySupplier.get(r.supplier) || { supplier: r.supplier, lines: 0, amount: 0, paid: 0 };
    s.lines += 1;
    s.amount = money0(s.amount + n(r.amount));
    s.paid = money0(s.paid + n(r.paid_amount));
    bySupplier.set(r.supplier, s);
    const m = byMonth.get(r.purchase_date.slice(0, 7)) || { month: r.purchase_date.slice(0, 7), amount: 0, purchases: new Set() };
    m.amount = money0(m.amount + n(r.amount));
    m.purchases.add(r.id);
    byMonth.set(r.purchase_date.slice(0, 7), m);
  }

  const totals = {
    amount: money0(list.reduce((s, r) => s + n(r.amount), 0)),
    paid: money0(list.reduce((s, r) => s + n(r.paid_amount), 0)),
    outstanding: money0(list.reduce((s, r) => s + n(r.outstanding), 0)),
    lines: list.length,
  };

  return {
    title: 'Purchase Report',
    columns: ['Date', 'Supplier', 'Product', 'Bottles/Qty', 'Rate', 'Amount', 'Payment', 'Outstanding'],
    rows: list.map((r) => [
      r.purchase_date,
      r.supplier,
      r.product,
      r2(r.bottles),
      money0(r.unit_cost),
      money0(r.amount),
      r.payment,
      r.outstanding,
    ]),
    totals,
    note: `Supplier-wise and monthly summaries are shown in the app; totals include ${totals.lines} purchase line(s).`,
    data: {
      purchases: list,
      totals,
      by_supplier: [...bySupplier.values()],
      by_month: [...byMonth.values()].map((m) => ({ month: m.month, amount: m.amount, purchases: m.purchases.size })),
    },
  };
}

/* ------------------------------------------------------------- G. PAYMENTS */
export function reportPayments(f) {
  const w = salesWhere(f);
  const rows = db
    .prepare(
      `SELECT b.bill_date AS date, b.bill_no, b.total, b.payment_mode, b.cash_amount, b.upi_amount,
              b.card_amount, b.upi_ref, b.cashier_name, b.paid_at
       FROM bills b WHERE ${w.sql} ORDER BY b.bill_date DESC, b.id DESC`,
    )
    .all(w.params);

  const byMode = db
    .prepare(
      `SELECT b.payment_mode AS mode, COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS amount,
              COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi
       FROM bills b WHERE ${w.sql} GROUP BY b.payment_mode`,
    )
    .all(w.params);

  const refunds = db
    .prepare(
      `SELECT b.bill_date AS date, b.bill_no, COALESCE(b.refund_amount,0) AS refund_amount, b.refund_reason
       FROM bills b WHERE b.bill_date BETWEEN ? AND ? AND b.status='refunded' AND COALESCE(b.refund_amount,0) > 0
       ORDER BY b.bill_date DESC`,
    )
    .all(f.from, f.to);

  const totals = {
    cash: money0(rows.reduce((s, r) => s + n(r.cash_amount), 0)),
    upi: money0(rows.reduce((s, r) => s + n(r.upi_amount), 0)),
    card: money0(rows.reduce((s, r) => s + n(r.card_amount), 0)),
    total: money0(rows.reduce((s, r) => s + n(r.total), 0)),
    refunds: money0(refunds.reduce((s, r) => s + n(r.refund_amount), 0)),
  };
  totals.net = money0(totals.total - totals.refunds);

  return {
    title: 'Payment Report',
    columns: ['Date', 'Bill', 'Mode', 'Cash', 'UPI', 'Card', 'Total', 'Reference'],
    rows: rows.map((r) => [
      r.date,
      r.bill_no,
      r.payment_mode,
      money0(r.cash_amount),
      money0(r.upi_amount),
      money0(r.card_amount),
      money0(r.total),
      r.upi_ref || '—',
    ]),
    totals,
    note: `Cash ₹${totals.cash} · UPI ₹${totals.upi} · Refunds ₹${totals.refunds} · Net collected ₹${totals.net}`,
    data: { payments: rows, by_mode: byMode, refunds, totals },
  };
}

/* --------------------------------------------------------------- H. TABLES */
export function reportTables(f) {
  const w = salesWhere(f);
  const rows = db
    .prepare(
      `SELECT COALESCE(b.table_label, t.label, 'Takeaway') AS table_label, COUNT(*) AS bills,
              COALESCE(SUM(b.total),0) AS sales, COALESCE(SUM(b.cash_amount),0) AS cash,
              COALESCE(SUM(b.upi_amount),0) AS upi
       FROM bills b LEFT JOIN dining_tables t ON t.id = b.table_id
       WHERE ${w.sql} GROUP BY table_label ORDER BY sales DESC`,
    )
    .all(w.params);
  const items = db
    .prepare(
      `SELECT COALESCE(b.table_label, t.label, 'Takeaway') AS table_label, COALESCE(SUM(oi.qty),0) AS qty
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       LEFT JOIN dining_tables t ON t.id = b.table_id
       WHERE ${w.sql} GROUP BY table_label`,
    )
    .all(w.params);
  const itemMap = new Map(items.map((i) => [i.table_label, r2(i.qty)]));

  const all = db.prepare('SELECT label FROM dining_tables ORDER BY sort_order, label').all();
  const byLabel = new Map(rows.map((r) => [r.table_label, r]));
  const merged = all.map((t) => {
    const r = byLabel.get(t.label);
    return {
      table_label: t.label,
      bills: n(r?.bills),
      sales: money0(r?.sales),
      cash: money0(r?.cash),
      upi: money0(r?.upi),
      items: itemMap.get(t.label) ?? 0,
      avg_bill: n(r?.bills) ? r2(n(r.sales) / n(r.bills)) : 0,
    };
  });

  const totals = {
    bills: merged.reduce((s, r) => s + r.bills, 0),
    sales: money0(merged.reduce((s, r) => s + r.sales, 0)),
    items: r2(merged.reduce((s, r) => s + r.items, 0)),
  };

  return {
    title: 'Table-wise Sales Report',
    columns: ['Table', 'Bills', 'Sales', 'Cash', 'UPI', 'Items', 'Avg bill'],
    rows: merged.map((r) => [r.table_label, r.bills, r.sales, r.cash, r.upi, r.items, r.avg_bill]),
    totals,
    note: `${merged.length} restaurant tables covered.`,
    data: { tables: merged, totals },
  };
}

/* ---------------------------------------------------------------- I. STAFF */
export function reportStaff(f) {
  const w = salesWhere(f);
  const rows = db
    .prepare(
      `SELECT COALESCE(b.cashier_name,'(unknown)') AS staff, COALESCE(b.cashier_id, 0) AS staff_id,
              COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales,
              COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi,
              MIN(b.bill_date) AS first_bill, MAX(b.bill_date) AS last_bill
       FROM bills b WHERE ${w.sql} GROUP BY staff ORDER BY sales DESC`,
    )
    .all(w.params);

  const daily = db
    .prepare(
      `SELECT COALESCE(b.cashier_name,'(unknown)') AS staff, b.bill_date AS date,
              COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales
       FROM bills b WHERE ${w.sql} GROUP BY staff, b.bill_date ORDER BY date DESC`,
    )
    .all(w.params);

  const totals = {
    bills: rows.reduce((s, r) => s + n(r.bills), 0),
    sales: money0(rows.reduce((s, r) => s + n(r.sales), 0)),
    cash: money0(rows.reduce((s, r) => s + n(r.cash), 0)),
    upi: money0(rows.reduce((s, r) => s + n(r.upi), 0)),
  };

  return {
    title: 'Staff-wise Sales Report',
    columns: ['Staff', 'Bills', 'Sales', 'Cash', 'UPI', 'Avg bill'],
    rows: rows.map((r) => [r.staff, n(r.bills), money0(r.sales), money0(r.cash), money0(r.upi), n(r.bills) ? r2(n(r.sales) / n(r.bills)) : 0]),
    totals,
    note: `Bill history per staff member is available in the app drill-down.`,
    data: { staff: rows, daily, totals },
  };
}

/* ------------------------------------------------- J. CANCELLATION / REFUND */
export function reportCancellations(f) {
  const deletions = db
    .prepare(
      `SELECT bill_no, bill_date, amount, payment_mode, deleted_by_name, deleted_at, reason
       FROM bill_deletions WHERE bill_date BETWEEN ? AND ? ORDER BY deleted_at DESC`,
    )
    .all(f.from, f.to);
  const refunds = db
    .prepare(
      `SELECT b.bill_no, b.bill_date, b.total AS original_amount, COALESCE(b.refund_amount,0) AS refund_amount,
              b.refund_reason AS reason, COALESCE(u.name, b.cashier_name) AS approved_by, b.refunded_at, b.cashier_name
       FROM bills b LEFT JOIN users u ON u.id = b.refunded_by
       WHERE b.bill_date BETWEEN ? AND ? AND (b.status='refunded' OR COALESCE(b.refund_amount,0) > 0)
       ORDER BY b.refunded_at DESC`,
    )
    .all(f.from, f.to);

  const totals = {
    deleted_bills: deletions.length,
    deleted_amount: money0(deletions.reduce((s, r) => s + n(r.amount), 0)),
    refunds: refunds.length,
    refund_amount: money0(refunds.reduce((s, r) => s + n(r.refund_amount), 0)),
  };

  const rows = [
    ...deletions.map((d) => [
      d.bill_no,
      `${d.bill_date} ${(d.deleted_at || '').slice(11, 16)}`,
      money0(d.amount),
      0,
      'Deleted bill',
      d.deleted_by_name || '—',
      d.reason || '—',
    ]),
    ...refunds.map((r) => [
      r.bill_no,
      `${r.bill_date} ${(r.refunded_at || '').slice(11, 16)}`,
      money0(r.original_amount),
      money0(r.refund_amount),
      'Refund',
      r.approved_by || '—',
      r.reason || '—',
    ]),
  ];

  return {
    title: 'Cancellation & Refund Report',
    columns: ['Bill', 'Date / time', 'Original amount', 'Refund', 'Type', 'Approved / performed by', 'Reason'],
    rows,
    totals,
    note: 'Deleted bills are excluded from active sales but retained here and in the audit log.',
    data: { deletions, refunds, totals },
  };
}

/* ------------------------------------------------------------- DAILY CLOSING */
export function reportClosing(f, user) {
  const w = salesWhere(f);
  const bills = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales,
              COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi,
              COALESCE(SUM(b.card_amount),0) AS card,
              COALESCE(SUM(CASE WHEN b.payment_mode='split' THEN b.total ELSE 0 END),0) AS split
       FROM bills b WHERE ${w.sql}`,
    )
    .get(w.params);
  const refunds = db
    .prepare(
      `SELECT COALESCE(SUM(refund_amount),0) AS amount FROM bills b
       WHERE b.bill_date BETWEEN ? AND ? AND COALESCE(b.refund_amount,0) > 0`,
    )
    .get(f.from, f.to);
  const session = db.prepare('SELECT * FROM cash_sessions WHERE session_date = ?').get(f.to);
  const staff = db
    .prepare(
      `SELECT COALESCE(b.cashier_name,'(unknown)') AS staff, COUNT(*) AS bills,
              COALESCE(SUM(b.total),0) AS sales, COALESCE(SUM(b.cash_amount),0) AS cash,
              COALESCE(SUM(b.upi_amount),0) AS upi
       FROM bills b WHERE ${w.sql} GROUP BY staff ORDER BY sales DESC`,
    )
    .all(w.params);

  const cashSales = money0(bills.cash);
  const refundTotal = money0(refunds.amount);
  const opening = session ? money0(session.opening_cash) : null;
  const expectedCash = opening === null ? null : money0(opening + cashSales - refundTotal);
  const closing = session && session.closing_cash !== null ? money0(session.closing_cash) : null;

  const data = {
    date: f.to,
    from: f.from,
    opening_cash: opening,
    cash_sales: cashSales,
    upi_sales: money0(bills.upi),
    card_sales: money0(bills.card),
    split_amount: money0(bills.split),
    refunds: refundTotal,
    net_collections: money0(n(bills.sales) - refundTotal),
    total_bills: n(bills.bills),
    staff,
    expected_cash: expectedCash,
    closing_cash: closing,
    variance: expectedCash !== null && closing !== null ? money0(closing - expectedCash) : null,
    closed_by: session?.closed_by_name || null,
    closed_at: session?.closed_at || null,
    prepared_by: user?.name || null,
  };

  return {
    title: 'Daily Closing Statement',
    columns: ['Staff', 'Bills', 'Sales', 'Cash', 'UPI'],
    rows: staff.map((s) => [s.staff, n(s.bills), money0(s.sales), money0(s.cash), money0(s.upi)]),
    totals: {
      bills: data.total_bills,
      cash: data.cash_sales,
      upi: data.upi_sales,
      split: data.split_amount,
      refunds: data.refunds,
      net: data.net_collections,
      opening_cash: data.opening_cash,
      closing_cash: data.closing_cash,
      variance: data.variance,
    },
    note: `Opening cash ${opening === null ? 'not recorded' : `₹${opening}`} · Expected ${expectedCash === null ? '—' : `₹${expectedCash}`} · Closing ${
      closing === null ? 'not recorded' : `₹${closing}`
    }`,
    data,
  };
}

/* -------------------------------------------------------------- OWNER P&L */
export function reportPnl(f) {
  const w = salesWhere(f);
  const sales = db
    .prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales, COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi FROM bills b WHERE ${w.sql}`)
    .get(w.params);

  const lines = db
    .prepare(
      `SELECT p.id, p.name, COALESCE(c.name,'Uncategorised') AS category, p.unit_type, p.bottle_size_ml, p.cost_price,
              COALESCE(SUM(oi.qty),0) AS qty, COALESCE(SUM(oi.ml*oi.qty),0) AS ml, COALESCE(SUM(oi.line_total),0) AS revenue
       FROM order_items oi JOIN bills b ON b.order_id = oi.order_id
       JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${w.sql} GROUP BY p.id`,
    )
    .all(w.params);

  const products = lines.map((l) => {
    const size = n(l.bottle_size_ml) || 180;
    const complete = n(l.cost_price) > 0;
    const cogs = l.unit_type === 'ml' ? r2(n(l.ml) * (n(l.cost_price) / size)) : r2(n(l.qty) * n(l.cost_price));
    return {
      name: l.name,
      category: l.category,
      revenue: money0(l.revenue),
      cogs: complete ? cogs : null,
      profit: complete ? money0(n(l.revenue) - cogs) : null,
      cost_complete: complete,
    };
  });

  const categoryMap = new Map();
  for (const p of products) {
    const c = categoryMap.get(p.category) || { category: p.category, revenue: 0, cogs: 0, incomplete: 0 };
    c.revenue = money0(c.revenue + p.revenue);
    if (p.cost_complete) c.cogs = money0(c.cogs + p.cogs);
    else c.incomplete += 1;
    categoryMap.set(p.category, c);
  }
  const categories = [...categoryMap.values()].map((c) => ({ ...c, profit: money0(c.revenue - c.cogs) }));

  const cogsTotal = money0(products.reduce((s, p) => s + (p.cost_complete ? p.cogs : 0), 0));
  const incomplete = products.filter((p) => !p.cost_complete);

  const opex = db
    .prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM expenses WHERE expense_date BETWEEN ? AND ?')
    .get(f.from, f.to);
  const purchases = db
    .prepare('SELECT COALESCE(SUM(total_amount),0) AS amount, COALESCE(SUM(paid_amount),0) AS paid FROM purchases WHERE purchase_date BETWEEN ? AND ?')
    .get(f.from, f.to);
  const stockValue = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN unit_type='ml' THEN stock_bottles * cost_price ELSE stock_qty * cost_price END),0) AS value
       FROM products WHERE is_active = 1 AND cost_price > 0`,
    )
    .get();

  const gross = money0(n(sales.sales) - cogsTotal);
  const netOperating = money0(gross - n(opex.amount));

  const monthly = db
    .prepare(
      `SELECT substr(b.bill_date,1,7) AS month, COUNT(*) AS bills, COALESCE(SUM(b.total),0) AS sales,
              COALESCE(SUM(b.cash_amount),0) AS cash, COALESCE(SUM(b.upi_amount),0) AS upi
       FROM bills b WHERE ${w.sql} GROUP BY month ORDER BY month`,
    )
    .all(w.params);

  return {
    title: 'Profit & Loss Statement',
    columns: ['Line', 'Amount'],
    rows: [
      ['Total sales', money0(sales.sales)],
      ['Cost of goods sold (from product cost)', cogsTotal],
      ['Gross profit', gross],
      ['Operating expenses', money0(opex.amount)],
      ['Net operating profit', netOperating],
      ['Stock valuation (closing)', money0(stockValue.value)],
      ['Purchases in period (inventory, not an expense)', money0(purchases.amount)],
      ['Purchases paid in period (cash outflow)', money0(purchases.paid)],
    ],
    totals: {
      sales: money0(sales.sales),
      cogs: cogsTotal,
      gross,
      expenses: money0(opex.amount),
      net_operating_profit: netOperating,
      stock_value: money0(stockValue.value),
      purchases: money0(purchases.amount),
      purchases_paid: money0(purchases.paid),
      incomplete_products: incomplete.length,
    },
    note: incomplete.length
      ? `${incomplete.length} product(s) have no purchase cost: ${incomplete.map((p) => p.name).join(', ')} — marked incomplete, never treated as zero cost.`
      : 'All sold products have purchase cost recorded.',
    data: {
      summary: {
        sales: money0(sales.sales),
        bills: n(sales.bills),
        cogs: cogsTotal,
        gross_profit: gross,
        operating_expenses: money0(opex.amount),
        net_operating_profit: netOperating,
        stock_value: money0(stockValue.value),
        purchases: money0(purchases.amount),
        purchases_paid: money0(purchases.paid),
        cash: money0(sales.cash),
        upi: money0(sales.upi),
        cash_reconciliation: money0(n(sales.cash) - n(purchases.paid)),
        incomplete_products: incomplete,
      },
      products,
      categories,
      monthly,
    },
  };
}

/* --------------------------------------------------------------- DISPATCH */
export const REPORT_DEFS = {
  daily: { title: 'Daily Sales Report', managerToday: true },
  trend: { title: 'Date-wise Sales', managerToday: false },
  compare: { title: 'Period Comparison', managerToday: false },
  product: { title: 'Product-wise Sales', managerToday: true },
  liquor: { title: 'Liquor Consumption', managerToday: true },
  beer: { title: 'Beer Report', managerToday: true },
  stock: { title: 'Stock Report', managerToday: false, ownerOnly: true },
  purchases: { title: 'Purchase Report', managerToday: false },
  payments: { title: 'Payment Report', managerToday: true },
  tables: { title: 'Table-wise Sales', managerToday: true },
  staff: { title: 'Staff-wise Sales', managerToday: true },
  cancellations: { title: 'Cancellation & Refund Report', managerToday: false, ownerOnly: true },
  closing: { title: 'Daily Closing Statement', managerToday: true },
  pnl: { title: 'Profit & Loss', managerToday: false, ownerOnly: true },
};

/** Throws HttpError unless the role may run this report for the requested range. */
export function assertReportAccess(name, user, f, { from, to } = {}) {
  const def = REPORT_DEFS[name];
  if (!def) return; // unknown handled by caller
  if (user.role === 'staff') return { status: 403, message: 'Staff cannot open management reports' };
  if (user.role === 'manager') {
    if (def.ownerOnly) return { status: 403, message: 'This report is available to the Owner only' };
    const day = today();
    const start = from || f.from;
    const end = to || f.to;
    if (def.managerToday && (start !== day || end !== day)) {
      return { status: 403, message: "Managers can only view today's reports" };
    }
  }
  return null;
}

export function buildReport(name, f, user) {
  switch (name) {
    case 'daily':
      return reportDaily(f);
    case 'trend':
      return reportTrend(f, f.group || 'day');
    case 'product':
      return reportProduct(f, { includeCost: user.role === 'owner' });
    case 'liquor':
      return reportLiquor(f);
    case 'beer':
      return reportBeer(f, { includeCost: user.role === 'owner' });
    case 'stock':
      return reportStock(f);
    case 'purchases':
      return reportPurchases(f);
    case 'payments':
      return reportPayments(f);
    case 'tables':
      return reportTables(f);
    case 'staff':
      return reportStaff(f);
    case 'cancellations':
      return reportCancellations(f);
    case 'closing':
      return reportClosing(f, user);
    case 'pnl':
      return reportPnl(f);
    default:
      return null;
  }
}

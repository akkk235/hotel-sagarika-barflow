// Daily opening, cash management, stock reconciliation and closing for BarFlow.
//
// Business-day model:
//   day_sessions          one row per business date; status 'closed' is the day lock
//   day_stock_openings    stock snapshot captured when the day is opened
//   day_stock_counts      physical counts entered by manager/owner + discrepancy reason
//   day_stock_adjustments authorised (Owner) stock corrections for the day
//   cash_movements        cash received from other sources / paid out
//
// Only paid, non-deleted bills count as sales, so unpaid or voided bills can
// never move cash or stock. Every write is idempotent through client_uuid.
import { db, audit, roundBottles, getSetting, setSetting } from './db.js';
import { HttpError, money, nowISO, today, addDays, toNum } from './util.js';

export const DAY_STATUS_LABEL = {
  not_opened: 'Not Opened',
  open: 'Day Open',
  stock_count_pending: 'Stock Count Pending',
  closing_pending: 'Closing Pending',
  closed: 'Closed',
};

const EPS = 0.0001;

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

export function businessDate(value) {
  const date = String(value || today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Business date must be YYYY-MM-DD');
  return date;
}

const ACTIVE_PRODUCT_SQL = `
  SELECT p.id, p.name, p.unit_type, p.bottle_size_ml, p.stock_qty, p.stock_bottles,
         p.cost_price, c.name AS category_name, c.sort_order AS category_order
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
   WHERE p.is_active = 1
   ORDER BY c.sort_order, p.name`;

export function activeProducts() {
  return db.prepare(ACTIVE_PRODUCT_SQL).all();
}

export function daySession(date) {
  return db.prepare('SELECT * FROM day_sessions WHERE business_date = ?').get(date) || null;
}

function previousClosedSession(date) {
  return (
    db
      .prepare(
        `SELECT * FROM day_sessions
          WHERE status = 'closed' AND business_date < ?
          ORDER BY business_date DESC LIMIT 1`,
      )
      .get(date) || null
  );
}

/** Paid, non-deleted bills only: the single source of truth for sales. */
export function billsForDay(date) {
  return db
    .prepare(
      `SELECT b.*, u.name AS staff_name, t.name AS table_name
         FROM bills b
         LEFT JOIN users u ON u.id = b.cashier_id
         LEFT JOIN dining_tables t ON t.id = b.table_id
        WHERE b.bill_date = ? AND b.status = 'paid' AND b.deleted_at IS NULL
        ORDER BY b.created_at`,
    )
    .all(date);
}

export function salesForDay(date) {
  const rows = db
    .prepare(
      `SELECT oi.product_id,
              SUM(oi.qty) AS qty,
              SUM(COALESCE(oi.ml, 0) * oi.qty) AS total_ml,
              SUM(oi.line_total) AS amount
         FROM order_items oi
         JOIN bills b ON b.order_id = oi.order_id
        WHERE b.bill_date = ? AND b.status = 'paid' AND b.deleted_at IS NULL
        GROUP BY oi.product_id`,
    )
    .all(date);
  const map = new Map();
  for (const row of rows) {
    map.set(row.product_id, {
      qty: round4(row.qty),
      total_ml: round4(row.total_ml),
      amount: money(row.amount),
    });
  }
  return map;
}

export function purchasesForDay(date) {
  const rows = db
    .prepare(
      `SELECT pi.product_id, SUM(pi.bottles) AS qty, SUM(pi.total_ml) AS total_ml, SUM(pi.amount) AS amount
         FROM purchase_items pi
         JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.purchase_date = ?
        GROUP BY pi.product_id`,
    )
    .all(date);
  const map = new Map();
  for (const row of rows) {
    map.set(row.product_id, {
      qty: round4(row.qty),
      total_ml: round4(row.total_ml),
      amount: money(row.amount),
    });
  }
  return map;
}

export function adjustmentsForDay(date) {
  const rows = db
    .prepare(
      `SELECT product_id, direction, SUM(qty) AS qty, SUM(loose_ml) AS loose_ml
         FROM day_stock_adjustments
        WHERE business_date = ?
        GROUP BY product_id, direction`,
    )
    .all(date);
  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.product_id) || { in: 0, out: 0, in_ml: 0, out_ml: 0 };
    entry[row.direction] = round4(row.qty);
    entry[`${row.direction}_ml`] = round4(row.loose_ml);
    map.set(row.product_id, entry);
  }
  return map;
}

export function expensesForDay(date) {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses WHERE expense_date = ?')
    .get(date);
  return { total: money(row.total), count: row.count };
}

export function refundsForDay(date) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
         FROM refunds
        WHERE COALESCE(refund_date, substr(created_at, 1, 10)) = ?`,
    )
    .get(date);
  return { total: money(row.total), count: row.count };
}

export function staffSalesForDay(date) {
  return db
    .prepare(
      `SELECT COALESCE(u.name, 'Unknown') AS staff_name, u.role AS role,
              COUNT(b.id) AS bills,
              COALESCE(SUM(b.total), 0) AS total,
              COALESCE(SUM(b.cash_amount), 0) AS cash,
              COALESCE(SUM(b.upi_amount), 0) AS upi
         FROM bills b
         LEFT JOIN users u ON u.id = b.cashier_id
        WHERE b.bill_date = ? AND b.status = 'paid' AND b.deleted_at IS NULL
        GROUP BY b.cashier_id
        ORDER BY total DESC`,
    )
    .all(date)
    .map((r) => ({ ...r, total: money(r.total), cash: money(r.cash), upi: money(r.upi) }));
}

export function cashMovementsForDay(date) {
  return db
    .prepare('SELECT * FROM cash_movements WHERE business_date = ? ORDER BY created_at, id')
    .all(date);
}

export function cashReceivedEnabled() {
  return getSetting('cash_received_enabled', '0') === '1';
}

export function setCashReceivedEnabled(enabled) {
  setSetting('cash_received_enabled', enabled ? '1' : '0');
  return cashReceivedEnabled();
}

/**
 * Cash position for a business date.
 * Expected closing cash = opening + cash sales + cash received - cash expenses
 *                         - other cash paid out - cash refunds.
 * UPI is tracked separately and never added to physical cash.
 */
export function cashSummary(date) {
  const session = daySession(date);
  const bills = db
    .prepare(
      `SELECT COUNT(*) AS bills,
              COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(cash_amount), 0) AS cash,
              COALESCE(SUM(upi_amount), 0) AS upi
         FROM bills
        WHERE bill_date = ? AND status = 'paid' AND deleted_at IS NULL`,
    )
    .get(date);
  const expenses = expensesForDay(date);
  const refunds = refundsForDay(date);
  const movements = cashMovementsForDay(date);
  const cashReceived = money(movements.filter((m) => m.kind === 'in').reduce((s, m) => s + Number(m.amount || 0), 0));
  const otherPaidOut = money(movements.filter((m) => m.kind === 'out').reduce((s, m) => s + Number(m.amount || 0), 0));

  const opening = money(session?.opening_cash ?? 0);
  const cashSales = money(bills.cash);
  const upiSales = money(bills.upi);
  const computed = money(opening + cashSales + cashReceived - expenses.total - otherPaidOut - refunds.total);

  const isClosed = session?.status === 'closed';
  const expected = isClosed && session?.expected_cash != null ? money(session.expected_cash) : computed;
  const actual =
    session && session.actual_cash != null ? money(session.actual_cash) : null;
  const difference = actual == null ? null : money(actual - expected);

  return {
    business_date: date,
    opened: Boolean(session),
    closed: isClosed,
    opening_cash: opening,
    opening_upi: money(session?.opening_upi ?? 0),
    cash_sales: cashSales,
    upi_sales: upiSales,
    cash_received: cashReceived,
    cash_expenses: expenses.total,
    expense_count: expenses.count,
    cash_paid_out: otherPaidOut,
    cash_refunds: refunds.total,
    refund_count: refunds.count,
    expected_cash: expected,
    actual_cash: actual,
    cash_difference: difference,
    shortage: difference != null && difference < 0 ? money(Math.abs(difference)) : 0,
    excess: difference != null && difference > 0 ? difference : 0,
    total_sales: money(bills.total),
    bill_count: bills.bills,
    cash_received_enabled: cashReceivedEnabled(),
  };
}

function openingSnapshotMap(date) {
  const rows = db.prepare('SELECT * FROM day_stock_openings WHERE business_date = ?').all(date);
  return new Map(rows.map((r) => [r.product_id, r]));
}

function countMap(date) {
  const rows = db.prepare('SELECT * FROM day_stock_counts WHERE business_date = ?').all(date);
  return new Map(rows.map((r) => [r.product_id, r]));
}

/**
 * Product-wise stock reconciliation for a business date.
 * Liquor is held in sealed 180 ml bottles; sales carry ml so bottle fractions
 * are exact (30 ml = 1/6, 90 ml = 1/2, 150 ml = 5/6 ...).
 */
export function stockReconciliation(date) {
  const openings = openingSnapshotMap(date);
  const counts = countMap(date);
  const sales = salesForDay(date);
  const purchases = purchasesForDay(date);
  const adjustments = adjustmentsForDay(date);
  const products = activeProducts();

  return products.map((p) => {
    const isLiquor = p.unit_type === 'ml';
    const bottleMl = Number(p.bottle_size_ml) || 180;
    const sale = sales.get(p.id) || { qty: 0, total_ml: 0, amount: 0 };
    const purchase = purchases.get(p.id) || { qty: 0, total_ml: 0, amount: 0 };
    const adj = adjustments.get(p.id) || { in: 0, out: 0, in_ml: 0, out_ml: 0 };

    // Liquor sells in ml; convert to 180 ml bottle equivalents.
    const soldQty = isLiquor ? roundBottles(sale.total_ml / bottleMl) : round4(sale.qty);
    const adjIn = round4(adj.in + (isLiquor ? roundBottles(adj.in_ml / bottleMl) : 0));
    const adjOut = round4(adj.out + (isLiquor ? roundBottles(adj.out_ml / bottleMl) : 0));
    const purchaseQty = isLiquor ? round4(purchase.qty) : round4(purchase.qty);

    const live = isLiquor ? roundBottles(p.stock_bottles) : round4(p.stock_qty);
    const snapshot = openings.get(p.id);
    // Without a snapshot (day never opened) derive the opening so the expected
    // closing figure still reconciles with live stock.
    const opening = snapshot
      ? round4(snapshot.opening_qty)
      : roundBottles(live - purchaseQty - adjIn + soldQty + adjOut);
    const expected = roundBottles(opening + purchaseQty + adjIn - soldQty - adjOut);

    const count = counts.get(p.id) || null;
    const actual = count ? round4(count.actual_qty) : null;
    const difference = actual == null ? null : roundBottles(actual - expected);

    const sealedOf = (qty) => (qty == null ? null : Math.floor(Math.max(qty, 0) + EPS));
    const looseOf = (qty) => (qty == null ? null : Math.round(Math.max(qty - Math.floor(Math.max(qty, 0) + EPS), 0) * bottleMl * 100) / 100);

    return {
      product_id: p.id,
      name: p.name,
      category_name: p.category_name || 'Uncategorised',
      unit_type: p.unit_type,
      is_liquor: isLiquor,
      bottle_size_ml: bottleMl,
      cost_price: money(p.cost_price),
      opening,
      purchases: purchaseQty,
      sales: soldQty,
      sales_ml: round4(sale.total_ml),
      sales_amount: money(sale.amount),
      adjustments_in: adjIn,
      adjustments_out: adjOut,
      expected,
      actual,
      difference,
      counted: Boolean(count),
      reason: count?.reason || null,
      counted_by_name: count?.counted_by_name || null,
      counted_at: count?.counted_at || null,
      actual_loose_ml: count ? round4(count.actual_loose_ml) : null,
      // Liquor presentation: sealed bottles, bottle equivalents and millilitres.
      sealed_bottles: isLiquor ? sealedOf(expected) : null,
      loose_ml: isLiquor ? looseOf(expected) : null,
      expected_ml: isLiquor ? Math.round(expected * bottleMl * 100) / 100 : null,
      actual_sealed_bottles: isLiquor && actual != null ? sealedOf(actual) : null,
      actual_expected_ml: isLiquor && actual != null ? Math.round(actual * bottleMl * 100) / 100 : null,
      live_stock: live,
    };
  });
}

export function dayStatus(date) {
  const session = daySession(date);
  const recon = stockReconciliation(date);
  const products = recon.length;
  const counted = recon.filter((r) => r.counted).length;
  const discrepancies = recon.filter((r) => r.counted && Math.abs(r.difference || 0) > EPS);
  let status;
  if (!session) status = 'not_opened';
  else if (session.status === 'closed') status = 'closed';
  else if (counted === 0) status = 'open';
  else if (counted < products) status = 'stock_count_pending';
  else status = 'closing_pending';

  return {
    date,
    status,
    label: DAY_STATUS_LABEL[status],
    session,
    cash: cashSummary(date),
    stock: {
      products,
      counted,
      pending: products - counted,
      discrepancies: discrepancies.length,
      discrepancy_units: roundBottles(discrepancies.reduce((s, r) => s + Math.abs(r.difference || 0), 0)),
      rows: discrepancies.map((r) => ({
        product_id: r.product_id,
        name: r.name,
        difference: r.difference,
        unit_type: r.unit_type,
      })),
    },
  };
}

function assertEditable(date) {
  const session = daySession(date);
  if (session && session.status === 'closed') {
    throw new HttpError(
      409,
      `${date} is closed and locked. Only the Owner can reopen it with the Owner PIN and a reason.`,
    );
  }
  return session;
}

function mirrorCashSession(date, { openingCash, openingUpi, openingRemarks, userId, closingCash }) {
  // Keep the legacy cash_sessions table in step so the existing closing report
  // and monthly cash reports stay accurate.
  const existing = db.prepare('SELECT * FROM cash_sessions WHERE session_date = ?').get(date);
  const now = nowISO();
  if (!existing) {
    db.prepare(
      `INSERT INTO cash_sessions (session_date, opening_cash, closing_cash, note, opened_by, closed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(date, openingCash, closingCash ?? null, openingRemarks || null, userId ?? null, now, now);
  } else {
    db.prepare(
      `UPDATE cash_sessions
          SET opening_cash = ?, closing_cash = ?, note = ?, updated_at = ?
        WHERE session_date = ?`,
    ).run(openingCash, closingCash ?? existing.closing_cash ?? null, openingRemarks || existing.note || null, now, date);
  }
}

/** Opening stock rows: previous day's verified closing, else live stock. */
export function openingPreview(date) {
  const d = businessDate(date);
  const prev = previousClosedSession(d);
  const prevCounts = prev ? countMap(prev.business_date) : new Map();
  const products = activeProducts();
  return products.map((p) => {
    const isLiquor = p.unit_type === 'ml';
    const bottleMl = Number(p.bottle_size_ml) || 180;
    const carried = prevCounts.get(p.id);
    const qty = carried
      ? round4(carried.actual_qty)
      : isLiquor
        ? roundBottles(p.stock_bottles)
        : round4(p.stock_qty);
    return {
      product_id: p.id,
      name: p.name,
      category_name: p.category_name || 'Uncategorised',
      unit_type: p.unit_type,
      is_liquor: isLiquor,
      bottle_size_ml: bottleMl,
      opening_qty: qty,
      sealed_bottles: isLiquor ? Math.floor(qty + EPS) : null,
      loose_ml: isLiquor ? Math.round((qty - Math.floor(qty + EPS)) * bottleMl * 100) / 100 : null,
      opening_ml: isLiquor ? Math.round(qty * bottleMl * 100) / 100 : null,
      source: carried ? `carry_forward:${prev.business_date}` : 'live_stock',
    };
  });
}

export function openDay({ user, date, opening_cash, opening_upi, remarks, correction = false }) {
  const d = businessDate(date);
  if (opening_cash === undefined || opening_cash === null || opening_cash === '') {
    throw new HttpError(400, 'Opening cash in hand is required');
  }
  const cash = toNum(opening_cash, NaN);
  if (!Number.isFinite(cash) || cash < 0) throw new HttpError(400, 'Opening cash must be zero or a positive amount');
  const upi = toNum(opening_upi, 0);
  if (!Number.isFinite(upi) || upi < 0) throw new HttpError(400, 'Opening UPI balance must be zero or positive');

  const existing = daySession(d);
  if (existing && !correction) {
    throw new HttpError(
      409,
      `${d} is already opened. Only the Owner can authorise a correction to the opening entry.`,
    );
  }
  if (existing && existing.status === 'closed') {
    throw new HttpError(409, `${d} is closed. The Owner must reopen the day before correcting its opening.`);
  }

  const now = nowISO();
  const openingTime = new Date().toISOString();
  const preview = openingPreview(d);

  const run = db.transaction(() => {
    if (!existing) {
      for (const row of preview) {
        db.prepare(
          `INSERT INTO day_stock_openings (business_date, product_id, unit_type, opening_qty, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(business_date, product_id) DO UPDATE SET
             opening_qty = excluded.opening_qty, source = excluded.source`,
        ).run(d, row.product_id, row.unit_type, row.opening_qty, row.source, now);
      }
      db.prepare(
        `INSERT INTO day_sessions
           (business_date, status, opened_at, opening_time, opening_cash, opening_upi, opening_remarks,
            opened_by, opened_by_name, locked, created_at, updated_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(d, now, openingTime, cash, upi, remarks || null, user?.id ?? null, user?.name || null, now, now);
    } else {
      db.prepare(
        `UPDATE day_sessions
            SET opening_cash = ?, opening_upi = ?, opening_remarks = ?,
                opened_by = ?, opened_by_name = ?, updated_at = ?
          WHERE business_date = ?`,
      ).run(cash, upi, remarks || null, user?.id ?? null, user?.name || null, now, d);
    }
    mirrorCashSession(d, { openingCash: cash, openingUpi: upi, openingRemarks: remarks, userId: user?.id });
  });
  run();

  audit(user, correction ? 'day_opening_correct' : 'day_open', 'day_session', d, {
    opening_cash: cash,
    opening_upi: upi,
    remarks: remarks || null,
    carried_products: preview.length,
  });

  return { date: d, created: !existing, opening: preview, session: daySession(d) };
}

export function saveStockCount({ user, date, product_id, actual_bottles, actual_loose_ml, reason }) {
  const d = businessDate(date);
  const session = assertEditable(d);
  if (!session) throw new HttpError(400, 'Open the business day before counting stock');

  const productId = Number(product_id);
  const recon = stockReconciliation(d).find((r) => r.product_id === productId);
  if (!recon) throw new HttpError(404, 'Product not found or inactive');

  const bottles = toNum(actual_bottles, NaN);
  if (!Number.isFinite(bottles) || bottles < 0) {
    throw new HttpError(400, 'Physical stock must be zero or a positive number');
  }
  let looseMl = toNum(actual_loose_ml, 0);
  if (!Number.isFinite(looseMl) || looseMl < 0) throw new HttpError(400, 'Loose millilitres must be zero or positive');
  if (recon.is_liquor && looseMl >= recon.bottle_size_ml) {
    throw new HttpError(
      400,
      `Loose millilitres must be less than one bottle (${recon.bottle_size_ml} ml). Count full bottles in the bottle field.`,
    );
  }
  if (!recon.is_liquor) looseMl = 0;

  const actualQty = round4(bottles + (recon.is_liquor ? looseMl / recon.bottle_size_ml : 0));
  const difference = roundBottles(actualQty - recon.expected);
  const trimmedReason = String(reason || '').trim();
  if (Math.abs(difference) > EPS && trimmedReason.length < 3) {
    throw new HttpError(400, `A reason is required for the ${recon.name} stock difference of ${difference}`);
  }

  const now = nowISO();
  db.prepare(
    `INSERT INTO day_stock_counts
       (business_date, product_id, actual_qty, actual_loose_ml, expected_qty, difference_qty, reason,
        counted_by, counted_by_name, counted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_date, product_id) DO UPDATE SET
       actual_qty = excluded.actual_qty, actual_loose_ml = excluded.actual_loose_ml,
       expected_qty = excluded.expected_qty, difference_qty = excluded.difference_qty,
       reason = excluded.reason, counted_by = excluded.counted_by,
       counted_by_name = excluded.counted_by_name, counted_at = excluded.counted_at`,
  ).run(
    d,
    productId,
    actualQty,
    recon.is_liquor ? round4(looseMl) : 0,
    recon.expected,
    difference,
    trimmedReason || null,
    user?.id ?? null,
    user?.name || null,
    now,
  );

  audit(user, 'stock_count', 'product', productId, {
    business_date: d,
    expected: recon.expected,
    actual: actualQty,
    difference,
    reason: trimmedReason || null,
  });

  return stockReconciliation(d).find((r) => r.product_id === productId);
}

export function addStockAdjustment({ user, date, product_id, direction, qty, loose_ml, reason, client_uuid }) {
  const d = businessDate(date);
  assertEditable(d);
  if (!['in', 'out'].includes(direction)) throw new HttpError(400, 'Adjustment direction must be in or out');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id));
  if (!product) throw new HttpError(404, 'Product not found');
  const amount = toNum(qty, NaN);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, 'Adjustment quantity must be zero or positive');
  const looseMl = toNum(loose_ml, 0);
  if (!Number.isFinite(looseMl) || looseMl < 0) throw new HttpError(400, 'Loose millilitres must be zero or positive');
  const trimmedReason = String(reason || '').trim();
  if (trimmedReason.length < 3) throw new HttpError(400, 'An adjustment reason is required');

  const isLiquor = product.unit_type === 'ml';
  const bottleMl = Number(product.bottle_size_ml) || 180;
  const deltaBottles = (direction === 'in' ? 1 : -1) * (amount + (isLiquor ? looseMl / bottleMl : 0));
  if (isLiquor && product.stock_bottles + deltaBottles < -EPS) {
    throw new HttpError(400, 'Adjustment would make stock negative');
  }
  if (!isLiquor && product.stock_qty + deltaBottles < -EPS) {
    throw new HttpError(400, 'Adjustment would make stock negative');
  }

  const now = nowISO();
  const run = db.transaction(() => {
    if (client_uuid) {
      const dup = db.prepare('SELECT id FROM day_stock_adjustments WHERE client_uuid = ?').get(client_uuid);
      if (dup) return { duplicate: true, id: dup.id };
    }
    const info = db
      .prepare(
        `INSERT INTO day_stock_adjustments
           (business_date, product_id, direction, qty, loose_ml, reason, created_by, created_by_name,
            approved_by, client_uuid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d,
        product.id,
        direction,
        round4(amount),
        isLiquor ? round4(looseMl) : 0,
        trimmedReason,
        user?.id ?? null,
        user?.name || null,
        user?.id ?? null,
        client_uuid || null,
        now,
      );

    if (isLiquor) {
      const nextBottles = roundBottles(Number(product.stock_bottles || 0) + deltaBottles);
      db.prepare('UPDATE products SET stock_bottles = ?, stock_qty = ?, updated_at = ? WHERE id = ?').run(
        nextBottles,
        round4(nextBottles * bottleMl),
        now,
        product.id,
      );
      db.prepare(
        `INSERT INTO stock_ledger (product_id, movement, change_qty, balance_qty, ref_type, ref_id, note, created_by, created_at)
         VALUES (?, 'adjustment', ?, ?, 'day_adjustment', ?, ?, ?, ?)`,
      ).run(
        product.id,
        round4(deltaBottles),
        nextBottles,
        info.lastInsertRowid,
        trimmedReason,
        user?.id ?? null,
        now,
      );
    } else {
      const nextQty = round4(Number(product.stock_qty || 0) + deltaBottles);
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(nextQty, now, product.id);
      db.prepare(
        `INSERT INTO stock_ledger (product_id, movement, change_qty, balance_qty, ref_type, ref_id, note, created_by, created_at)
         VALUES (?, 'adjustment', ?, ?, 'day_adjustment', ?, ?, ?, ?)`,
      ).run(product.id, round4(deltaBottles), nextQty, info.lastInsertRowid, trimmedReason, user?.id ?? null, now);
    }
    return { duplicate: false, id: info.lastInsertRowid };
  });

  const result = run();
  if (!result.duplicate) {
    audit(user, 'stock_adjustment', 'product', product.id, {
      business_date: d,
      direction,
      qty: amount,
      loose_ml: isLiquor ? looseMl : 0,
      reason: trimmedReason,
    });
  }
  return { ...result, product_id: product.id, business_date: d };
}

export function addCashMovement({ user, date, kind, amount, note, client_uuid, source = 'other' }) {
  const d = businessDate(date);
  const session = assertEditable(d);
  if (!session) throw new HttpError(400, 'Open the business day before recording cash movements');
  if (!['in', 'out'].includes(kind)) throw new HttpError(400, 'Cash movement kind must be in or out');
  const value = toNum(amount, NaN);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'Cash amount must be greater than zero');
  if (kind === 'in' && !cashReceivedEnabled()) {
    throw new HttpError(403, 'Cash received from other sources is disabled. The Owner can enable it in settings.');
  }
  const trimmed = String(note || '').trim();
  if (trimmed.length < 3) throw new HttpError(400, 'A note is required for a cash movement');

  if (client_uuid) {
    const dup = db.prepare('SELECT * FROM cash_movements WHERE client_uuid = ?').get(client_uuid);
    if (dup) return { duplicate: true, movement: dup };
  }
  const now = nowISO();
  const info = db
    .prepare(
      `INSERT INTO cash_movements (business_date, kind, source, amount, note, created_by, created_by_name, client_uuid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(d, kind, source, money(value), trimmed, user?.id ?? null, user?.name || null, client_uuid || null, now);
  audit(user, kind === 'in' ? 'cash_received' : 'cash_paid_out', 'day_session', d, {
    amount: money(value),
    note: trimmed,
  });
  return {
    duplicate: false,
    movement: db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(info.lastInsertRowid),
  };
}

export function closeDay({ user, date, actual_cash, remarks }) {
  const d = businessDate(date);
  const session = daySession(d);
  if (!session) throw new HttpError(400, 'Open the business day before closing it');
  if (session.status === 'closed') {
    throw new HttpError(409, `${d} is already closed. Only the Owner can reopen it with the Owner PIN.`);
  }
  const recon = stockReconciliation(d);
  const pending = recon.filter((r) => !r.counted);
  if (pending.length) {
    throw new HttpError(400, `Complete the physical stock count for ${pending.length} product(s) before closing`, {
      pending: pending.map((p) => p.name),
    });
  }
  if (actual_cash === undefined || actual_cash === null || actual_cash === '') {
    throw new HttpError(400, 'Actual closing cash is required');
  }
  const actual = toNum(actual_cash, NaN);
  if (!Number.isFinite(actual) || actual < 0) throw new HttpError(400, 'Actual closing cash must be zero or positive');

  const cash = cashSummary(d);
  const difference = money(actual - cash.expected_cash);
  const stockDifference = recon.filter((r) => Math.abs(r.difference || 0) > EPS);
  const trimmed = String(remarks || '').trim();
  if ((Math.abs(difference) > 0.005 || stockDifference.length > 0) && trimmed.length < 3) {
    throw new HttpError(400, 'Closing remarks are required because cash or stock does not match');
  }

  const now = nowISO();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE day_sessions
          SET status = 'closed', expected_cash = ?, actual_cash = ?, cash_difference = ?,
              upi_collected = ?, total_sales = ?, total_bills = ?, closing_remarks = ?,
              closed_at = ?, closed_by = ?, closed_by_name = ?, locked = 1, updated_at = ?
        WHERE business_date = ?`,
    ).run(
      cash.expected_cash,
      money(actual),
      difference,
      cash.upi_sales,
      cash.total_sales,
      cash.bill_count,
      trimmed || null,
      now,
      user?.id ?? null,
      user?.name || null,
      now,
      d,
    );
    mirrorCashSession(d, {
      openingCash: cash.opening_cash,
      openingUpi: cash.opening_upi,
      openingRemarks: session.opening_remarks,
      userId: session.opened_by,
      closingCash: money(actual),
    });
    db.prepare(
      `UPDATE cash_sessions SET closed_by = ?, updated_at = ? WHERE session_date = ?`,
    ).run(user?.id ?? null, now, d);
  });
  run();

  audit(user, 'day_close', 'day_session', d, {
    expected_cash: cash.expected_cash,
    actual_cash: money(actual),
    difference,
    stock_discrepancies: stockDifference.length,
    remarks: trimmed || null,
  });

  return dayStatus(d);
}

export function reopenDay({ user, date, reason }) {
  const d = businessDate(date);
  const session = daySession(d);
  if (!session) throw new HttpError(404, 'No closing record exists for this business date');
  if (session.status !== 'closed') throw new HttpError(400, 'This business date is not closed');
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 5) throw new HttpError(400, 'A reopen reason of at least 5 characters is required');

  const now = nowISO();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO day_reopens (business_date, reason, reopened_by, reopened_by_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(d, trimmed, user?.id ?? null, user?.name || null, now);
    db.prepare(
      `UPDATE day_sessions
          SET status = 'open', locked = 0, reopen_count = reopen_count + 1,
              closing_remarks = ?, updated_at = ?
        WHERE business_date = ?`,
    ).run(trimmed, now, d);
    db.prepare('UPDATE cash_sessions SET closing_cash = NULL, updated_at = ? WHERE session_date = ?').run(now, d);
  });
  run();

  audit(user, 'day_reopen', 'day_session', d, { reason: trimmed, reopen_count: session.reopen_count + 1 });
  return dayStatus(d);
}

export function dayHistory({ from, to }) {
  const rows = db
    .prepare(
      `SELECT * FROM day_sessions
        WHERE business_date BETWEEN ? AND ?
        ORDER BY business_date DESC`,
    )
    .all(from, to);
  return rows.map((s) => {
    const cash = cashSummary(s.business_date);
    return {
      ...s,
      cash,
      reopen_events: db
        .prepare('SELECT * FROM day_reopens WHERE business_date = ? ORDER BY created_at')
        .all(s.business_date),
    };
  });
}

export function dayTransactions(date) {
  return {
    bills: billsForDay(date),
    movements: cashMovementsForDay(date),
    adjustments: db
      .prepare(
        `SELECT a.*, p.name AS product_name
           FROM day_stock_adjustments a
           JOIN products p ON p.id = a.product_id
          WHERE a.business_date = ?
          ORDER BY a.created_at`,
      )
      .all(date),
    refunds: db
      .prepare(
        `SELECT * FROM refunds
          WHERE COALESCE(refund_date, substr(created_at, 1, 10)) = ?
          ORDER BY created_at`,
      )
      .all(date),
    expenses: db
      .prepare('SELECT * FROM expenses WHERE expense_date = ? ORDER BY created_at')
      .all(date),
  };
}

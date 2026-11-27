import { db, getSetting, audit, roundBottles } from './db.js';
import { HttpError, money, nowISO, localDate, today } from './util.js';

const PAYMENT_MODES = ['cash', 'upi', 'card', 'split', 'credit'];

/** Resolve cart lines against the live catalogue so prices/stock are authoritative. */
export function resolveItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'Add at least one item to the bill');
  }
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const getVariant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?');
  const lines = [];
  for (const raw of rawItems) {
    const productId = Number(raw.product_id);
    const variantId = Number(raw.variant_id);
    const qty = Number(raw.qty ?? 1);
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'Item quantity must be greater than zero');
    const product = getProduct.get(productId);
    if (!product || !product.is_active) throw new HttpError(400, `Product ${raw.product_name || productId} is unavailable`);
    const variant = getVariant.get(variantId, productId);
    if (!variant || !variant.is_active) {
      throw new HttpError(400, `Selected size for ${product.name} is unavailable`);
    }
    const unitPrice = money(variant.price);
    lines.push({
      product_id: product.id,
      variant_id: variant.id,
      product_name: product.name,
      variant_label: variant.label,
      ml: variant.ml,
      qty: Math.round(qty * 100) / 100,
      unit_price: unitPrice,
      line_total: money(unitPrice * qty),
      consume_qty: variant.consume_qty,
      unit_type: product.unit_type,
      stock_mode: product.stock_mode || 'unit',
      stock_qty: product.stock_qty,
      stock_bottles: product.stock_bottles,
      variant_stock: variant.stock_qty,
      bottle_size_ml: product.bottle_size_ml || 180,
    });
  }
  return lines;
}

export function computeTotals({ lines }) {
  // No GST, tax, service charge, discount or rounding: a bill is exactly the sum
  // of its line prices, so what the guest is quoted is what they pay.
  const subtotal = money(lines.reduce((sum, l) => sum + l.line_total, 0));
  return { subtotal, total: subtotal };
}

function splitPayment(payload, total) {
  const mode = String(payload.payment_mode || 'cash').toLowerCase();
  if (!PAYMENT_MODES.includes(mode)) throw new HttpError(400, 'Payment mode must be cash, upi, card or split');
  const tendered = (value) => (value === undefined || value === null || value === '' ? null : money(value));
  if (mode === 'split') {
    const cash = money(payload.cash_amount || 0);
    const upi = money(payload.upi_amount || 0);
    const card = money(payload.card_amount || 0);
    const sum = money(cash + upi + card);
    if (Math.abs(sum - total) > 0.05) {
      throw new HttpError(400, `Split payment parts (${sum}) must equal the bill total (${total})`);
    }
    return { mode, cash, upi, card };
  }
  if (mode === 'cash') {
    const received = tendered(payload.cash_received ?? payload.cash_amount);
    if (received !== null && received < total - 0.05) {
      throw new HttpError(400, `Cash received (${received}) is less than the bill total (${total})`);
    }
  }
  if (mode === 'upi') {
    const upiPaid = tendered(payload.upi_amount);
    if (upiPaid !== null && upiPaid < total - 0.05) {
      throw new HttpError(400, `UPI amount (${upiPaid}) is less than the bill total (${total})`);
    }
  }
  return {
    mode,
    cash: mode === 'cash' ? total : 0,
    upi: mode === 'upi' ? total : 0,
    card: mode === 'card' ? total : 0,
  };
}

function deductStock(lines, billId, userId, createdAt) {
  const allowNegative = getSetting('allow_negative_stock', '1') === '1';
  const updateBottle = db.prepare(
    'UPDATE products SET stock_bottles = ?, stock_qty = ?, updated_at = ? WHERE id = ?',
  );
  const updateUnit = db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?');
  const ledger = db.prepare(
    `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, ref_id, note, created_by, created_at)
     VALUES (?, ?, ?, 'sale', 'bill', ?, ?, ?, ?)`,
  );
  // Beer keeps one balance per bottle size, so the size travels with the movement.
  const ledgerVariant = db.prepare(
    `INSERT INTO stock_ledger (product_id, variant_id, change_qty, balance_qty, movement, ref_type, ref_id, note, created_by, created_at)
     VALUES (?, ?, ?, ?, 'sale', 'bill', ?, ?, ?, ?)`,
  );
  // A bill posts its stock movement exactly once: replayed/updated bills must not
  // deduct a second time.
  const alreadyPosted = db
    .prepare("SELECT COUNT(*) AS c FROM stock_ledger WHERE movement = 'sale' AND ref_type = 'bill' AND ref_id = ?")
    .get(billId).c;
  if (alreadyPosted > 0) return [];
  const warnings = [];
  for (const line of lines) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id);

    // Beer: stock is counted in bottles of one specific size.
    if (product.stock_mode === 'variant') {
      const variant = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(line.variant_id);
      if (!variant) throw new HttpError(400, `Selected bottle size for ${line.product_name} is unavailable`);
      const current = Number(variant.stock_qty) || 0;
      const next = Math.round((current - line.qty) * 10000) / 10000;
      if (next < 0 && !allowNegative) {
        throw new HttpError(
          400,
          `Not enough stock for ${line.product_name} ${variant.label} (${current} bottles left)`,
        );
      }
      db.prepare('UPDATE product_variants SET stock_qty = ? WHERE id = ?').run(next, variant.id);
      const total = db
        .prepare('SELECT COALESCE(SUM(stock_qty), 0) AS t FROM product_variants WHERE product_id = ?')
        .get(product.id).t;
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(
        Math.round((Number(total) || 0) * 10000) / 10000,
        createdAt,
        product.id,
      );
      ledgerVariant.run(
        product.id,
        variant.id,
        -line.qty,
        next,
        billId,
        `${variant.label} x ${line.qty} on ${line.product_name}`,
        userId,
        createdAt,
      );
      if (next <= 0) warnings.push(`${line.product_name} ${variant.label} is out of stock`);
      else if (next <= product.low_stock_qty) {
        warnings.push(`${line.product_name} ${variant.label} is low on stock (${next} bottles left)`);
      }
      continue;
    }

    // Liquor is stocked in sealed 180 ml bottles: a 90 ml pour removes exactly half a bottle.
    if (product.unit_type === 'ml') {
      const size = Number(product.bottle_size_ml) || 180;
      const usedBottles = roundBottles((line.consume_qty / size) * line.qty);
      const nextBottles = roundBottles(product.stock_bottles - usedBottles);
      if (nextBottles < 0 && !allowNegative) {
        throw new HttpError(
          400,
          `Not enough stock for ${line.product_name} (${product.stock_bottles} bottles left)`,
        );
      }
      updateBottle.run(nextBottles, money(nextBottles * size), createdAt, product.id);
      ledger.run(
        product.id,
        -usedBottles,
        nextBottles,
        billId,
        `${line.variant_label} x ${line.qty} on ${line.product_name} (-${usedBottles} bottles)`,
        userId,
        createdAt,
      );
      if (nextBottles <= 0) warnings.push(`${line.product_name} is out of stock`);
      else if (nextBottles <= product.low_stock_qty) {
        warnings.push(`${line.product_name} is low on stock (${nextBottles} bottles left)`);
      }
      continue;
    }

    const used = money(line.consume_qty * line.qty);
    const next = money(product.stock_qty - used);
    if (next < 0 && !allowNegative) {
      throw new HttpError(400, `Not enough stock for ${line.product_name} (${product.stock_qty} left)`);
    }
    updateUnit.run(next, createdAt, product.id);
    ledger.run(
      product.id,
      -used,
      next,
      billId,
      `${line.variant_label} x ${line.qty} on ${line.product_name}`,
      userId,
      createdAt,
    );
    if (next <= 0) warnings.push(`${line.product_name} is out of stock`);
    else if (next <= product.low_stock_qty) warnings.push(`${line.product_name} is low on stock`);
  }
  return warnings;
}

export function restoreStock(bill, userId) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(bill.order_id);
  const updateBottle = db.prepare(
    'UPDATE products SET stock_bottles = stock_bottles + ?, stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?',
  );
  const updateUnit = db.prepare('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?');
  const ledger = db.prepare(
    `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, ref_id, note, created_by, created_at)
     VALUES (?, ?, ?, 'return', 'bill-void', ?, ?, ?, ?)`,
  );
  const ledgerVariant = db.prepare(
    `INSERT INTO stock_ledger (product_id, variant_id, change_qty, balance_qty, movement, ref_type, ref_id, note, created_by, created_at)
     VALUES (?, ?, ?, ?, 'return', 'bill-void', ?, ?, ?, ?)`,
  );
  const now = nowISO();
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
    const variant = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(item.variant_id);

    // Beer: give the bottles back to the exact size that was sold.
    if (product?.stock_mode === 'variant') {
      if (!variant) continue;
      const next = Math.round(((Number(variant.stock_qty) || 0) + item.qty) * 10000) / 10000;
      db.prepare('UPDATE product_variants SET stock_qty = ? WHERE id = ?').run(next, variant.id);
      const total = db
        .prepare('SELECT COALESCE(SUM(stock_qty), 0) AS t FROM product_variants WHERE product_id = ?')
        .get(item.product_id).t;
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(
        Math.round((Number(total) || 0) * 10000) / 10000,
        now,
        item.product_id,
      );
      ledgerVariant.run(
        item.product_id,
        variant.id,
        item.qty,
        next,
        bill.id,
        `Void of ${bill.bill_no} (${variant.label})`,
        userId,
        now,
      );
      continue;
    }

    // Give the exact bottle fraction back for liquor voids.
    if (product?.unit_type === 'ml') {
      const size = Number(product.bottle_size_ml) || 180;
      const backBottles = roundBottles(((variant?.consume_qty ?? 0) / size) * item.qty);
      updateBottle.run(backBottles, money(backBottles * size), now, item.product_id);
      const after = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(item.product_id);
      ledger.run(
        item.product_id,
        backBottles,
        after.stock_bottles,
        bill.id,
        `Void of ${bill.bill_no} (+${backBottles} bottles)`,
        userId,
        now,
      );
      continue;
    }

    const back = money((variant?.consume_qty ?? 0) * item.qty);
    updateUnit.run(back, now, item.product_id);
    const after = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(item.product_id);
    ledger.run(item.product_id, back, after.stock_qty, bill.id, `Void of ${bill.bill_no}`, userId, now);
  }
}

function freeTable(tableId, now) {
  if (!tableId) return;
  db.prepare(`UPDATE dining_tables SET status = 'free', current_order_id = NULL, updated_at = ? WHERE id = ?`).run(
    now,
    tableId,
  );
  db.prepare('UPDATE table_sessions SET closed_at = ? WHERE table_id = ? AND closed_at IS NULL').run(now, tableId);
}

/**
 * Create a paid bill: order + items + bill + payments + stock ledger, all in one transaction.
 * Idempotent on client_uuid so offline bills can be replayed safely.
 */
export const createBill = db.transaction(({ user, payload, deviceId = null, offline = false }) => {
  if (payload.client_uuid) {
    const existing = db.prepare('SELECT * FROM bills WHERE client_uuid = ?').get(payload.client_uuid);
    if (existing) return { bill: existing, duplicate: true, warnings: [] };
  }

  const now = nowISO();
  const billDate = payload.bill_date || localDate(payload.paid_at || now);
  const lines = resolveItems(payload.items);
  const totals = computeTotals({ lines });
  const split = splitPayment(payload, totals.total);

  let table = null;
  if (payload.table_id) {
    table = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(payload.table_id);
    if (!table) throw new HttpError(400, 'Selected table was not found');
  }

  let orderId = payload.order_id ? Number(payload.order_id) : null;
  if (orderId) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new HttpError(400, 'Open tab not found');
    if (order.status !== 'open') throw new HttpError(400, 'That tab is already closed');
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
  } else {
    const count = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_date = ?').get(billDate).c;
    const orderNo = `ORD-${billDate.replaceAll('-', '')}-${String(count + 1).padStart(4, '0')}`;
    const res = db
      .prepare(
        `INSERT INTO orders (order_no, table_id, order_date, status, guests, subtotal, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'billed', ?, ?, ?, ?, ?)`,
      )
      .run(orderNo, table?.id ?? null, billDate, Number(payload.guests || 1), totals.subtotal, user.id, now, now);
    orderId = Number(res.lastInsertRowid);
  }

  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, ml, qty, unit_price, line_total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of lines) {
    insertItem.run(
      orderId,
      line.product_id,
      line.variant_id,
      line.product_name,
      line.variant_label,
      line.ml,
      line.qty,
      line.unit_price,
      line.line_total,
      now,
    );
  }

  db.prepare(
    `UPDATE orders SET status = 'billed', subtotal = ?, table_id = ?, guests = ?, updated_at = ? WHERE id = ?`,
  ).run(totals.subtotal, table?.id ?? null, Number(payload.guests || 1), now, orderId);

  const billCount = db.prepare('SELECT COUNT(*) AS c FROM bills WHERE bill_date = ?').get(billDate).c;
  const billNo = `BILL-${billDate.replaceAll('-', '')}-${String(billCount + 1).padStart(4, '0')}`;
  const cashReceived = money(payload.cash_received ?? payload.cash_amount ?? (split.cash || totals.total));
  const changeReturned = split.mode === 'cash' ? money(Math.max(0, cashReceived - totals.total)) : 0;

  const billRes = db
    .prepare(
      `INSERT INTO bills (bill_no, bill_date, order_id, table_id, table_label, customer_name, customer_phone,
        subtotal, total, payment_mode,
        cash_amount, upi_amount, card_amount, cash_received, change_returned, upi_ref, status,
        cashier_id, cashier_name, device_id, client_uuid, synced_from_offline, notes, created_at, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      billNo,
      billDate,
      orderId,
      table?.id ?? null,
      table?.label ?? payload.table_label ?? 'Counter',
      payload.customer_name || null,
      payload.customer_phone || null,
      totals.subtotal,
      totals.total,
      split.mode,
      split.cash,
      split.upi,
      split.card,
      cashReceived,
      changeReturned,
      payload.upi_ref || null,
      user.id,
      user.name,
      deviceId,
      payload.client_uuid || null,
      offline ? 1 : 0,
      payload.notes || null,
      payload.paid_at || now,
      payload.paid_at || now,
    );
  const billId = Number(billRes.lastInsertRowid);

  const insertPayment = db.prepare(
    `INSERT INTO payments (bill_id, mode, amount, reference, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  if (split.cash > 0) insertPayment.run(billId, 'cash', split.cash, null, now);
  if (split.upi > 0) insertPayment.run(billId, 'upi', split.upi, payload.upi_ref || null, now);
  if (split.card > 0) insertPayment.run(billId, 'card', split.card, payload.card_ref || null, now);

  const warnings = deductStock(lines, billId, user.id, now);
  freeTable(table?.id ?? null, now);

  if (payload.customer_phone) {
    const existingCustomer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(payload.customer_phone);
    if (existingCustomer) {
      db.prepare('UPDATE customers SET loyalty_points = loyalty_points + 1, name = COALESCE(?, name) WHERE id = ?').run(
        payload.customer_name || null,
        existingCustomer.id,
      );
    } else {
      db.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)').run(
        payload.customer_name || 'Guest',
        payload.customer_phone,
        now,
      );
    }
  }

  if (payload.client_uuid) {
    db.prepare(
      `INSERT INTO sync_log (device_id, client_uuid, entity, status, message, created_at)
       VALUES (?, ?, 'bill', ?, ?, ?)`,
    ).run(deviceId, payload.client_uuid, offline ? 'synced' : 'online', `Bill ${billNo} saved`, now);
  }

  audit(user, 'bill.create', 'bill', billId, { bill_no: billNo, total: totals.total, mode: split.mode, offline });
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  return { bill, duplicate: false, warnings };
});

export function billWithItems(billId) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return null;
  const items = bill.order_id
    ? db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(bill.order_id)
    : [];
  const payments = db.prepare('SELECT * FROM payments WHERE bill_id = ?').all(billId);
  return { ...bill, items, payments };
}

export const voidBill = db.transaction((billId, user, reason) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) throw new HttpError(404, 'Bill not found');
  if (bill.status === 'void') throw new HttpError(400, 'Bill is already void');
  const now = nowISO();
  restoreStock(bill, user.id);
  db.prepare(`UPDATE bills SET status = 'void', notes = ? WHERE id = ?`).run(
    reason ? `${bill.notes ? `${bill.notes} | ` : ''}Void: ${reason}` : bill.notes,
    billId,
  );
  if (bill.order_id) db.prepare(`UPDATE orders SET status = 'void', updated_at = ? WHERE id = ?`).run(now, bill.order_id);
  audit(user, 'bill.void', 'bill', billId, { bill_no: bill.bill_no, reason });
  return db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
});

/**
 * Owner-only soft delete of a bill. The bill row, its items and its payment
 * records are kept forever; only the flags change so the bill stops counting as
 * an active sale. Stock taken by the bill is returned to the shelf.
 */
export const deleteBill = db.transaction((billId, user, reason = null) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) throw new HttpError(404, 'Bill not found');
  if (user.role !== 'owner') throw new HttpError(403, 'Only the Owner can delete a bill');
  if (bill.deleted_at) throw new HttpError(400, 'This bill is already deleted');

  const now = nowISO();
  const payments = db.prepare('SELECT * FROM payments WHERE bill_id = ?').all(billId);
  const items = bill.order_id
    ? db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(bill.order_id)
    : [];
  const snapshot = JSON.stringify({ bill, items, payments });

  restoreStock(bill, user.id);
  db.prepare(
    `UPDATE bills SET status = 'void', deleted_at = ?, deleted_by = ?, deleted_by_name = ?, delete_reason = ?
      WHERE id = ?`,
  ).run(now, user.id, user.name, reason, billId);
  if (bill.order_id) {
    db.prepare(`UPDATE orders SET status = 'void', updated_at = ? WHERE id = ?`).run(now, bill.order_id);
  }
  const record = db
    .prepare(
      `INSERT INTO bill_deletions (bill_id, bill_no, bill_date, amount, payment_mode, status_before,
         deleted_by, deleted_by_name, deleted_at, reason, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(billId, bill.bill_no, bill.bill_date, bill.total, bill.payment_mode, bill.status,
      user.id, user.name, now, reason, snapshot);
  audit(user, 'bill.delete', 'bill', billId, {
    bill_no: bill.bill_no,
    bill_date: bill.bill_date,
    amount: bill.total,
    reason,
  });
  return {
    deleted: true,
    bill: db.prepare('SELECT * FROM bills WHERE id = ?').get(billId),
    deletion: db.prepare('SELECT * FROM bill_deletions WHERE id = ?').get(record.lastInsertRowid),
  };
});

export function dashboardSummary(date = today()) {
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(cash_amount),0) AS cash,
              COALESCE(SUM(upi_amount),0) AS upi, COALESCE(SUM(card_amount),0) AS card
       FROM bills WHERE bill_date = ? AND status = 'paid' AND deleted_at IS NULL`,
    )
    .get(date);
  const items = db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty),0) AS pours FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN bills b ON b.order_id = o.id
       WHERE b.bill_date = ? AND b.status = 'paid'`,
    )
    .get(date);
  const tables = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
              SUM(CASE WHEN status = 'free' THEN 1 ELSE 0 END) AS free
       FROM dining_tables`,
    )
    .get();
  const lowStock = db
    .prepare('SELECT COUNT(*) AS c FROM products WHERE is_active = 1 AND stock_qty <= low_stock_qty')
    .get().c;
  const expenses = db
    .prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date = ?')
    .get(date).total;
  const deleted = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS amount FROM bills
       WHERE bill_date = ? AND deleted_at IS NOT NULL`,
    )
    .get(date);
  return {
    date,
    ...sales,
    pours: items.pours,
    tables,
    low_stock: lowStock,
    expenses,
    deleted_bills: deleted.bills,
    deleted_amount: money(deleted.amount),
  };
}

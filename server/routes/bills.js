import express from 'express';
import { db } from '../db.js';
import { authenticate, manager, requireRole, verifyOwnerPin } from '../auth.js';
import { HttpError, today, toInt, money } from '../util.js';
import { createBill, billWithItems, voidBill, deleteBill, dashboardSummary } from '../billing.js';

const router = express.Router();
const owner = requireRole('owner');

/**
 * Live bottle/unit balances for the products on a bill, so the till can show the
 * updated stock immediately after payment without another request.
 */
function stockSnapshot(bill) {
  let ids = [...new Set((bill?.items || []).map((i) => i.product_id).filter((id) => id != null))];
  if (!ids.length) {
    try {
      ids = db
        .prepare('SELECT DISTINCT product_id FROM bill_items WHERE bill_id = ?')
        .all(bill.id)
        .map((r) => r.product_id)
        .filter((id) => id != null);
    } catch {
      ids = [];
    }
  }
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id, name, unit_type, stock_qty, stock_bottles FROM products WHERE id IN (${placeholders})`)
    .all(...ids)
    .map((p) => {
      const bottles = p.unit_type === 'ml' ? Math.round(Number(p.stock_bottles) * 10000) / 10000 : null;
      return {
        product_id: p.id,
        name: p.name,
        unit_type: p.unit_type,
        stock_qty: p.stock_qty,
        stock_bottles: bottles,
        sealed_bottles: bottles === null ? null : Math.floor(bottles + 1e-9),
      };
    });
}

/** Create a paid bill directly (used by quick sale and by offline sync replay). */
router.post('/', authenticate, (req, res) => {
  const payload = req.body || {};
  const { bill, duplicate, warnings } = createBill({
    user: req.user,
    payload,
    deviceId: payload.device_id || req.headers['x-device-id'] || null,
    offline: Boolean(payload.offline),
  });
  const saved = billWithItems(bill.id);
  res.status(duplicate ? 200 : 201).json({ bill: saved, duplicate, warnings, stock: stockSnapshot(saved) });
});

router.get('/summary', authenticate, (req, res) => {
  res.json(dashboardSummary(req.query.date || today()));
});

/** Permanent record of deleted bills — never erased, readable by managers and owner. */
router.get('/deleted', authenticate, manager, (req, res) => {
  const limit = Math.min(toInt(req.query.limit, 100), 500);
  const deletions = db
    .prepare(
      `SELECT d.id, d.bill_id, d.bill_no, d.bill_date, d.amount, d.payment_mode, d.status_before,
              d.deleted_by, d.deleted_by_name, d.deleted_at, d.reason,
              b.customer_name, b.table_label, b.cashier_name
         FROM bill_deletions d
         JOIN bills b ON b.id = d.bill_id
        ORDER BY d.deleted_at DESC, d.id DESC
        LIMIT ?`,
    )
    .all(limit);
  const totals = deletions.reduce(
    (acc, d) => {
      acc.amount = money(acc.amount + d.amount);
      acc.count += 1;
      return acc;
    },
    { amount: 0, count: 0 },
  );
  res.json({ deletions, totals });
});

router.get('/', authenticate, (req, res) => {
  const { date, from, to } = req.query;
  const limit = Math.min(toInt(req.query.limit, 100), 500);
  let rows;
  if (date) {
    rows = db.prepare('SELECT * FROM bills WHERE bill_date = ? ORDER BY id DESC LIMIT ?').all(date, limit);
  } else if (from && to) {
    rows = db.prepare('SELECT * FROM bills WHERE bill_date BETWEEN ? AND ? ORDER BY id DESC LIMIT ?').all(from, to, limit);
  } else {
    rows = db.prepare('SELECT * FROM bills ORDER BY id DESC LIMIT ?').all(limit);
  }
  const totals = rows.reduce(
    (acc, b) => {
      if (b.status !== 'paid' || b.deleted_at) return acc;
      acc.revenue += b.total;
      acc.cash += b.cash_amount;
      acc.upi += b.upi_amount;
      acc.card += b.card_amount;
      acc.count += 1;
      return acc;
    },
    { revenue: 0, cash: 0, upi: 0, card: 0, count: 0 },
  );
  res.json({ bills: rows, totals });
});

router.get('/:id', authenticate, (req, res) => {
  const bill = billWithItems(Number(req.params.id));
  if (!bill) throw new HttpError(404, 'Bill not found');
  res.json({ bill });
});

router.post('/:id/void', authenticate, manager, (req, res) => {
  const bill = voidBill(Number(req.params.id), req.user, req.body?.reason || null);
  res.json({ bill });
});

/**
 * Owner-only bill deletion. The Owner role alone is not enough: the request must
 * also carry the Owner PIN, which is checked against the stored bcrypt hash.
 * Nothing is erased — the bill, its items and its payments stay in the database
 * and a permanent deletion record is written for financial tracking.
 */
router.delete('/:id', authenticate, owner, (req, res) => {
  const pinCheck = verifyOwnerPin(req.user, req.body?.pin);
  if (!pinCheck.ok) throw new HttpError(pinCheck.status, pinCheck.message);
  const result = deleteBill(Number(req.params.id), req.user, req.body?.reason || null);
  res.json(result);
});

export default router;

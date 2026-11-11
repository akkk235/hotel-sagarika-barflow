import express from 'express';
import { db } from '../db.js';
import { authenticate, manager } from '../auth.js';
import { HttpError, today, toInt } from '../util.js';
import { createBill, billWithItems, voidBill, dashboardSummary } from '../billing.js';

const router = express.Router();

/** Create a paid bill directly (used by quick sale and by offline sync replay). */
router.post('/', authenticate, (req, res) => {
  const payload = req.body || {};
  const { bill, duplicate, warnings } = createBill({
    user: req.user,
    payload,
    deviceId: payload.device_id || req.headers['x-device-id'] || null,
    offline: Boolean(payload.offline),
  });
  res.status(duplicate ? 200 : 201).json({ bill: billWithItems(bill.id), duplicate, warnings });
});

router.get('/summary', authenticate, (req, res) => {
  res.json(dashboardSummary(req.query.date || today()));
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
      if (b.status !== 'paid') return acc;
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

export default router;

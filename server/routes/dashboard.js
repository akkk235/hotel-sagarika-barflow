import express from 'express';
import { db } from '../db.js';
import { authenticate } from '../auth.js';
import { dashboardSummary } from '../billing.js';
import { roomSummary } from '../lodging.js';
import { addDays, money, today } from '../util.js';

const router = express.Router();

/**
 * Dashboard keeps restaurant sales and room occupancy in separate sections.
 * Restaurant: 20 tables. Lodging: 9 rooms. They are never mixed.
 */
router.get('/', authenticate, (req, res) => {
  const date = req.query.date || today();
  const sales = dashboardSummary(date);
  const lodging = roomSummary();

  const tableRows = db.prepare('SELECT status, COUNT(*) AS c FROM dining_tables GROUP BY status').all();
  const tableCount = (status) => tableRows.find((r) => r.status === status)?.c || 0;
  const openTab = db
    .prepare(
      `SELECT COUNT(*) AS tabs, COALESCE(SUM((SELECT COALESCE(SUM(oi.line_total),0) FROM order_items oi WHERE oi.order_id = o.id)),0) AS amount
       FROM orders o WHERE o.status = 'open'`,
    )
    .get();

  const inventory = {
    total_bottles: money(
      db.prepare(`SELECT COALESCE(SUM(stock_bottles),0) AS v FROM products WHERE unit_type = 'ml' AND is_active = 1`).get().v,
    ),
    bottles_sold_today: money(
      db
        .prepare(
          `SELECT COALESCE(SUM(-change_qty),0) AS v FROM stock_ledger
           WHERE movement = 'sale' AND substr(created_at, 1, 10) = ?
             AND product_id IN (SELECT id FROM products WHERE unit_type = 'ml')`,
        )
        .get(date).v,
    ),
    low_stock_count: db
      .prepare(
        `SELECT COUNT(*) AS c FROM products WHERE is_active = 1 AND
           ((unit_type = 'ml' AND stock_bottles <= low_stock_qty) OR (unit_type = 'unit' AND stock_qty <= low_stock_qty))`,
      )
      .get().c,
    low_stock: db
      .prepare(
        `SELECT id, name, unit_type, stock_bottles, stock_qty, low_stock_qty FROM products
         WHERE is_active = 1 AND
           ((unit_type = 'ml' AND stock_bottles <= low_stock_qty) OR (unit_type = 'unit' AND stock_qty <= low_stock_qty))
         ORDER BY unit_type, stock_bottles LIMIT 6`,
      )
      .all(),
  };

  const week = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue FROM bills
       WHERE status = 'paid' AND bill_date BETWEEN ? AND ?`,
    )
    .get(addDays(date, -6), date);
  const topItem = db
    .prepare(
      `SELECT oi.product_name AS name, SUM(oi.qty) AS qty FROM order_items oi
       JOIN orders o ON o.id = oi.order_id JOIN bills b ON b.order_id = o.id
       WHERE b.status = 'paid' AND b.bill_date BETWEEN ? AND ?
       GROUP BY oi.product_name ORDER BY qty DESC LIMIT 1`,
    )
    .get(addDays(date, -6), date);

  res.json({
    date,
    restaurant: {
      tables_total: db.prepare('SELECT COUNT(*) AS c FROM dining_tables').get().c,
      free: tableCount('free'),
      occupied: tableCount('occupied'),
      reserved: tableCount('reserved'),
      cleaning: tableCount('cleaning'),
      open_tabs: openTab.tabs,
      open_amount: money(openTab.amount),
      bills: sales.bills,
      revenue: money(sales.revenue),
      cash: money(sales.cash),
      upi: money(sales.upi),
      card: money(sales.card),
      pours: sales.pours,
    },
    lodging,
    billing: {
      bills: sales.bills,
      revenue: money(sales.revenue),
      cash: money(sales.cash),
      upi: money(sales.upi),
      card: money(sales.card),
      discount: money(sales.discount),
      tax: money(sales.tax),
      expenses: money(sales.expenses),
    },
    inventory,
    reports: {
      week_bills: week.bills,
      week_revenue: money(week.revenue),
      top_item: topItem?.name || null,
      top_item_qty: topItem?.qty || 0,
    },
  });
});

export default router;

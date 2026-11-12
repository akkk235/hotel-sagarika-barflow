import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'barflow.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Hotel Sagarika BarFlow schema.
 * Restaurant POS: users, sessions, categories, products, product_variants,
 * suppliers, purchases, purchase_items, stock_ledger, dining_tables (20), table_sessions,
 * orders, order_items, bills, payments, customers, expenses, sync_log, settings, audit_logs.
 * Lodging: rooms (9), room_stays (occupancy history).
 *
 * Liquor rule: stock is held in sealed 180 ml bottles. `stock_bottles` is authoritative
 * for ml products; `stock_qty` mirrors the ml equivalent (stock_bottles * bottle_size_ml)
 * so existing reports keep working.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','staff')),
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti TEXT NOT NULL UNIQUE,
  device TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#c2410c',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand TEXT,
  sku TEXT UNIQUE,
  unit_type TEXT NOT NULL DEFAULT 'ml' CHECK (unit_type IN ('ml','unit')),
  bottle_size_ml INTEGER,
  stock_qty REAL NOT NULL DEFAULT 0,
  low_stock_qty REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  ml INTEGER NOT NULL DEFAULT 0,
  consume_qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (product_id, label)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  invoice_no TEXT,
  purchase_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  bottles REAL NOT NULL DEFAULT 1,
  ml_per_bottle INTEGER NOT NULL DEFAULT 750,
  total_ml REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change_qty REAL NOT NULL,
  balance_qty REAL NOT NULL,
  movement TEXT NOT NULL CHECK (movement IN ('opening','purchase','sale','adjustment','wastage','return')),
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  zone TEXT NOT NULL DEFAULT 'Main Hall',
  capacity INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','occupied','reserved','cleaning')),
  current_order_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  order_id INTEGER,
  guests INTEGER NOT NULL DEFAULT 1,
  opened_by INTEGER REFERENCES users(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  table_id INTEGER REFERENCES dining_tables(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','billed','void')),
  guests INTEGER NOT NULL DEFAULT 1,
  subtotal REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  ml INTEGER NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT NOT NULL UNIQUE,
  bill_date TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  table_id INTEGER REFERENCES dining_tables(id) ON DELETE SET NULL,
  table_label TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash','upi','card','split','credit')),
  cash_amount REAL NOT NULL DEFAULT 0,
  upi_amount REAL NOT NULL DEFAULT 0,
  card_amount REAL NOT NULL DEFAULT 0,
  cash_received REAL NOT NULL DEFAULT 0,
  change_returned REAL NOT NULL DEFAULT 0,
  upi_ref TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void','refunded')),
  cashier_id INTEGER REFERENCES users(id),
  cashier_name TEXT,
  device_id TEXT,
  client_uuid TEXT UNIQUE,
  synced_from_offline INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  deleted_by_name TEXT,
  delete_reason TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  amount REAL NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);

-- Permanent record of every deleted bill. Rows are never removed, so financial
-- history survives even after a bill stops counting as an active sale.
CREATE TABLE IF NOT EXISTS bill_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  bill_no TEXT NOT NULL,
  bill_date TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_mode TEXT,
  status_before TEXT,
  deleted_by INTEGER REFERENCES users(id),
  deleted_by_name TEXT,
  deleted_at TEXT NOT NULL,
  reason TEXT,
  snapshot TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  address TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  spent_by TEXT,
  created_by INTEGER REFERENCES users(id),
  client_uuid TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  client_uuid TEXT,
  entity TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  floor TEXT NOT NULL DEFAULT 'First Floor',
  room_type TEXT NOT NULL DEFAULT 'Standard',
  rate_per_night REAL NOT NULL DEFAULT 1500,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','maintenance')),
  current_stay_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  guest_phone TEXT,
  guest_id_proof TEXT,
  guests INTEGER NOT NULL DEFAULT 1,
  check_in_at TEXT NOT NULL,
  expected_check_out_at TEXT,
  check_out_at TEXT,
  rate_per_night REAL NOT NULL DEFAULT 0,
  nights INTEGER NOT NULL DEFAULT 1,
  room_charges REAL NOT NULL DEFAULT 0,
  extra_charges REAL NOT NULL DEFAULT 0,
  total_charges REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_mode TEXT,
  status TEXT NOT NULL DEFAULT 'in_house' CHECK (status IN ('in_house','checked_out','cancelled')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_by_name TEXT,
  checked_out_by INTEGER REFERENCES users(id),
  checked_out_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_room_stays_room ON room_stays(room_id);
CREATE INDEX IF NOT EXISTS idx_room_stays_status ON room_stays(status);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(bill_date);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_product ON stock_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
`;

db.exec(SCHEMA);

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// v2 migration: liquor is purchased, stocked and sold from sealed 180 ml bottles.
if (!hasColumn('products', 'stock_bottles')) {
  db.exec('ALTER TABLE products ADD COLUMN stock_bottles REAL NOT NULL DEFAULT 0');
  db.exec(`UPDATE products SET stock_bottles = ROUND(stock_qty / 180.0, 4)
           WHERE unit_type = 'ml' AND stock_qty > 0`);
  db.exec(`UPDATE products SET low_stock_qty = ROUND(low_stock_qty / 180.0, 2)
           WHERE unit_type = 'ml' AND low_stock_qty > 180`);
}
// v3: GST/tax, service charge and discounts are removed for good. A bill is exactly
// the sum of its line prices, and deleting a bill is a soft delete that keeps the
// bill, its items and its payment records for financial tracking.
if (!hasColumn('users', 'pin_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
}
if (!hasColumn('bills', 'deleted_at')) {
  db.exec('ALTER TABLE bills ADD COLUMN deleted_at TEXT');
  db.exec('ALTER TABLE bills ADD COLUMN deleted_by INTEGER');
  db.exec('ALTER TABLE bills ADD COLUMN deleted_by_name TEXT');
  db.exec('ALTER TABLE bills ADD COLUMN delete_reason TEXT');
}
for (const legacy of ['discount', 'tax_percent', 'tax_amount', 'service_charge', 'round_off']) {
  if (hasColumn('bills', legacy)) {
    try {
      db.exec(`ALTER TABLE bills DROP COLUMN ${legacy}`);
    } catch {
      /* very old SQLite builds keep the column; it is simply no longer used */
    }
  }
}
for (const table of ['suppliers', 'customers']) {
  if (hasColumn(table, 'gstin')) {
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN gstin`);
    } catch {
      /* ignore */
    }
  }
}
db.exec("DELETE FROM settings WHERE key IN ('gstin','tax_percent','service_charge_percent')");
db.exec('UPDATE bills SET total = subtotal WHERE total <> subtotal');
db.exec('CREATE INDEX IF NOT EXISTS idx_bills_deleted ON bills(deleted_at)');

db.exec("UPDATE products SET bottle_size_ml = 180 WHERE unit_type = 'ml'");
db.exec(
  "UPDATE products SET stock_qty = ROUND(stock_bottles * 180, 2) WHERE unit_type = 'ml'",
);

/* ---------- Reports & analytics upgrade (additive only, historic rows preserved) ---------- */

// Refunds are recorded against the original bill; the bill itself is never erased.
for (const column of [
  ['refund_amount', 'REAL NOT NULL DEFAULT 0'],
  ['refund_reason', 'TEXT'],
  ['refunded_at', 'TEXT'],
  ['refunded_by', 'INTEGER'],
]) {
  if (!hasColumn('bills', column[0])) {
    db.exec(`ALTER TABLE bills ADD COLUMN ${column[0]} ${column[1]}`);
  }
}

// Opening/closing cash declared by the manager or owner for each business day.
db.exec(`
CREATE TABLE IF NOT EXISTS cash_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL UNIQUE,
  opening_cash REAL NOT NULL DEFAULT 0,
  closing_cash REAL,
  note TEXT,
  opened_by INTEGER REFERENCES users(id),
  closed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  bill_no TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  approved_by INTEGER REFERENCES users(id),
  performed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);`);

// Date/aggregate indexes so report queries stay fast as history grows.
db.exec('CREATE INDEX IF NOT EXISTS idx_bills_date_status ON bills(bill_date, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bills_staff ON bills(cashier_id, bill_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bills_table ON bills(table_id, bill_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bills_payment ON bills(payment_mode, bill_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_created ON stock_ledger(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_product ON stock_ledger(product_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_bill ON refunds(bill_id)');

/** Round a bottle count to 4 decimals so 90 ml stays exactly 0.5 of a bottle. */
export function roundBottles(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

/** Bottle-equivalent stock, sealed bottle count and loose ml for a liquor product. */
export function bottleStock(product) {
  const size = Number(product.bottle_size_ml) || 180;
  const bottles = roundBottles(product.stock_bottles);
  const sealed = Math.floor(bottles + 1e-9);
  const looseMl = Math.max(0, Math.round((bottles - sealed) * size));
  return {
    bottle_size_ml: size,
    stock_bottles: bottles,
    sealed_bottles: sealed,
    loose_ml: looseMl,
    bottles_label: `${bottles.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} bottles`,
  };
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), new Date().toISOString());
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function audit(user, action, entity, entityId, detail) {
  try {
    db.prepare(
      `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user?.id ?? null,
      user?.name ?? 'system',
      action,
      entity ?? null,
      entityId ?? null,
      detail ? JSON.stringify(detail) : null,
      new Date().toISOString(),
    );
  } catch {
    // auditing must never break a sale
  }
}

export function nextDocNo(prefix, table, dateColumn, date) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${dateColumn} = ?`)
    .get(date);
  const seq = String((row?.c ?? 0) + 1).padStart(4, '0');
  return `${prefix}-${date.replaceAll('-', '')}-${seq}`;
}

export { DB_PATH };

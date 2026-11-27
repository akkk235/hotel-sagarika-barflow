import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DB_PATH, audit, getSettings, setSetting } from './db.js';
import {
  BEER_DEFAULT_SIZES,
  BOTTLE_ML,
  beerSizeLabel,
  deriveLiquorPricing,
  roundUpToFive,
} from './pricing.js';

/**
 * Safe, additive migrations for the liquor-price and beer-size upgrade.
 *
 * Rules followed here:
 *  - the database file is backed up before any schema change;
 *  - only additive ALTER TABLE / CREATE INDEX statements are used, so product
 *    ids, bills, order items and historical rows are never rewritten;
 *  - each data migration runs once and is recorded in `settings`;
 *  - liquor stock stays in sealed 180 ml bottles (no change to stock maths);
 *  - beer stock becomes one balance per bottle size.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/** Copy the SQLite file (after a WAL checkpoint) into data/backups. */
export function backupDatabase(reason = 'migration') {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dir = path.join(path.dirname(DB_PATH), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `barflow-${reason}-${stamp}.db`);
    fs.copyFileSync(DB_PATH, target);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    while (files.length > 10) fs.rmSync(path.join(dir, files.shift()), { force: true });
    return target;
  } catch (err) {
    // A backup failure must never take the till offline; the migration is additive.
    console.warn('[barflow] database backup skipped:', err.message);
    return null;
  }
}

/**
 * Liquor: the 180 ml bottle price is the single source of truth. Every pour is
 * priced as (bottle price / 180) * serving size, rounded up to a multiple of ₹5.
 * Historical bills keep the prices they were sold at (order_items snapshots).
 */
function migrateLiquorPricing() {
  if (getSettings().liquor_pricing_v3 === '1') return false;
  const now = new Date().toISOString();
  const products = db.prepare("SELECT * FROM products WHERE unit_type = 'ml'").all();
  const insert = db.prepare(
    `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at, stock_qty)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)`,
  );
  let changed = 0;
  for (const product of products) {
    const variants = db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
      .all(product.id);
    const full = variants.find((v) => Number(v.ml) === BOTTLE_ML);
    const thirty = variants.find((v) => Number(v.ml) === 30);
    let bottlePrice = Number(product.bottle_price) || Number(full?.price) || 0;
    if (!bottlePrice && thirty?.price) bottlePrice = round2(Number(thirty.price) * (BOTTLE_ML / 30));
    if (!bottlePrice) continue;

    // Keep the stored bottle price consistent with the derived 180 ml price.
    bottlePrice = roundUpToFive(bottlePrice);
    const prices = deriveLiquorPricing(bottlePrice);
    for (const row of prices) {
      const existing = variants.find((v) => Number(v.ml) === row.ml);
      if (existing) {
        db.prepare('UPDATE product_variants SET price = ?, label = ?, is_active = 1 WHERE id = ?').run(
          row.price,
          row.label,
          existing.id,
        );
      } else {
        insert.run(product.id, row.label, row.ml, row.ml, row.price, row.ml, now);
      }
    }
    db.prepare('UPDATE products SET bottle_price = ?, updated_at = ? WHERE id = ?').run(
      bottlePrice,
      now,
      product.id,
    );
    changed += 1;
  }
  setSetting('liquor_pricing_v3', '1');
  if (changed) {
    audit({ id: null, name: 'system' }, 'migration.liquor_pricing', 'product', null, {
      products: changed,
      rule: 'serving = roundUp5(bottle_price / 180 * ml)',
    });
  }
  return changed > 0;
}

/**
 * Liquor loose-serving charge: the proportional share plus ₹5, rounded up to ₹5.
 * The full 180 ml bottle keeps the entered bottle price. Existing pours are re-priced
 * once; historical bills keep their own price snapshots.
 */
function migrateLiquorLooseMarkup() {
  if (getSettings().liquor_pricing_v4 === '1') return false;
  const now = new Date().toISOString();
  const products = db
    .prepare("SELECT * FROM products WHERE unit_type = 'ml' AND COALESCE(bottle_price, 0) > 0")
    .all();
  let changed = 0;
  for (const product of products) {
    const prices = deriveLiquorPricing(Number(product.bottle_price));
    for (const row of prices) {
      const existing = db
        .prepare('SELECT * FROM product_variants WHERE product_id = ? AND ml = ?')
        .get(product.id, row.ml);
      if (!existing) continue;
      if (Number(existing.price) === row.price) continue;
      db.prepare('UPDATE product_variants SET price = ? WHERE id = ?').run(row.price, existing.id);
      changed += 1;
    }
  }
  setSetting('liquor_pricing_v4', '1');
  if (changed) {
    audit({ id: null, name: 'system' }, 'migration.liquor_loose_markup', 'product', null, {
      variants: changed,
      rule: 'loose = ceil(((bottle_price / 180 * ml) + 5) / 5) * 5; 180 ml unchanged',
    });
  }
  return changed > 0;
}

/**
 * Beer: every bottle size is an independent product variant with its own
 * purchase price, selling price and stock balance. Existing beer products keep
 * their id and their current stock (moved onto their existing bottle size), and
 * the standard 650/500/330 ml sizes are added for the admin to price.
 */
function migrateBeerSizes() {
  if (getSettings().beer_sizes_v1 === '1') return false;
  const now = new Date().toISOString();
  const products = db
    .prepare(
      `SELECT p.* FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE LOWER(COALESCE(c.name, '')) = 'beer'`,
    )
    .all();
  const insert = db.prepare(
    `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at, stock_qty, cost_price, is_default)
     VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?, 0)`,
  );
  let changed = 0;
  for (const product of products) {
    if (product.unit_type !== 'unit') continue;
    let variants = db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
      .all(product.id);
    db.prepare("UPDATE products SET stock_mode = 'variant', updated_at = ? WHERE id = ?").run(now, product.id);

    if (variants.length === 0) {
      insert.run(product.id, beerSizeLabel(650), 650, 0, 0, now, round2(product.stock_qty), product.cost_price);
    } else {
      // A beer product created before per-size stock has a single variant standing for its
      // original bottle and carrying no ml. Adopt it as the 650 ml size; inserting a second
      // 650 ml row would split the same bottle between two sizes.
      const legacy = variants.find((v) => !Number(v.ml));
      if (legacy && !variants.some((v) => Number(v.ml) === 650)) {
        db.prepare('UPDATE product_variants SET ml = 650, label = ?, consume_qty = 1 WHERE id = ?').run(
          beerSizeLabel(650),
          legacy.id,
        );
        variants = db
          .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
          .all(product.id);
      }
      // Product-level stock becomes the stock of the product's original size.
      const primary = variants.find((v) => Number(v.ml) === 650) || variants[0];
      db.prepare('UPDATE product_variants SET stock_qty = ?, is_default = 1 WHERE id = ?').run(
        round4(product.stock_qty),
        primary.id,
      );
      if (!primary.cost_price) {
        db.prepare('UPDATE product_variants SET cost_price = ? WHERE id = ?').run(
          round2(product.cost_price),
          primary.id,
        );
      }
      for (const size of BEER_DEFAULT_SIZES) {
        if (variants.some((v) => Number(v.ml) === size)) continue;
        insert.run(product.id, beerSizeLabel(size), size, 0, size, now, 0, product.cost_price);
      }
    }
    const total = db
      .prepare('SELECT COALESCE(SUM(stock_qty), 0) AS total FROM product_variants WHERE product_id = ?')
      .get(product.id).total;
    db.prepare('UPDATE products SET stock_qty = ?, stock_bottles = ?, updated_at = ? WHERE id = ?').run(
      round4(total),
      round4(total),
      now,
      product.id,
    );
    changed += 1;
  }
  setSetting('beer_sizes_v1', '1');
  if (changed) {
    audit({ id: null, name: 'system' }, 'migration.beer_sizes', 'product', null, { products: changed });
  }
  return changed > 0;
}

/**
 * Idempotent repair for beer catalogue rows. Older data can hold a product-level variant
 * (ml = 0) or two rows for the same bottle size, which splits one size's stock across rows
 * and leaves the product reading "Out of stock". Duplicate rows are merged into the row that
 * holds the stock; the surplus row is deactivated, never deleted, so ledger and bill history
 * still point at a real row.
 */
function repairBeerVariants() {
  const now = new Date().toISOString();
  const products = db.prepare("SELECT * FROM products WHERE stock_mode = 'variant'").all();
  let changed = 0;
  for (const product of products) {
    let variants = db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
      .all(product.id);
    const legacy = variants.find((v) => !Number(v.ml));
    if (legacy && !variants.some((v) => Number(v.ml) === 650)) {
      db.prepare('UPDATE product_variants SET ml = 650, label = ?, consume_qty = 1 WHERE id = ?').run(
        beerSizeLabel(650),
        legacy.id,
      );
      variants = db
        .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
        .all(product.id);
      changed += 1;
    }
    const bySize = new Map();
    for (const v of variants) {
      const size = Number(v.ml);
      if (!size) continue;
      if (!bySize.has(size)) bySize.set(size, []);
      bySize.get(size).push(v);
    }
    for (const [size, rows] of bySize) {
      if (rows.length < 2) continue;
      const keeper =
        rows.find((r) => Number(r.is_default)) || rows.find((r) => Number(r.stock_qty) > 0) || rows[0];
      const stock = rows.reduce((sum, r) => sum + (Number(r.stock_qty) || 0), 0);
      const priced = rows.find((r) => Number(r.price) > 0);
      const price = Number(keeper.price) || Number(priced?.price) || 0;
      db.prepare(
        'UPDATE product_variants SET stock_qty = ?, price = ?, label = ?, is_active = 1, is_default = 1 WHERE id = ?',
      ).run(round4(stock), price, beerSizeLabel(size), keeper.id);
      for (const row of rows) {
        if (row.id === keeper.id) continue;
        db.prepare('UPDATE product_variants SET is_active = 0, stock_qty = 0, is_default = 0 WHERE id = ?').run(
          row.id,
        );
      }
      changed += 1;
    }
    const total = db
      .prepare('SELECT COALESCE(SUM(stock_qty), 0) AS total FROM product_variants WHERE product_id = ? AND is_active = 1')
      .get(product.id).total;
    if (
      Math.abs(Number(product.stock_qty) - Number(total)) > 1e-9 ||
      Math.abs(Number(product.stock_bottles) - Number(total)) > 1e-9
    ) {
      db.prepare('UPDATE products SET stock_qty = ?, stock_bottles = ?, updated_at = ? WHERE id = ?').run(
        round4(total),
        round4(total),
        now,
        product.id,
      );
      changed += 1;
    }
  }
  return changed;
}

/**
 * Additive upgrade for accounts and stock auditability:
 *  - users.permissions stores granular permissions granted by the Admin;
 *  - stock_ledger.txn_id gives every stock entry a permanent unique id.
 * Existing rows keep working: a NULL permissions column falls back to role
 * defaults, and historic ledger rows are backfilled with stable ids.
 */
export function migrateUsersAndStock() {
  const wanted = [
    ['users', 'permissions', 'TEXT'],
    ['stock_ledger', 'txn_id', 'TEXT'],
  ];
  const missing = wanted.filter(([table, column]) => !hasColumn(table, column));
  const backupPath = missing.length ? backupDatabase('accounts-stock-upgrade') : null;
  for (const [table, column, ddl] of missing) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  const orphans = db.prepare('SELECT id FROM stock_ledger WHERE txn_id IS NULL').all();
  if (orphans.length) {
    const setTxn = db.prepare('UPDATE stock_ledger SET txn_id = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of orphans) setTxn.run(`legacy-${row.id}-${crypto.randomUUID()}`, row.id);
    })();
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_ledger_txn ON stock_ledger(txn_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_ledger_created ON stock_ledger(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bills_bill_date ON bills(bill_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bills_paid_date ON bills(status, bill_date)');
  return { backup: backupPath, txn_backfilled: orphans.length };
}

/** Run once at boot, after seeding, before routes serve requests. */
export function migrateCatalog() {
  const wanted = [
    ['products', 'stock_mode', "TEXT NOT NULL DEFAULT 'unit'"],
    ['products', 'bottle_price', 'REAL'],
    ['product_variants', 'stock_qty', 'REAL NOT NULL DEFAULT 0'],
    ['product_variants', 'cost_price', 'REAL'],
    ['product_variants', 'supplier_id', 'INTEGER'],
    ['product_variants', 'is_default', 'INTEGER NOT NULL DEFAULT 0'],
    ['stock_ledger', 'variant_id', 'INTEGER'],
    ['purchase_items', 'variant_id', 'INTEGER'],
  ];
  const missing = wanted.filter(([table, column]) => !hasColumn(table, column));
  const backupPath = missing.length ? backupDatabase('catalog-upgrade') : null;
  for (const [table, column, ddl] of missing) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_ledger_variant ON stock_ledger(variant_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_purchase_items_variant ON purchase_items(variant_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_variants_product_stock ON product_variants(product_id, stock_qty)');

  const liquor = migrateLiquorPricing();
  const looseMarkup = migrateLiquorLooseMarkup();
  const beer = migrateBeerSizes();
  const repaired = repairBeerVariants();
  const accounts = migrateUsersAndStock();
  return { backup: backupPath, liquor, looseMarkup, beer, repaired, accounts };
}

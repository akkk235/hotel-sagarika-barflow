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
    const variants = db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, ml')
      .all(product.id);
    db.prepare("UPDATE products SET stock_mode = 'variant', updated_at = ? WHERE id = ?").run(now, product.id);

    if (variants.length === 0) {
      insert.run(product.id, beerSizeLabel(650), 650, 0, 0, now, round2(product.stock_qty), product.cost_price);
    } else {
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
    db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(
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
  const beer = migrateBeerSizes();
  return { backup: backupPath, liquor, beer };
}

import express from 'express';
import { db, audit, getSettings, bottleStock, roundBottles } from '../db.js';
import { authenticate, manager } from '../auth.js';
import { HttpError, money, nowISO, toNum } from '../util.js';
import { roomList, roomSummary } from '../lodging.js';
import {
  BEER_DEFAULT_SIZES,
  beerSizeLabel,
  deriveLiquorPricing,
  pourLabel,
  roundUpToFive,
} from '../pricing.js';

const router = express.Router();

export function productsWithVariants({ includeInactive = false } = {}) {
  const products = db
    .prepare(
      `SELECT p.*, c.name AS category_name, c.color AS category_color
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY c.sort_order, p.name`,
    )
    .all();
  const variants = db
    .prepare(`SELECT * FROM product_variants ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, ml`)
    .all();
  const byProduct = new Map();
  for (const v of variants) {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(v);
  }
  return products.map((p) => {
    const variants = byProduct.get(p.id) || [];
    if (p.unit_type === 'ml') return { ...p, ...bottleStock(p), variants };
    // Beer stock lives on each bottle size; the product total mirrors their sum.
    if (p.stock_mode === 'variant') {
      const total = variants.reduce((sum, v) => sum + (Number(v.stock_qty) || 0), 0);
      const rounded = Math.round(total * 10000) / 10000;
      return { ...p, stock_qty: rounded, stock_bottles: rounded, variants };
    }
    return { ...p, variants };
  });
}

export function tableList() {
  return db
    .prepare(
      `SELECT t.*, o.order_no, o.subtotal AS open_total,
              (SELECT COALESCE(SUM(oi.line_total),0) FROM order_items oi WHERE oi.order_id = o.id) AS open_amount,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS open_items
       FROM dining_tables t
       LEFT JOIN orders o ON o.id = t.current_order_id AND o.status = 'open'
       ORDER BY t.sort_order`,
    )
    .all();
}

router.get('/bootstrap', authenticate, (req, res) => {
  res.json({
    server_time: nowISO(),
    settings: getSettings(),
    categories: db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all(),
    products: productsWithVariants(),
    tables: tableList(),
    rooms: roomList(),
    room_summary: roomSummary(),
    open_orders: db
      .prepare(`SELECT id, order_no, table_id, order_date, guests, created_at FROM orders WHERE status = 'open' ORDER BY id`)
      .all(),
    user: req.user,
  });
});

// ---------- Categories ----------
router.get('/categories', authenticate, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
       FROM categories c ORDER BY c.sort_order, c.name`,
    )
    .all();
  res.json({ categories: rows });
});

router.post('/categories', authenticate, manager, (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name || !String(name).trim()) throw new HttpError(400, 'Category name is required');
  const now = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM categories').get().m;
  try {
    const result = db
      .prepare(
        `INSERT INTO categories (name, description, color, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(String(name).trim(), description || null, color || '#c2410c', max + 1, now, now);
    audit(req.user, 'category.create', 'category', Number(result.lastInsertRowid), { name });
    res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(400, 'A category with that name already exists');
    throw err;
  }
});

router.put('/categories/:id', authenticate, manager, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Category not found');
  const { name, description, color, sort_order, is_active } = req.body || {};
  db.prepare(
    `UPDATE categories SET name = ?, description = ?, color = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?`,
  ).run(
    name ? String(name).trim() : existing.name,
    description ?? existing.description,
    color ?? existing.color,
    sort_order ?? existing.sort_order,
    is_active === undefined ? existing.is_active : is_active ? 1 : 0,
    nowISO(),
    id,
  );
  audit(req.user, 'category.update', 'category', id, req.body);
  res.json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

router.delete('/categories/:id', authenticate, manager, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE categories SET is_active = 0, updated_at = ? WHERE id = ?').run(nowISO(), id);
  audit(req.user, 'category.delete', 'category', id, null);
  res.json({ ok: true });
});

// ---------- Products ----------
router.get('/products', authenticate, (req, res) => {
  const includeInactive = req.query.all === '1';
  res.json({ products: productsWithVariants({ includeInactive }) });
});

/**
 * Variants for a new product.
 *  - Liquor: pours are derived from the 180 ml bottle price (rounded up to ₹5).
 *  - Beer: every bottle size is independent, with its own price and stock.
 */
function resolveVariantInput(body, { unitType, stockMode, bottlePrice }) {
  if (unitType === 'ml') {
    const base = bottlePrice || roundUpToFive(toNum(body.peg_price, 0) * 6);
    if (base > 0) return deriveLiquorPricing(base);
    const provided = Array.isArray(body.variants) ? body.variants : [];
    if (provided.length) {
      return provided.map((v) => ({
        label: v.label || pourLabel(Number(v.ml) || 0),
        ml: Number(v.ml) || 0,
        price: toNum(v.price, 0),
        consume_qty: toNum(v.consume_qty, Number(v.ml) || 1),
      }));
    }
    return deriveLiquorPricing(300);
  }
  if (stockMode === 'variant') {
    const provided = Array.isArray(body.variants) && body.variants.length ? body.variants : null;
    const list = provided || BEER_DEFAULT_SIZES.map((ml) => ({ ml, price: 0, stock_qty: 0 }));
    return list.map((v, i) => ({
      label: v.label || beerSizeLabel(Number(v.ml) || 0),
      ml: Number(v.ml) || 0,
      price: toNum(v.price, 0),
      consume_qty: 1,
      stock_qty: toNum(v.stock_qty, 0),
      cost_price:
        v.cost_price === undefined || v.cost_price === ''
          ? body.cost_price === undefined
            ? null
            : toNum(body.cost_price, 0)
          : toNum(v.cost_price, 0),
      supplier_id: v.supplier_id || body.supplier_id || null,
      is_default: v.is_default ? 1 : i === 0 ? 1 : 0,
    }));
  }
  return [
    {
      label: body.variant_label || 'Unit',
      ml: 0,
      price: toNum(body.price, 0),
      consume_qty: 1,
      stock_qty: 0,
    },
  ];
}

/** Beer product stock is the sum of its bottle sizes; keep both in step. */
function syncVariantStock(productId, { movement = null, user = null, now = nowISO() } = {}) {
  const total = db
    .prepare('SELECT COALESCE(SUM(stock_qty), 0) AS t FROM product_variants WHERE product_id = ?')
    .get(productId).t;
  const rounded = Math.round((Number(total) || 0) * 10000) / 10000;
  db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(rounded, now, productId);
  if (movement === 'opening' && user) {
    const rows = db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND stock_qty <> 0').all(productId);
    const ledger = db.prepare(
      `INSERT INTO stock_ledger (product_id, variant_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
       VALUES (?, ?, ?, ?, 'opening', 'product', ?, ?, ?)`,
    );
    for (const row of rows) {
      ledger.run(productId, row.id, row.stock_qty, row.stock_qty, `Opening stock (${row.label})`, user.id, now);
    }
  }
  return rounded;
}

router.post('/products', authenticate, manager, (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) throw new HttpError(400, 'Product name is required');
  const unitType = body.unit_type === 'unit' ? 'unit' : 'ml';
  const stockMode = unitType === 'ml' ? 'bottle' : body.stock_mode === 'variant' ? 'variant' : 'unit';
  const now = nowISO();
  // Liquor stock is entered as a number of sealed 180 ml bottles.
  const bottles = unitType === 'ml' ? toNum(body.stock_bottles ?? body.stock_qty, 0) : 0;
  // Liquor is priced from the 180 ml bottle; each pour is a rounded-up fraction of it.
  const bottlePrice = unitType === 'ml' ? roundUpToFive(toNum(body.bottle_price, 0) || toNum(body.peg_price, 0) * 6) : 0;
  const create = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO products (name, category_id, brand, sku, unit_type, bottle_size_ml, stock_qty, stock_bottles,
           low_stock_qty, cost_price, stock_mode, bottle_price, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        String(body.name).trim(),
        body.category_id ? Number(body.category_id) : null,
        body.brand || null,
        body.sku || null,
        unitType,
        unitType === 'ml' ? 180 : null,
        unitType === 'ml' ? money(bottles * 180) : toNum(body.stock_qty, 0),
        bottles,
        toNum(body.low_stock_qty, unitType === 'ml' ? 2 : 10),
        toNum(body.cost_price, 0),
        stockMode,
        bottlePrice,
        now,
        now,
      );
    const productId = Number(result.lastInsertRowid);
    const variants = resolveVariantInput(body, { unitType, stockMode, bottlePrice });
    const insertVariant = db.prepare(
      `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at,
         stock_qty, cost_price, supplier_id, is_default)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    variants.forEach((v, i) => {
      insertVariant.run(
        productId,
        v.label,
        Number(v.ml || 0),
        toNum(v.consume_qty, unitType === 'ml' ? Number(v.ml || 0) : 1),
        money(v.price),
        i,
        now,
        toNum(v.stock_qty, 0),
        v.cost_price === null || v.cost_price === undefined ? null : toNum(v.cost_price, 0),
        v.supplier_id ? Number(v.supplier_id) : null,
        v.is_default ? 1 : 0,
      );
    });
    if (stockMode === 'variant') {
      syncVariantStock(productId, { movement: 'opening', user: req.user, now });
    } else {
      const opening = unitType === 'ml' ? bottles : toNum(body.stock_qty, 0);
      if (opening !== 0) {
        db.prepare(
          `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
           VALUES (?, ?, ?, 'opening', 'product', ?, ?, ?)`,
        ).run(
          productId,
          opening,
          opening,
          unitType === 'ml' ? 'Opening stock (180 ml bottles)' : 'Opening stock',
          req.user.id,
          now,
        );
      }
    }
    return productId;
  });
  const id = create();
  audit(req.user, 'product.create', 'product', id, { name: body.name });
  res.status(201).json({ product: productsWithVariants({ includeInactive: true }).find((p) => p.id === id) });
});

router.put('/products/:id', authenticate, manager, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Product not found');
  const body = req.body || {};
  const now = nowISO();
  const nextUnit = body.unit_type === 'unit' || body.unit_type === 'ml' ? body.unit_type : existing.unit_type;
  const nextMode =
    nextUnit === 'ml'
      ? 'bottle'
      : body.stock_mode === 'variant' || existing.stock_mode === 'variant'
        ? 'variant'
        : 'unit';
  // A liquor bottle price is the single source of truth for every pour price.
  const nextBottlePrice =
    nextUnit === 'ml'
      ? roundUpToFive(
          toNum(body.bottle_price, 0) ||
            toNum(body.peg_price, 0) * 6 ||
            Number(existing.bottle_price) ||
            0,
        )
      : existing.bottle_price;
  const update = db.transaction(() => {
    db.prepare(
      `UPDATE products SET name = ?, category_id = ?, brand = ?, sku = ?, unit_type = ?, bottle_size_ml = ?,
        low_stock_qty = ?, cost_price = ?, stock_mode = ?, bottle_price = ?, is_active = ?, updated_at = ? WHERE id = ?`,
    ).run(
      body.name ? String(body.name).trim() : existing.name,
      body.category_id === undefined ? existing.category_id : body.category_id ? Number(body.category_id) : null,
      body.brand ?? existing.brand,
      body.sku ?? existing.sku,
      nextUnit,
      nextUnit === 'ml'
        ? 180
        : body.bottle_size_ml === undefined
          ? existing.bottle_size_ml
          : Number(body.bottle_size_ml) || null,
      body.low_stock_qty === undefined ? existing.low_stock_qty : toNum(body.low_stock_qty, existing.low_stock_qty),
      body.cost_price === undefined ? existing.cost_price : toNum(body.cost_price, existing.cost_price),
      nextMode,
      nextBottlePrice,
      body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0,
      now,
      id,
    );
    // Liquor: re-derive every pour price from the bottle price (rule, not a manual edit).
    if (nextUnit === 'ml' && nextBottlePrice > 0) {
      const upsert = db.prepare(
        `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at,
           stock_qty, is_default)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, 0)
         ON CONFLICT(product_id, label) DO UPDATE SET ml = excluded.ml, consume_qty = excluded.consume_qty,
           price = excluded.price, sort_order = excluded.sort_order, is_active = 1`,
      );
      deriveLiquorPricing(nextBottlePrice).forEach((row, i) => {
        upsert.run(id, row.label, row.ml, row.ml, row.price, i, now);
      });
    } else if (Array.isArray(body.variants)) {
      const upsert = db.prepare(
        `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at,
           stock_qty, cost_price, supplier_id, is_default)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id, label) DO UPDATE SET ml = excluded.ml, consume_qty = excluded.consume_qty,
           price = excluded.price, sort_order = excluded.sort_order, is_active = 1,
           cost_price = COALESCE(excluded.cost_price, product_variants.cost_price),
           supplier_id = COALESCE(excluded.supplier_id, product_variants.supplier_id),
           is_default = excluded.is_default`,
      );
      body.variants.forEach((v, i) => {
        upsert.run(
          id,
          v.label || beerSizeLabel(Number(v.ml) || 0),
          Number(v.ml || 0),
          toNum(v.consume_qty, Number(v.ml || 0) || 1),
          money(v.price),
          i,
          now,
          toNum(v.stock_qty, 0),
          v.cost_price === undefined || v.cost_price === '' ? null : toNum(v.cost_price, 0),
          v.supplier_id ? Number(v.supplier_id) : null,
          v.is_default ? 1 : 0,
        );
      });
    }
    if (nextMode === 'variant') syncVariantStock(id, { now });
  });
  update();
  audit(req.user, 'product.update', 'product', id, body);
  res.json({ product: productsWithVariants({ includeInactive: true }).find((p) => p.id === id) });
});

router.delete('/products/:id', authenticate, manager, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?').run(nowISO(), id);
  audit(req.user, 'product.delete', 'product', id, null);
  res.json({ ok: true });
});

// ---------- Stock ----------
router.post('/products/:id/stock', authenticate, manager, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) throw new HttpError(404, 'Product not found');
  const body = req.body || {};
  const movement = ['purchase', 'adjustment', 'wastage', 'return'].includes(body.movement) ? body.movement : 'purchase';
  // For liquor, change_qty is a number of 180 ml bottles (0.5 = one 90 ml pour).
  const change = toNum(body.change_qty ?? body.change_bottles, 0);
  if (change === 0) throw new HttpError(400, 'Enter a quantity to add or remove');
  const now = nowISO();

  // Beer: adjust one bottle size, and keep the product total in step.
  if (product.stock_mode === 'variant') {
    const variantId = body.variant_id ? Number(body.variant_id) : null;
    const variant = variantId
      ? db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?').get(variantId, id)
      : null;
    if (!variant) throw new HttpError(400, 'Choose the bottle size to adjust');
    const nextSize = Math.round(((Number(variant.stock_qty) || 0) + change) * 10000) / 10000;
    if (nextSize < 0) throw new HttpError(400, 'Bottle stock cannot go below zero');
    db.transaction(() => {
      db.prepare('UPDATE product_variants SET stock_qty = ? WHERE id = ?').run(nextSize, variant.id);
      syncVariantStock(id, { now });
      db.prepare(
        `INSERT INTO stock_ledger (product_id, variant_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
      ).run(
        id,
        variant.id,
        change,
        nextSize,
        movement,
        body.note || `${variant.label} stock entry`,
        req.user.id,
        now,
      );
    })();
    audit(req.user, 'stock.adjust', 'product', id, { change, movement, variant_id: variant.id, balance: nextSize });
    return res.json({ product: productsWithVariants({ includeInactive: true }).find((p) => p.id === id) });
  }

  if (product.unit_type === 'ml') {
    const nextBottles = roundBottles(product.stock_bottles + change);
    if (nextBottles < 0) throw new HttpError(400, 'Bottle stock cannot go below zero');
    db.transaction(() => {
      db.prepare('UPDATE products SET stock_bottles = ?, stock_qty = ?, updated_at = ? WHERE id = ?').run(
        nextBottles,
        money(nextBottles * (Number(product.bottle_size_ml) || 180)),
        now,
        id,
      );
      db.prepare(
        `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
      ).run(id, change, nextBottles, movement, body.note || 'Bottle stock entry', req.user.id, now);
    })();
    audit(req.user, 'stock.adjust', 'product', id, { change_bottles: change, movement, balance: nextBottles });
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    return res.json({ product: { ...updated, ...bottleStock(updated) } });
  }

  const next = money(product.stock_qty + change);
  if (next < 0) throw new HttpError(400, 'Stock cannot go below zero');
  db.transaction(() => {
    db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(next, now, id);
    db.prepare(
      `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
       VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
    ).run(id, change, next, movement, body.note || null, req.user.id, now);
  })();
  audit(req.user, 'stock.adjust', 'product', id, { change, movement, balance: next });
  res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
});

router.get('/stock/ledger', authenticate, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const productId = req.query.product_id ? Number(req.query.product_id) : null;
  const variantId = req.query.variant_id ? Number(req.query.variant_id) : null;
  const filters = [
    productId ? 'l.product_id = ?' : null,
    variantId ? 'l.variant_id = ?' : null,
  ].filter(Boolean);
  const params = [
    ...(productId ? [productId] : []),
    ...(variantId ? [variantId] : []),
    limit,
  ];
  const rows = db
    .prepare(
      `SELECT l.*, p.name AS product_name, v.label AS variant_label FROM stock_ledger l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN product_variants v ON v.id = l.variant_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY l.id DESC LIMIT ?`,
    )
    .all(...params);
  res.json({ ledger: rows });
});

export default router;

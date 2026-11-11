import express from 'express';
import { db, audit, getSettings } from '../db.js';
import { authenticate, manager } from '../auth.js';
import { HttpError, money, nowISO, toNum } from '../util.js';

const router = express.Router();
const POUR_SIZES = [30, 60, 90, 120, 150, 180];

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
  return products.map((p) => ({ ...p, variants: byProduct.get(p.id) || [] }));
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

function standardPours(pegPrice) {
  return POUR_SIZES.map((ml, i) => ({
    label: `${ml} ml`,
    ml,
    price: money((Number(pegPrice) * ml) / 30),
    sort_order: i,
  }));
}

router.post('/products', authenticate, manager, (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) throw new HttpError(400, 'Product name is required');
  const unitType = body.unit_type === 'unit' ? 'unit' : 'ml';
  const now = nowISO();
  const create = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO products (name, category_id, brand, sku, unit_type, bottle_size_ml, stock_qty,
           low_stock_qty, cost_price, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        String(body.name).trim(),
        body.category_id ? Number(body.category_id) : null,
        body.brand || null,
        body.sku || null,
        unitType,
        body.bottle_size_ml ? Number(body.bottle_size_ml) : null,
        toNum(body.stock_qty, 0),
        toNum(body.low_stock_qty, unitType === 'ml' ? 1500 : 10),
        toNum(body.cost_price, 0),
        now,
        now,
      );
    const productId = Number(result.lastInsertRowid);
    let variants = Array.isArray(body.variants) && body.variants.length ? body.variants : null;
    if (!variants) {
      variants =
        unitType === 'ml'
          ? standardPours(toNum(body.peg_price, 50))
          : [{ label: body.variant_label || 'Unit', ml: 0, price: toNum(body.price, 0), consume_qty: 1 }];
    }
    const insertVariant = db.prepare(
      `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    variants.forEach((v, i) => {
      insertVariant.run(
        productId,
        v.label || (v.ml ? `${v.ml} ml` : 'Unit'),
        Number(v.ml || 0),
        toNum(v.consume_qty, unitType === 'ml' ? Number(v.ml || 0) : 1),
        money(v.price),
        i,
        now,
      );
    });
    if (toNum(body.stock_qty, 0) !== 0) {
      db.prepare(
        `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
         VALUES (?, ?, ?, 'opening', 'product', 'Opening stock', ?, ?)`,
      ).run(productId, toNum(body.stock_qty, 0), toNum(body.stock_qty, 0), req.user.id, now);
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
  const update = db.transaction(() => {
    db.prepare(
      `UPDATE products SET name = ?, category_id = ?, brand = ?, sku = ?, unit_type = ?, bottle_size_ml = ?,
        low_stock_qty = ?, cost_price = ?, is_active = ?, updated_at = ? WHERE id = ?`,
    ).run(
      body.name ? String(body.name).trim() : existing.name,
      body.category_id === undefined ? existing.category_id : body.category_id ? Number(body.category_id) : null,
      body.brand ?? existing.brand,
      body.sku ?? existing.sku,
      body.unit_type === 'unit' || body.unit_type === 'ml' ? body.unit_type : existing.unit_type,
      body.bottle_size_ml === undefined ? existing.bottle_size_ml : Number(body.bottle_size_ml) || null,
      body.low_stock_qty === undefined ? existing.low_stock_qty : toNum(body.low_stock_qty, existing.low_stock_qty),
      body.cost_price === undefined ? existing.cost_price : toNum(body.cost_price, existing.cost_price),
      body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0,
      now,
      id,
    );
    if (Array.isArray(body.variants)) {
      const upsert = db.prepare(
        `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(product_id, label) DO UPDATE SET ml = excluded.ml, consume_qty = excluded.consume_qty,
           price = excluded.price, sort_order = excluded.sort_order, is_active = 1`,
      );
      body.variants.forEach((v, i) => {
        upsert.run(
          id,
          v.label || (v.ml ? `${v.ml} ml` : 'Unit'),
          Number(v.ml || 0),
          toNum(v.consume_qty, Number(v.ml || 0) || 1),
          money(v.price),
          i,
          now,
        );
      });
    }
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
  const change = toNum(body.change_qty, 0);
  if (change === 0) throw new HttpError(400, 'Enter a quantity to add or remove');
  const now = nowISO();
  const next = money(product.stock_qty + change);
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
  const rows = db
    .prepare(
      `SELECT l.*, p.name AS product_name FROM stock_ledger l
       JOIN products p ON p.id = l.product_id
       ${productId ? 'WHERE l.product_id = ?' : ''}
       ORDER BY l.id DESC LIMIT ?`,
    )
    .all(...(productId ? [productId, limit] : [limit]));
  res.json({ ledger: rows });
});

export default router;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database per run - must be set before the app (and db.js) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barflow-beer-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'test-secret-for-barflow-beer';

const { createApp } = await import('../server/app.js');
const { db } = await import('../server/db.js');

const app = createApp();
const server = app.listen(0, '0.0.0.0');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://localhost:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, urlPath, { token, body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

const today = new Date().toISOString().slice(0, 10);
const tokens = {};
const state = {};

async function login(username, password) {
  const res = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, `login failed for ${username}: ${res.text}`);
  return res.body.token;
}

/** Current stock of one beer bottle size. */
function sizeStock(variantId) {
  const row = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?').get(variantId);
  return Number(row?.stock_qty ?? NaN);
}

/** Sealed 180 ml bottle balance for a liquor product. */
function bottlesOf(productId) {
  const row = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(productId);
  return row ? Number(row.stock_bottles) : null;
}

let uuidCounter = 0;
const uuid = () => `test-beer-${Date.now()}-${++uuidCounter}`;

test('owner, manager and staff can log in', async () => {
  tokens.owner = await login('owner', 'owner123');
  tokens.manager = await login('manager', 'manager123');
  tokens.staff = await login('staff', 'staff123');
  assert.ok(tokens.owner && tokens.manager && tokens.staff);
});

/* ------------------------------------------------------- 1. LIQUOR PRICING */

test('liquor serving prices derive from the 180 ml bottle price and round up to ₹5', async () => {
  const res = await call('POST', '/api/products', {
    token: tokens.owner,
    body: {
      name: 'Pricing Test Whisky',
      unit_type: 'ml',
      bottle_price: 440,
      stock_bottles: 10,
      cost_price: 300,
    },
  });
  assert.equal(res.status, 201, res.text);
  const product = res.body.product;
  state.liquor = product;

  const byMl = new Map(product.variants.map((v) => [Number(v.ml), Number(v.price)]));
  // (440 / 180) × ml, rounded UP to the next multiple of ₹5. 90 ml is already 220 and must not grow.
  assert.equal(byMl.get(30), 75);
  assert.equal(byMl.get(60), 150);
  assert.equal(byMl.get(90), 220);
  assert.equal(byMl.get(120), 295);
  assert.equal(byMl.get(150), 370);
  assert.equal(byMl.get(180), 440);
  assert.equal(Number(product.bottle_price), 440);
  assert.equal(product.stock_bottles, 10);
});

test('liquor pricing rule holds for a second bottle price (₹375)', async () => {
  const res = await call('POST', '/api/products', {
    token: tokens.owner,
    body: { name: 'Pricing Test Rum', unit_type: 'ml', bottle_price: 375, stock_bottles: 4, cost_price: 250 },
  });
  assert.equal(res.status, 201, res.text);
  const byMl = new Map(res.body.product.variants.map((v) => [Number(v.ml), Number(v.price)]));
  // 375/180 = 2.0833 per ml → 62.5→65, 125→125 (exact multiple), 187.5→190, 250→250, 312.5→315, 375
  assert.equal(byMl.get(30), 65);
  assert.equal(byMl.get(60), 125);
  assert.equal(byMl.get(90), 190);
  assert.equal(byMl.get(120), 250);
  assert.equal(byMl.get(150), 315);
  assert.equal(byMl.get(180), 375);
});

test('editing the bottle price re-derives pours without touching stock', async () => {
  const before = bottlesOf(state.liquor.id);
  const res = await call('PUT', `/api/products/${state.liquor.id}`, {
    token: tokens.owner,
    body: { bottle_price: 540 },
  });
  assert.equal(res.status, 200, res.text);
  const byMl = new Map(res.body.product.variants.map((v) => [Number(v.ml), Number(v.price)]));
  assert.equal(byMl.get(30), 90); // 540/6 = 90 exactly
  assert.equal(byMl.get(90), 270);
  assert.equal(byMl.get(180), 540);
  assert.equal(bottlesOf(state.liquor.id), before, 'price edits must not change stock');

  // restore a clean price for later assertions
  await call('PUT', `/api/products/${state.liquor.id}`, { token: tokens.owner, body: { bottle_price: 440 } });
});

test('a paid 90 ml liquor sale deducts exactly half a bottle', async () => {
  const pour90 = state.liquor.variants.find((v) => Number(v.ml) === 90);
  const before = bottlesOf(state.liquor.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      client_uuid: uuid(),
      items: [{ product_id: state.liquor.id, variant_id: pour90.id, qty: 1 }],
      payment_mode: 'cash',
      cash_received: 220,
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.total, 220);
  assert.equal(bottlesOf(state.liquor.id), Number((before - 0.5).toFixed(4)));
});

/* ---------------------------------------------------------- 2. BEER SETUP */

test('a beer product keeps independent prices and stock per bottle size', async () => {
  const res = await call('POST', '/api/products', {
    token: tokens.owner,
    body: {
      name: 'Kingfisher Strong',
      unit_type: 'unit',
      stock_mode: 'variant',
      low_stock_qty: 5,
      variants: [
        { ml: 650, price: 160, cost_price: 100, stock_qty: 50 },
        { ml: 500, price: 130, cost_price: 80, stock_qty: 30 },
        { ml: 330, price: 90, cost_price: 55, stock_qty: 40 },
      ],
    },
  });
  assert.equal(res.status, 201, res.text);
  const beer = res.body.product;
  state.beer = beer;

  assert.equal(beer.stock_mode, 'variant');
  assert.equal(beer.variants.length, 3);
  const byMl = new Map(beer.variants.map((v) => [Number(v.ml), v]));
  assert.equal(Number(byMl.get(650).price), 160);
  assert.equal(Number(byMl.get(500).price), 130);
  assert.equal(Number(byMl.get(330).price), 90);
  assert.equal(Number(byMl.get(650).stock_qty), 50);
  assert.equal(Number(byMl.get(500).stock_qty), 30);
  assert.equal(Number(byMl.get(330).stock_qty), 40);
  // Product stock is the sum of the sizes, never a merged price.
  assert.equal(Number(beer.stock_qty), 120);
});

test('beer never gets the liquor pour sizes', async () => {
  const mls = state.beer.variants.map((v) => Number(v.ml)).sort((a, b) => b - a);
  assert.deepEqual(mls, [650, 500, 330]);
  for (const forbidden of [30, 60, 90, 120, 150, 180]) {
    assert.equal(mls.includes(forbidden), false, `beer must not expose a ${forbidden} ml serve`);
  }
});

test('a beer size can be added later (750 ml) with its own stock', async () => {
  const res = await call('PUT', `/api/products/${state.beer.id}`, {
    token: tokens.owner,
    body: {
      variants: [
        ...state.beer.variants.map((v) => ({ ml: Number(v.ml), label: v.label, price: Number(v.price), cost_price: Number(v.cost_price), stock_qty: Number(v.stock_qty) })),
        { ml: 750, label: '750 ml', price: 200, cost_price: 130, stock_qty: 6 },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  const added = res.body.product.variants.find((v) => Number(v.ml) === 750);
  assert.ok(added, '750 ml size must exist');
  assert.equal(Number(added.price), 200);
  assert.equal(Number(added.stock_qty), 6);
  // Existing sizes keep their stock through the price/size edit.
  assert.equal(sizeStock(state.beer.variants.find((v) => Number(v.ml) === 650).id), 50);
  state.beer = res.body.product;
});

/* ------------------------------------------------------- 3. BEER BILLING */

test('2 × 650 ml at ₹160 bills ₹320 and deducts 2 bottles of that size only', async () => {
  const size650 = state.beer.variants.find((v) => Number(v.ml) === 650);
  const size500 = state.beer.variants.find((v) => Number(v.ml) === 500);
  const size330 = state.beer.variants.find((v) => Number(v.ml) === 330);
  const before650 = sizeStock(size650.id);
  const before500 = sizeStock(size500.id);
  const before330 = sizeStock(size330.id);

  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      client_uuid: uuid(),
      items: [{ product_id: state.beer.id, variant_id: size650.id, qty: 2 }],
      payment_mode: 'upi',
      upi_ref: 'UPI-BEER-1',
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.total, 320);
  assert.equal(res.body.bill.payment_mode, 'upi');

  assert.equal(sizeStock(size650.id), before650 - 2);
  assert.equal(sizeStock(size500.id), before500, 'other sizes must not move');
  assert.equal(sizeStock(size330.id), before330, 'other sizes must not move');
  state.beer650 = size650;
});

test('beer stock movements are recorded per bottle size in the ledger', () => {
  const rows = db
    .prepare("SELECT * FROM stock_ledger WHERE variant_id = ? AND movement = 'sale' ORDER BY id DESC")
    .all(state.beer650.id);
  assert.ok(rows.length >= 1, 'a sale movement must exist for the 650 ml size');
  assert.equal(Number(rows[0].change_qty), -2);
  assert.equal(rows[0].product_id, state.beer.id);
});

test('re-posting the same bill (same client_uuid) never deducts stock twice', async () => {
  const size500 = state.beer.variants.find((v) => Number(v.ml) === 500);
  const before = sizeStock(size500.id);
  const clientUuid = uuid();
  const payload = {
    client_uuid: clientUuid,
    items: [{ product_id: state.beer.id, variant_id: size500.id, qty: 3 }],
    payment_mode: 'cash',
    cash_received: 390,
  };
  const first = await call('POST', '/api/bills', { token: tokens.staff, body: payload });
  assert.equal(first.status, 201, first.text);
  assert.equal(sizeStock(size500.id), before - 3);

  const second = await call('POST', '/api/bills', { token: tokens.staff, body: payload });
  assert.ok(second.status < 400, `duplicate should be accepted idempotently: ${second.text}`);
  assert.equal(second.body.duplicate, true);
  assert.equal(sizeStock(size500.id), before - 3, 'duplicate post must not deduct again');
});

test('an underpaid (failed) bill does not deduct beer stock', async () => {
  const size330 = state.beer.variants.find((v) => Number(v.ml) === 330);
  const before = sizeStock(size330.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      client_uuid: uuid(),
      items: [{ product_id: state.beer.id, variant_id: size330.id, qty: 1 }],
      payment_mode: 'cash',
      cash_received: 10,
    },
  });
  assert.ok(res.status >= 400, `underpaid bill must be rejected, got ${res.status}: ${res.text}`);
  assert.equal(sizeStock(size330.id), before, 'rejected bill must not deduct stock');
});

test('beer purchase entry receives bottles into one size and updates its cost', async () => {
  const size650 = state.beer.variants.find((v) => Number(v.ml) === 650);
  const before = sizeStock(size650.id);
  const res = await call('POST', '/api/admin/purchases', {
    token: tokens.manager,
    body: {
      purchase_date: today,
      items: [{ product_id: state.beer.id, variant_id: size650.id, bottles: 12, unit_cost: 105 }],
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(sizeStock(size650.id), before + 12);

  const variant = db.prepare('SELECT cost_price FROM product_variants WHERE id = ?').get(size650.id);
  assert.equal(Number(variant.cost_price), 105);

  const line = db
    .prepare('SELECT * FROM purchase_items WHERE variant_id = ? ORDER BY id DESC')
    .get(size650.id);
  assert.equal(Number(line.bottles), 12);
  assert.equal(Number(line.amount), 1260);
});

/* -------------------------------------------------------- 4. BEER REPORT */

test('beer report lists every bottle size with stock, sales and owner profit', async () => {
  const res = await call('GET', `/api/reports/report/beer?from=${today}&to=${today}`, { token: tokens.owner });
  assert.equal(res.status, 200, res.text);
  const report = res.body.report || res.body;

  assert.equal(report.title, 'Beer Report (by bottle size)');
  assert.ok(report.columns.includes('Gross profit'), 'owner sees gross profit');

  const rows = report.data.products;
  const row650 = rows.find((r) => r.name === 'Kingfisher Strong' && r.ml === 650);
  assert.ok(row650, 'report must include the 650 ml size');
  assert.equal(row650.sold, 2);
  assert.equal(row650.sales_value, 320);
  assert.equal(row650.purchased, 12);
  // 50 opening + 12 purchased - 2 sold = 60 closing
  assert.equal(row650.opening, 50);
  assert.equal(row650.closing, 60);
  assert.equal(row650.purchase_value, 1260);
  assert.ok(row650.gross_profit > 0, 'gross profit uses recorded purchase cost');

  const row330 = rows.find((r) => r.name === 'Kingfisher Strong' && r.ml === 330);
  assert.ok(row330, 'report must include the 330 ml size');
  assert.equal(row330.sold, 0);
  assert.equal(row330.closing, 40);
});

test('manager beer report hides cost and profit columns', async () => {
  const res = await call('GET', `/api/reports/report/beer?from=${today}&to=${today}`, { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  const report = res.body.report || res.body;
  assert.equal(report.columns.includes('Gross profit'), false);
  assert.equal(report.columns.includes('Cost of goods'), false);
  assert.ok(report.columns.includes('Sales value'), 'manager still sees sales value');
  assert.equal(report.data.include_cost, false);
});

/* ------------------------------------------------- 5. EXISTING BEHAVIOUR */

test('existing daily sales report still totals beer and liquor bills', async () => {
  const res = await call('GET', `/api/reports/report/daily?from=${today}&to=${today}`, { token: tokens.owner });
  assert.equal(res.status, 200, res.text);
  const report = res.body.report || res.body;
  assert.ok(report.data, 'daily report still returns data');
  const totals = report.totals || report.data?.totals || {};
  const sales = Number(totals.total_sales ?? totals.sales ?? report.data?.total_sales ?? 0);
  assert.ok(sales >= 320, `daily sales must include beer sales, saw ${sales}`);
});

test('liquor stock still reports sealed bottles and fractions', async () => {
  const res = await call('GET', '/api/products', { token: tokens.staff });
  assert.equal(res.status, 200, res.text);
  const liquor = res.body.products.find((p) => p.id === state.liquor.id);
  assert.equal(liquor.unit_type, 'ml');
  assert.equal(Number(liquor.stock_bottles), bottlesOf(state.liquor.id));
  assert.ok(String(liquor.stock_bottles).includes('.') || liquor.stock_bottles === 9.5);
});

/* ------------------------------------------- 9. SEEDED CATALOGUE INTEGRITY */

test('seeded beer product keeps exactly one row per bottle size and matching bottle stock', async () => {
  const res = await call('GET', '/api/products', { token: tokens.owner });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  const list = Array.isArray(body) ? body : body.products || [];
  const beer = list.find((p) => p.name === 'Kingfisher Strong Beer');
  assert.ok(beer, 'seeded beer product is present');

  const sizes = beer.variants.map((v) => Number(v.ml)).sort((a, b) => a - b);
  assert.deepEqual(sizes, [330, 500, 650], 'one variant per default bottle size, no duplicates');

  const perSize = beer.variants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
  assert.equal(Number(beer.stock_qty), perSize, 'product stock equals the sum of its sizes');
  assert.equal(Number(beer.stock_bottles), perSize, 'bottle stock is exposed for the product card');
  assert.ok(perSize > 0, 'seeded beer stock is visible in billing');
});

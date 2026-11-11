import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database per run - must be set before the app (and db.js) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barflow-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'test-secret-for-barflow';

const { createApp } = await import('../server/app.js');
const { db } = await import('../server/db.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { token, body, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const res = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, `login ${username} failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

function stockOf(productId) {
  return db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(productId).stock_qty;
}

const tokens = {};
let liquor = null;
let pour30 = null;
let pour180 = null;

test('health endpoint responds', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('schema has all 20 tables', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const expected = [
    'users', 'sessions', 'categories', 'products', 'product_variants', 'suppliers',
    'purchases', 'purchase_items', 'stock_ledger', 'dining_tables', 'table_sessions',
    'orders', 'order_items', 'bills', 'payments', 'customers', 'expenses', 'sync_log',
    'settings', 'audit_logs',
  ];
  for (const name of expected) assert.ok(tables.includes(name), `missing table ${name}`);
  assert.equal(tables.length, 20, `expected 20 tables, found ${tables.length}: ${tables.join(',')}`);
});

test('owner, manager and staff can log in with distinct roles', async () => {
  tokens.owner = await login('owner', 'owner123');
  tokens.manager = await login('manager', 'manager123');
  tokens.staff = await login('staff', 'staff123');
  const me = await call('GET', '/api/auth/me', { token: tokens.staff });
  assert.equal(me.body.user.role, 'staff');
  const bad = await call('POST', '/api/auth/login', { body: { username: 'staff', password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('API rejects unauthenticated requests', async () => {
  const res = await call('GET', '/api/bootstrap');
  assert.equal(res.status, 401);
});

test('bootstrap returns 20 tables, categories and pour sizes 30-180ml', async () => {
  const res = await call('GET', '/api/bootstrap', { token: tokens.staff });
  assert.equal(res.status, 200);
  assert.equal(res.body.tables.length, 20, 'expected 20 dining tables');
  assert.ok(res.body.categories.length >= 5, 'expected seeded categories');
  assert.ok(res.body.products.length >= 10, 'expected seeded products');

  liquor = res.body.products.find((p) => p.unit_type === 'ml' && p.variants.length >= 6);
  assert.ok(liquor, 'expected a liquor product with pour sizes');
  const labels = liquor.variants.map((v) => v.label);
  for (const ml of [30, 60, 90, 120, 150, 180]) {
    assert.ok(labels.includes(`${ml} ml`), `missing ${ml} ml pour on ${liquor.name}: ${labels.join(',')}`);
  }
  pour30 = liquor.variants.find((v) => v.ml === 30);
  pour180 = liquor.variants.find((v) => v.ml === 180);
  assert.ok(pour30.price > 0 && pour180.price > pour30.price, 'pour prices must increase with size');
});

test('cash bill deducts stock automatically', async () => {
  const before = stockOf(liquor.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 2 }],
      payment_mode: 'cash',
      cash_amount: 1000,
      client_uuid: 'test-cash-1',
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const bill = res.body.bill;
  assert.equal(bill.payment_mode, 'cash');
  assert.equal(bill.status, 'paid');
  assert.equal(bill.items.length, 1);
  assert.equal(bill.items[0].qty, 2);
  assert.ok(bill.total > 0);
  assert.equal(res.body.duplicate, false);

  const after = stockOf(liquor.id);
  assert.equal(before - after, 60, 'two 30ml pours should deduct 60ml');

  const ledger = db
    .prepare("SELECT * FROM stock_ledger WHERE product_id = ? AND reason = 'sale' ORDER BY id DESC LIMIT 1")
    .get(liquor.id);
  assert.ok(ledger, 'stock ledger should record the sale');
  assert.equal(ledger.qty_change, -60);
});

test('replaying the same offline bill is idempotent (no double stock deduction)', async () => {
  const before = stockOf(liquor.id);
  const payload = {
    items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 2 }],
    payment_mode: 'cash',
    cash_amount: 1000,
    client_uuid: 'test-cash-1',
  };
  const res = await call('POST', '/api/bills', { token: tokens.staff, body: payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(stockOf(liquor.id), before, 'duplicate replay must not deduct stock again');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bills WHERE client_uuid = ?').get('test-cash-1').c, 1);
});

test('UPI bill records payment mode and deducts 180ml', async () => {
  const before = stockOf(liquor.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour180.id, qty: 1 }],
      payment_mode: 'upi',
      upi_amount: pour180.price * 1.05 + 1,
      upi_ref: 'UPI-TEST-REF',
      client_uuid: 'test-upi-1',
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.bill.payment_mode, 'upi');
  assert.ok(res.body.bill.upi_amount > 0);
  assert.equal(before - stockOf(liquor.id), 180, 'one 180ml pour should deduct 180ml');
});

test('bill total equals subtotal + tax - discount', async () => {
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 4 }],
      payment_mode: 'cash',
      discount: 10,
      client_uuid: 'test-math-1',
    },
  });
  const b = res.body.bill;
  const expected = Math.round((b.subtotal - b.discount + b.tax_amount + b.service_charge + b.round_off) * 100) / 100;
  assert.equal(b.discount, 10);
  assert.ok(Math.abs(b.total - expected) < 0.02, `total ${b.total} != ${expected}`);
});

test('insufficient payment is rejected', async () => {
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 1 }],
      payment_mode: 'cash',
      cash_amount: 1,
      client_uuid: 'test-underpay',
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('table management: open a tab, add pours, settle with UPI', async () => {
  const tables = (await call('GET', '/api/tables', { token: tokens.staff })).body.tables;
  const free = tables.find((t) => t.status === 'free');
  assert.ok(free, 'expected a free table');

  const opened = await call('POST', `/api/tables/${free.id}/open`, {
    token: tokens.staff,
    body: { guests: 4, captain: 'Test Captain' },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const orderId = opened.body.order.id;

  const added = await call('POST', `/api/orders/${orderId}/items`, {
    token: tokens.staff,
    body: { product_id: liquor.id, variant_id: pour60.id, qty: 2 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.order.items.length, 1);

  const before = stockOf(liquor.id);
  const paid = await call('POST', `/api/orders/${orderId}/pay`, {
    token: tokens.staff,
    body: { payment_mode: 'upi', upi_amount: 5000, client_uuid: 'test-tab-1' },
  });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.bill.table_id, free.id);
  assert.equal(before - stockOf(liquor.id), 120, 'tab with two 60ml pours deducts 120ml');

  const after = (await call('GET', '/api/tables', { token: tokens.staff })).body.tables.find((t) => t.id === free.id);
  assert.equal(after.status, 'free', 'table should be released after settlement');
});

test('table status can be set to reserved', async () => {
  const tables = (await call('GET', '/api/tables', { token: tokens.staff })).body.tables;
  const target = tables.find((t) => t.status === 'free');
  const res = await call('PATCH', `/api/tables/${target.id}`, { token: tokens.staff, body: { status: 'reserved' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.table.status, 'reserved');
});

test('staff cannot manage products, manager can', async () => {
  const denied = await call('POST', '/api/products', {
    token: tokens.staff,
    body: { name: 'Denied Product', category_id: 1, unit_type: 'unit', price: 100 },
  });
  assert.equal(denied.status, 403);

  const cat = (await call('GET', '/api/categories', { token: tokens.manager })).body.categories[0];
  const created = await call('POST', '/api/products', {
    token: tokens.manager,
    body: { name: 'Test Brand Whisky', category_id: cat.id, unit_type: 'ml', peg_price: 60, stock_qty: 750 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const product = created.body.product;
  assert.equal(product.variants.length, 6, 'liquor product gets all six pour sizes');
  assert.deepEqual(
    product.variants.map((v) => v.ml).sort((a, b) => a - b),
    [30, 60, 90, 120, 150, 180],
  );
});

test('stock adjustment writes a ledger entry', async () => {
  const res = await call('POST', `/api/products/${liquor.id}/stock`, {
    token: tokens.manager,
    body: { qty_change: 750, reason: 'purchase', note: 'Test restock' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.product.stock_qty >= 750);
  const row = db
    .prepare("SELECT * FROM stock_ledger WHERE product_id = ? AND reason = 'purchase' ORDER BY id DESC LIMIT 1")
    .get(liquor.id);
  assert.equal(row.qty_change, 750);
});

test('reports reflect the bills created above', async () => {
  const dash = await call('GET', '/api/reports/dashboard', { token: tokens.manager });
  assert.equal(dash.status, 200);
  assert.ok(dash.body.summary.revenue > 0, 'dashboard should report revenue');
  assert.ok(dash.body.summary.bills >= 3);
  assert.ok(dash.body.summary.upi > 0 && dash.body.summary.cash > 0, 'both cash and UPI should be reported');

  const items = await call('GET', '/api/reports/items', { token: tokens.manager });
  assert.equal(items.status, 200);
  assert.ok(items.body.items.some((i) => i.product_name === liquor.name));

  const stock = await call('GET', '/api/reports/stock', { token: tokens.manager });
  assert.ok(stock.body.stock.length >= 1);
});

test('manager can void a bill and stock is returned', async () => {
  const created = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour90.id, qty: 1 }],
      payment_mode: 'cash',
      client_uuid: 'test-void-1',
    },
  });
  const billId = created.body.bill.id;
  const before = stockOf(liquor.id);
  const voided = await call('POST', `/api/bills/${billId}/void`, {
    token: tokens.manager,
    body: { reason: 'Test correction' },
  });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal(stockOf(liquor.id), before + 90, 'voiding returns the poured quantity to stock');

  const staffVoid = await call('POST', `/api/bills/${billId}/void`, { token: tokens.staff, body: {} });
  assert.equal(staffVoid.status, 403, 'staff must not void bills');
});

test('offline sync endpoint reports queued bills as already synced', async () => {
  const res = await call('GET', '/api/sync/state', { token: tokens.staff });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.products));
  assert.ok(res.body.server_time);

  const push = await call('POST', '/api/sync/bills', {
    token: tokens.staff,
    body: {
      device_id: 'test-device',
      bills: [
        {
          client_uuid: 'test-offline-1',
          items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 1 }],
          payment_mode: 'cash',
          cash_amount: 500,
          offline: true,
          created_at: new Date().toISOString(),
        },
      ],
    },
  });
  assert.ok([200, 201].includes(push.status), JSON.stringify(push.body));
  const again = await call('POST', '/api/sync/bills', {
    token: tokens.staff,
    body: {
      device_id: 'test-device',
      bills: [
        {
          client_uuid: 'test-offline-1',
          items: [{ product_id: liquor.id, variant_id: pour30.id, qty: 1 }],
          payment_mode: 'cash',
          cash_amount: 500,
          offline: true,
        },
      ],
    },
  });
  assert.ok([200, 201].includes(again.status));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bills WHERE client_uuid = ?').get('test-offline-1').c, 1);
});

test('settings can be read and updated by the owner', async () => {
  const res = await call('PUT', '/api/admin/settings', {
    token: tokens.owner,
    body: { hotel_name: 'Hotel Sagarika', tax_percent: '5', upi_id: 'sagarika@upi' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const boot = await call('GET', '/api/bootstrap', { token: tokens.owner });
  assert.equal(boot.body.settings.hotel_name, 'Hotel Sagarika');
  assert.equal(boot.body.settings.upi_id, 'sagarika@upi');
});

test('audit log records bill creation', async () => {
  const res = await call('GET', '/api/admin/audit', { token: tokens.owner });
  assert.equal(res.status, 200);
  assert.ok(res.body.audit.length > 0, 'audit log should not be empty');
});

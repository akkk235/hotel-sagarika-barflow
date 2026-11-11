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
// Bind on 0.0.0.0 like the production server; requests use localhost.
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

/** Sealed 180 ml bottle balance for a product. */
function bottlesOf(productId) {
  const row = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(productId);
  return row ? row.stock_bottles : null;
}

const tokens = {};
const state = {};

test('health endpoint responds', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('schema contains restaurant, lodging and inventory tables', () => {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  for (const required of [
    'users',
    'categories',
    'products',
    'product_variants',
    'dining_tables',
    'orders',
    'order_items',
    'bills',
    'payments',
    'stock_ledger',
    'settings',
    'audit_logs',
    'expenses',
    'suppliers',
    'sync_log',
    'rooms',
    'room_stays',
  ]) {
    assert.ok(names.has(required), `expected table ${required} to exist`);
  }
});

test('owner, manager and staff can log in', async () => {
  for (const [role, username, password] of [
    ['owner', 'owner', 'owner123'],
    ['manager', 'manager', 'manager123'],
    ['staff', 'staff', 'staff123'],
  ]) {
    const res = await call('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(res.status, 200, `${role} login failed: ${res.text}`);
    assert.ok(res.body.token, `${role} token missing`);
    assert.equal(res.body.user.role, role);
    tokens[role] = res.body.token;
  }
});

test('a wrong password is rejected', async () => {
  const res = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'nope' } });
  assert.equal(res.status, 401);
});

test('protected routes reject anonymous requests', async () => {
  const res = await call('GET', '/api/products');
  assert.equal(res.status, 401);
});

test('GST and tax settings no longer exist', async () => {
  const res = await call('PUT', '/api/admin/settings', {
    token: tokens.manager,
    body: { gstin: '29ABCDE1234F1Z5', tax_percent: 5, service_charge_percent: 5 },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.settings.gstin, undefined);
  assert.equal(res.body.settings.tax_percent, undefined);
  assert.equal(res.body.settings.service_charge_percent, undefined);
});

test('bootstrap seeds exactly 20 restaurant tables T1-T20', async () => {
  const res = await call('GET', '/api/bootstrap', { token: tokens.staff });
  assert.equal(res.status, 200);
  const tables = res.body.tables;
  assert.equal(tables.length, 20, 'expected exactly 20 restaurant tables');
  const labels = tables.map((t) => t.label).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(labels, Array.from({ length: 20 }, (_, i) => `T${i + 1}`));
  // Lodging rooms must never appear in the restaurant table list.
  assert.ok(!tables.some((t) => ['101', '102', '109'].includes(t.label)));
  state.tables = tables;
});

test('bootstrap seeds exactly 9 lodging rooms 101-109', async () => {
  const res = await call('GET', '/api/rooms', { token: tokens.staff });
  assert.equal(res.status, 200);
  assert.equal(res.body.rooms.length, 9, 'expected exactly 9 rooms');
  assert.deepEqual(
    res.body.rooms.map((r) => r.room_no),
    ['101', '102', '103', '104', '105', '106', '107', '108', '109'],
  );
  assert.equal(res.body.summary.total, 9);
  assert.equal(res.body.summary.available, 9);
  state.rooms = res.body.rooms;
});

test('liquor is stocked in sealed 180 ml bottles with six serve sizes', async () => {
  const res = await call('GET', '/api/bootstrap', { token: tokens.staff });
  const liquor = res.body.products.find((p) => p.unit_type === 'ml' && p.name === 'Blenders Pride Reserve');
  assert.ok(liquor, 'expected a seeded liquor product');
  state.liquor = liquor;

  assert.equal(liquor.bottle_size_ml, 180);
  assert.equal(liquor.stock_bottles, 10, 'seeded stock must be counted in bottles');
  assert.equal(liquor.sealed_bottles, 10);
  assert.equal(liquor.loose_ml, 0);

  assert.deepEqual(
    liquor.variants.map((v) => v.ml),
    [30, 60, 90, 120, 150, 180],
    'serve sizes must be 30/60/90/120/150 plus the full 180 ml bottle',
  );
  assert.equal(liquor.variants.find((v) => v.ml === 180).label, '180 ml (full bottle)');
  // Every serve size keeps its own editable price, scaling up with volume.
  const prices = liquor.variants.map((v) => v.price);
  assert.ok(prices.every((p) => p > 0));
  assert.ok(prices[5] > prices[0]);
  assert.equal(liquor.variants[0].price, 70);
  assert.equal(liquor.variants[2].price, 210);

  const beer = res.body.products.find((p) => p.unit_type === 'unit' && /Kingfisher/.test(p.name));
  assert.ok(beer, 'expected a unit product');
  state.beer = beer;
});

test('cash bill deducts the correct bottle fraction (2 x 30 ml = 60 ml)', async () => {
  const before = bottlesOf(state.liquor.id);
  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 2 }],
      payment_mode: 'cash',
      cash_amount: 1000,
      client_uuid: 'test-cash-1',
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.status, 'paid');
  assert.equal(res.body.bill.total, 140);
  const after = bottlesOf(state.liquor.id);
  const consumedMl = (before - after) * 180;
  assert.ok(Math.abs(consumedMl - 60) < 0.05, `expected 60 ml deducted, got ${consumedMl}`);
  state.cashBill = res.body.bill;
});

test('replaying the same client_uuid does not deduct stock twice', async () => {
  const before = bottlesOf(state.liquor.id);
  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 2 }],
      payment_mode: 'cash',
      cash_amount: 1000,
      client_uuid: 'test-cash-1',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.bill.id, state.cashBill.id);
  assert.equal(bottlesOf(state.liquor.id), before);
});

test('a full 180 ml serve deducts exactly one sealed bottle', async () => {
  const before = bottlesOf(state.liquor.id);
  const pour180 = state.liquor.variants.find((v) => v.ml === 180);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour180.id, qty: 1 }],
      payment_mode: 'upi',
      upi_amount: 420,
      client_uuid: 'test-full-bottle-1',
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.total, 420);
  const after = bottlesOf(state.liquor.id);
  assert.ok(Math.abs(before - after - 1) < 0.0001, `expected one bottle deducted, got ${before - after}`);
});

test('a 90 ml serve leaves 9.5 bottles from 10', async () => {
  const created = await call('POST', '/api/products', {
    token: tokens.manager,
    body: { name: 'Test 90 ml Bottle', category_id: state.liquor.category_id, unit_type: 'ml', stock_bottles: 10, peg_price: 90, cost_price: 300 },
  });
  assert.equal(created.status, 201, created.text);
  const product = created.body.product;
  assert.equal(product.stock_bottles, 10);
  assert.equal(product.variants.length, 6);

  const pour90 = product.variants.find((v) => v.ml === 90);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: product.id, variant_id: pour90.id, qty: 1 }],
      payment_mode: 'cash',
      cash_amount: 270,
      client_uuid: 'test-90ml-bottle',
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.total, 270);
  assert.equal(bottlesOf(product.id), 9.5, '10 bottles minus one 90 ml serve must leave 9.5 bottles');
});

test('bill totals add lines and reject an underpayment', async () => {
  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const beerVariant = state.beer.variants[0];
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [
        { product_id: state.liquor.id, variant_id: pour30.id, qty: 2 },
        { product_id: state.beer.id, variant_id: beerVariant.id, qty: 1 },
      ],
      payment_mode: 'cash',
      cash_amount: 1000,
      client_uuid: 'test-math-1',
    },
  });
  assert.equal(res.status, 201, res.text);
  const bill = res.body.bill;
  assert.equal(bill.items.length, 2);
  assert.equal(bill.subtotal, 360);
  assert.equal(bill.tax_amount, 0);
  assert.equal(bill.total, 360);
  assert.equal(bill.cash_amount, 360);
  assert.equal(bill.cash_received, 1000);
  assert.ok(bill.bill_no.startsWith('INV-'));

  const short = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 1 }],
      payment_mode: 'cash',
      cash_amount: 1,
      client_uuid: 'test-underpay-1',
    },
  });
  assert.equal(short.status, 400, 'cash payment below the total must be rejected');
});

test('only the Owner can delete a bill, and the record is never erased', async () => {
  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const created = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 2 }],
      payment_mode: 'cash',
      cash_amount: 140,
      client_uuid: 'test-delete-1',
    },
  });
  assert.equal(created.status, 201, created.text);
  const bill = created.body.bill;
  assert.equal(bill.total, 140);
  const stockBefore = bottlesOf(state.liquor.id);

  // Staff and managers are refused even when they supply the correct PIN.
  const staffTry = await call('DELETE', `/api/bills/${bill.id}`, {
    token: tokens.staff,
    body: { pin: '4321' },
  });
  assert.equal(staffTry.status, 403);
  const managerTry = await call('DELETE', `/api/bills/${bill.id}`, {
    token: tokens.manager,
    body: { pin: '4321' },
  });
  assert.equal(managerTry.status, 403);

  // The Owner needs the PIN; a wrong or missing PIN must not delete anything.
  const wrongPin = await call('DELETE', `/api/bills/${bill.id}`, {
    token: tokens.owner,
    body: { pin: '0000' },
  });
  assert.ok(wrongPin.status >= 400, 'a wrong PIN must be rejected');
  const noPin = await call('DELETE', `/api/bills/${bill.id}`, { token: tokens.owner, body: {} });
  assert.ok(noPin.status >= 400, 'a missing PIN must be rejected');
  const stillThere = db.prepare('SELECT status, deleted_at FROM bills WHERE id = ?').get(bill.id);
  assert.equal(stillThere.status, 'paid');
  assert.equal(stillThere.deleted_at, null);

  const ok = await call('DELETE', `/api/bills/${bill.id}`, {
    token: tokens.owner,
    body: { pin: '4321', reason: 'test correction' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.deletion.bill_no, bill.bill_no);
  assert.equal(ok.body.deletion.amount, 140);
  assert.equal(ok.body.deletion.bill_date, bill.bill_date);
  assert.ok(ok.body.deletion.deleted_by_name, 'the deleting user is recorded');
  assert.ok(ok.body.deletion.deleted_at, 'the deletion time is recorded');

  // The bill row and its payment records survive; only the flags change.
  const row = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
  assert.equal(row.total, 140);
  assert.ok(row.deleted_at);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?').get(bill.id).n >= 1);
  assert.ok(
    db.prepare("SELECT COUNT(*) AS n FROM bill_deletions WHERE bill_id = ?").get(bill.id).n === 1,
  );

  // Stock returns to the shelf and the bill stops counting as an active sale.
  assert.ok(bottlesOf(state.liquor.id) > stockBefore);
  const sales = await call('GET', `/api/reports/sales?from=${bill.bill_date}&to=${bill.bill_date}`, {
    token: tokens.manager,
  });
  assert.equal(sales.status, 200, sales.text);
  const history = await call('GET', '/api/bills/deleted', { token: tokens.manager });
  assert.equal(history.status, 200, history.text);
  assert.ok(history.body.deletions.some((d) => d.bill_no === bill.bill_no));
  assert.equal(history.body.deletions[0].reason, 'test correction');

  const audit = await call('GET', '/api/admin/audit', { token: tokens.manager });
  assert.ok(audit.body.audit.some((a) => a.action === 'bill.delete' && a.entity_id === bill.id));

  // Deleting the same bill twice is refused.
  const twice = await call('DELETE', `/api/bills/${bill.id}`, {
    token: tokens.owner,
    body: { pin: '4321' },
  });
  assert.equal(twice.status, 400);
});

test('a bill total is exactly the selling price with no tax or discount', async () => {
  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 2 }],
      payment_mode: 'cash',
      cash_amount: 140,
      client_uuid: 'test-notax-1',
    },
  });
  assert.equal(res.status, 201, res.text);
  const bill = res.body.bill;
  assert.equal(bill.subtotal, 140);
  assert.equal(bill.total, 140, 'the guest pays the exact selling price');
  for (const key of ['tax_amount', 'tax_percent', 'discount', 'service_charge', 'round_off']) {
    assert.equal(bill[key], undefined, `${key} must not exist on a bill`);
  }
});

test('a running table tab can be opened, served and settled', async () => {
  const table = state.tables.find((t) => t.label === 'T1');
  const before = bottlesOf(state.liquor.id);
  const open = await call('POST', `/api/tables/${table.id}/open`, { token: tokens.staff, body: { guests: 4 } });
  assert.equal(open.status, 201, open.text);
  const orderId = open.body.order.id;

  const pour60 = state.liquor.variants.find((v) => v.ml === 60);
  const add = await call('POST', `/api/orders/${orderId}/items`, {
    token: tokens.staff,
    body: { product_id: state.liquor.id, variant_id: pour60.id, qty: 2 },
  });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.body.order.items.length, 1);
  // 60 ml of a ₹70/30 ml pour costs ₹140, so two serves are ₹280.
  assert.equal(add.body.order.subtotal, 280);

  const pay = await call('POST', `/api/orders/${orderId}/pay`, {
    token: tokens.staff,
    body: { payment_mode: 'cash', cash_amount: 280, client_uuid: 'test-tab-pay-1' },
  });
  assert.equal(pay.status, 201, pay.text);
  assert.equal(pay.body.bill.total, 280);
  const consumedMl = (before - bottlesOf(state.liquor.id)) * 180;
  assert.ok(Math.abs(consumedMl - 120) < 0.05, `expected 120 ml deducted, got ${consumedMl}`);

  const tables = await call('GET', '/api/tables', { token: tokens.staff });
  const settled = tables.body.tables.find((t) => t.id === table.id);
  assert.equal(settled.status, 'free', 'table must be free after payment');
  assert.equal(settled.current_order_id, null);
});

test('a table can be marked reserved', async () => {
  const table = state.tables.find((t) => t.label === 'T2');
  const res = await call('POST', `/api/tables/${table.id}/status`, {
    token: tokens.staff,
    body: { status: 'reserved' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.table.status, 'reserved');
});

test('owner/manager can rename a table and change its zone; staff cannot', async () => {
  const table = state.tables.find((t) => t.label === 'T3');
  const denied = await call('PATCH', `/api/tables/${table.id}`, {
    token: tokens.staff,
    body: { zone: 'Garden View' },
  });
  assert.equal(denied.status, 403);

  const ok = await call('PATCH', `/api/tables/${table.id}`, {
    token: tokens.manager,
    body: { label: 'T3', zone: 'Garden View', capacity: 6 },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.table.zone, 'Garden View');
  assert.equal(ok.body.table.capacity, 6);

  const renamed = await call('PATCH', `/api/tables/${table.id}`, {
    token: tokens.owner,
    body: { label: 'T3 Corner', zone: 'Garden View' },
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.table.label, 'T3 Corner');
});

test('stock entry is counted in 180 ml bottles and managers can restock', async () => {
  const before = bottlesOf(state.liquor.id);
  const res = await call('POST', `/api/products/${state.liquor.id}/stock`, {
    token: tokens.manager,
    body: { change_qty: 12, movement: 'purchase', note: '12 sealed bottles received' },
  });
  assert.equal(res.status, 200, res.text);
  const expectedBottles = before + 12;
  assert.equal(res.body.product.stock_bottles, expectedBottles);
  assert.equal(res.body.product.sealed_bottles, Math.floor(expectedBottles));
  assert.ok(
    Math.abs(res.body.product.loose_ml - (expectedBottles - Math.floor(expectedBottles)) * 180) < 0.01,
  );
  assert.ok(Math.abs(res.body.product.stock_qty - expectedBottles * 180) < 0.01);
});

test('staff cannot create products or restock', async () => {
  const create = await call('POST', '/api/products', {
    token: tokens.staff,
    body: { name: 'Blocked Product', unit_type: 'unit', stock_qty: 1, price: 10 },
  });
  assert.equal(create.status, 403);
  const stock = await call('POST', `/api/products/${state.liquor.id}/stock`, {
    token: tokens.staff,
    body: { change_qty: 1 },
  });
  assert.equal(stock.status, 403);
});

test('manager can add a new liquor product priced per serve size', async () => {
  const res = await call('POST', '/api/products', {
    token: tokens.manager,
    body: {
      name: 'Test Single Malt',
      category_id: state.liquor.category_id,
      unit_type: 'ml',
      stock_bottles: 24,
      peg_price: 120,
      cost_price: 900,
      low_stock_qty: 3,
    },
  });
  assert.equal(res.status, 201, res.text);
  const product = res.body.product;
  assert.equal(product.stock_bottles, 24);
  assert.equal(product.sealed_bottles, 24);
  assert.equal(product.variants.length, 6);
  assert.equal(product.variants[0].price, 120);
  assert.equal(product.variants[2].price, 360);
  assert.equal(product.variants[5].price, 720);
  state.custom = product;
});

test('voiding a bill returns the bottle fraction to stock', async () => {
  const pour90 = state.liquor.variants.find((v) => v.ml === 90);
  const before = bottlesOf(state.liquor.id);
  const created = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: pour90.id, qty: 1 }],
      payment_mode: 'cash',
      cash_amount: 210,
      client_uuid: 'test-void-1',
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.ok(bottlesOf(state.liquor.id) < before);

  const denied = await call('POST', `/api/bills/${created.body.bill.id}/void`, {
    token: tokens.staff,
    body: { reason: 'nope' },
  });
  assert.equal(denied.status, 403, 'only a manager or owner may void a bill');

  const res = await call('POST', `/api/bills/${created.body.bill.id}/void`, {
    token: tokens.manager,
    body: { reason: 'Wrong serve size' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.bill.status, 'void');
  assert.equal(bottlesOf(state.liquor.id), before, 'voided sale must return the 90 ml (0.5 bottle)');
});

test('sales reports aggregate paid bills by payment mode', async () => {
  const res = await call('GET', '/api/reports/sales', { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.totals.bills >= 3);
  assert.ok(res.body.totals.revenue > 0);
  assert.ok(res.body.totals.cash > 0);
  assert.ok(Array.isArray(res.body.by_mode) && res.body.by_mode.length >= 1);
});

test('stock ledger records bottle movements', async () => {
  const res = await call('GET', `/api/stock/ledger?product_id=${state.liquor.id}`, { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.ledger.length >= 3);
  const movements = new Set(res.body.ledger.map((l) => l.movement));
  assert.ok(movements.has('sale'));
  assert.ok(movements.has('purchase') || movements.has('opening'));
});

test('offline sync state and push replay bills idempotently', async () => {
  const pull = await call('GET', '/api/sync/state', { token: tokens.staff });
  assert.equal(pull.status, 200);
  assert.equal(pull.body.tables.length, 20);
  assert.ok(pull.body.products.length > 0);

  const pour30 = state.liquor.variants.find((v) => v.ml === 30);
  const payload = {
    device_id: 'test-device',
    bills: [
      {
        client_uuid: 'offline-bill-1',
        items: [{ product_id: state.liquor.id, variant_id: pour30.id, qty: 1 }],
        payment_mode: 'cash',
        cash_amount: 70,
      },
    ],
  };
  const push = await call('POST', '/api/sync/push', { token: tokens.staff, body: payload });
  assert.equal(push.status, 200, push.text);
  assert.equal(push.body.results[0].status, 'synced');

  const again = await call('POST', '/api/sync/push', { token: tokens.staff, body: payload });
  assert.equal(again.status, 200);
  assert.equal(again.body.results[0].status, 'duplicate');
});

test('owner check-in occupies a room with guest details; manager and staff cannot', async () => {
  const room = state.rooms.find((r) => r.room_no === '101');
  const body = {
    guest_name: 'Ravi Kumar',
    guest_phone: '9876500001',
    guests: 2,
    rate_per_night: 1500,
    expected_check_out_at: new Date(Date.now() + 2 * 86400000).toISOString(),
  };

  const managerDenied = await call('POST', `/api/rooms/${room.id}/checkin`, { token: tokens.manager, body });
  assert.equal(managerDenied.status, 403, 'manager may not check in guests');
  const staffDenied = await call('POST', `/api/rooms/${room.id}/checkin`, { token: tokens.staff, body });
  assert.equal(staffDenied.status, 403, 'staff may not check in guests');

  const res = await call('POST', `/api/rooms/${room.id}/checkin`, { token: tokens.owner, body });
  assert.equal(res.status, 201, res.text);

  const rooms = await call('GET', '/api/rooms', { token: tokens.staff });
  const occupied = rooms.body.rooms.find((r) => r.id === room.id);
  assert.equal(occupied.status, 'occupied');
  assert.equal(occupied.guest_name, 'Ravi Kumar');
  assert.equal(occupied.guest_phone, '9876500001');
  assert.ok(occupied.stay_id);
  assert.equal(rooms.body.summary.occupied, 1);
  assert.equal(rooms.body.summary.available, 8);
  state.room101 = room;
});

test('owner check-out frees the room and records room charges', async () => {
  const res = await call('POST', `/api/rooms/${state.room101.id}/checkout`, {
    token: tokens.owner,
    body: { payment_mode: 'cash', amount_paid: 3000, extra_charges: 0 },
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.bill, 'check-out must return a bill');
  assert.ok(res.body.bill.nights >= 1);
  assert.equal(res.body.bill.room_charges, res.body.bill.nights * 1500);
  assert.equal(res.body.bill.total, res.body.bill.room_charges);

  const rooms = await call('GET', '/api/rooms', { token: tokens.staff });
  const room = rooms.body.rooms.find((r) => r.id === state.room101.id);
  assert.equal(room.status, 'available');
  assert.equal(room.guest_name, null);
  assert.equal(rooms.body.summary.available, 9);
});

test('room occupancy history keeps the past stay', async () => {
  const res = await call('GET', '/api/rooms/history', { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  const stay = res.body.history.find((h) => h.guest_name === 'Ravi Kumar');
  assert.ok(stay, 'expected the checked-out stay in history');
  assert.equal(stay.room_no, '101');
  assert.equal(stay.status, 'checked_out');
  assert.ok(stay.check_in_at);
  assert.ok(stay.check_out_at);
});

test('owner can release an occupied room; manager cannot', async () => {
  const room = state.rooms.find((r) => r.room_no === '102');
  const checkIn = await call('POST', `/api/rooms/${room.id}/checkin`, {
    token: tokens.owner,
    body: { guest_name: 'Walk In', guests: 1, rate_per_night: 1500 },
  });
  assert.equal(checkIn.status, 201, checkIn.text);

  const denied = await call('POST', `/api/rooms/${room.id}/release`, {
    token: tokens.manager,
    body: { reason: 'test' },
  });
  assert.equal(denied.status, 403);

  const res = await call('POST', `/api/rooms/${room.id}/release`, {
    token: tokens.owner,
    body: { reason: 'Guest left early' },
  });
  assert.equal(res.status, 200, res.text);

  const rooms = await call('GET', '/api/rooms', { token: tokens.owner });
  assert.equal(rooms.body.rooms.find((r) => r.id === room.id).status, 'available');
});

test('manager can edit room number/name but not tariffs', async () => {
  const room = state.rooms.find((r) => r.room_no === '103');
  const ok = await call('PATCH', `/api/rooms/${room.id}`, {
    token: tokens.manager,
    body: { name: 'Deluxe 103' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.room.name, 'Deluxe 103');

  const denied = await call('PATCH', `/api/rooms/${room.id}`, {
    token: tokens.manager,
    body: { rate_per_night: 999 },
  });
  assert.equal(denied.status, 403, 'only the owner may change room tariffs');
});

test('dashboard keeps restaurant, lodging, billing, inventory and reports separate', async () => {
  const res = await call('GET', '/api/dashboard', { token: tokens.owner });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.restaurant.tables_total, 20);
  assert.equal(res.body.lodging.total, 9);
  assert.ok(res.body.restaurant.revenue > 0);
  assert.ok(res.body.billing.revenue > 0);
  assert.ok(res.body.inventory.total_bottles > 0);
  assert.ok(res.body.reports.week_bills >= 1);
  // Restaurant occupancy and room occupancy stay in separate sections.
  assert.equal(typeof res.body.restaurant.occupied, 'number');
  assert.equal(typeof res.body.lodging.occupied, 'number');
  assert.ok(res.body.lodging.available + res.body.lodging.occupied + res.body.lodging.maintenance <= 9);
});

test('settings and audit log are writable by managers', async () => {
  const put = await call('PUT', '/api/admin/settings', {
    token: tokens.manager,
    body: { hotel_name: 'Hotel Sagarika' },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.settings.hotel_name, 'Hotel Sagarika');

  const audit = await call('GET', '/api/admin/audit', { token: tokens.manager });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.audit.length > 0);
  assert.ok(audit.body.audit.some((a) => a.action === 'bill.create'));
  assert.ok(audit.body.audit.some((a) => a.action === 'room.checkin'));
});

test('unknown API routes return a JSON 404', async () => {
  const res = await call('GET', '/api/nope', { token: tokens.staff });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Unknown API route/);
});

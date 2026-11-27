import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database per run - must be set before the app (and db.js) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barflow-settings-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'test-secret-settings';

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
  return { status: res.status, body: json, text, headers: res.headers };
}

const login = async (username, password) => {
  const res = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, `login failed for ${username}: ${res.text}`);
  return res.body.token;
};

const ownerToken = await login('owner', 'owner123');
const managerToken = await login('manager', 'manager123');

const liquor = db
  .prepare("SELECT id, name, stock_bottles FROM products WHERE unit_type = 'ml' ORDER BY id LIMIT 1")
  .get();
// Seeded products already carry opening stock; all checks are relative to it.
const openingStock = liquor.stock_bottles;

/* ---------------------------------------------------------------- settings */

test('admin settings catalogue lists the three business roles and permissions', async () => {
  const res = await call('GET', '/api/settings', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.roles.map((r) => r.label), ['Admin', 'Manager', 'Billing Staff']);
  const keys = res.body.permissions.map((p) => p.key);
  for (const key of ['stock_add', 'stock_edit', 'reports_view', 'products_manage', 'settings_access']) {
    assert.ok(keys.includes(key), `missing permission ${key}`);
  }
  assert.ok(res.body.users.length >= 3);
});

test('manager cannot open settings or user management', async () => {
  const res = await call('GET', '/api/settings', { token: managerToken });
  assert.equal(res.status, 403);
  const create = await call('POST', '/api/settings/users', {
    token: managerToken,
    body: { name: 'Sneaky', username: 'sneaky', password: 'secret123', role: 'owner' },
  });
  assert.equal(create.status, 403);
});

/* ------------------------------------------------- billing staff permissions */

let staffToken;
let staffId;

test('admin creates a Billing Staff login that can sign in', async () => {
  const res = await call('POST', '/api/settings/users', {
    token: ownerToken,
    body: { name: 'Test Billing', username: 'testbilling', password: 'secret123', role: 'staff', permissions: [] },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.user.role_label, 'Billing Staff');
  assert.deepEqual(res.body.user.permissions, []);
  staffId = res.body.user.id;
  staffToken = await login('testbilling', 'secret123');
});

test('billing staff is blocked from stock, reports and settings', async () => {
  const stock = await call('POST', `/api/products/${liquor.id}/stock`, {
    token: staffToken,
    body: { change_qty: 1, movement: 'purchase' },
  });
  assert.equal(stock.status, 403);
  const report = await call('GET', '/api/reports/report/daily', { token: staffToken });
  assert.equal(report.status, 403);
  const settings = await call('GET', '/api/settings', { token: staffToken });
  assert.equal(settings.status, 403);
});

test('admin can grant stock_add without granting reports', async () => {
  const res = await call('PATCH', `/api/settings/users/${staffId}`, {
    token: ownerToken,
    body: { permissions: ['stock_add'] },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.user.permissions, ['stock_add']);

  staffToken = await login('testbilling', 'secret123');
  const report = await call('GET', '/api/reports/report/daily', { token: staffToken });
  assert.equal(report.status, 403, 'reports must still be denied');
});

/* -------------------------------------------------- permanent stock saving */

test('stock entry persists in the database with a unique transaction id', async () => {
  const res = await call('POST', `/api/products/${liquor.id}/stock`, {
    token: staffToken,
    body: { change_qty: 50, movement: 'purchase', note: 'Fifty bottles delivered' },
  });
  assert.equal(res.status, 200, res.text);

  const row = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(liquor.id);
  assert.equal(row.stock_bottles, openingStock + 50);

  const ledger = db
    .prepare("SELECT * FROM stock_ledger WHERE product_id = ? AND movement = 'purchase' ORDER BY id DESC LIMIT 1")
    .get(liquor.id);
  assert.equal(ledger.change_qty, 50);
  assert.equal(ledger.balance_qty, openingStock + 50);
  assert.ok(ledger.txn_id && ledger.txn_id.length >= 8, 'stock entry needs a unique transaction id');
  assert.ok(ledger.created_by, 'stock entry must record the user');
  assert.ok(ledger.created_at, 'stock entry must record the date and time');
});

test('stock survives logout, a different login and a fresh request', async () => {
  await call('POST', '/api/auth/logout', { token: staffToken });
  const freshOwner = await login('owner', 'owner123');
  const res = await call('GET', '/api/products?include_inactive=0', { token: freshOwner });
  assert.equal(res.status, 200);
  const product = res.body.products.find((p) => p.id === liquor.id);
  assert.equal(product.stock_bottles, openingStock + 50, 'stock must come from the database, not the session');

  // Simulate an application restart: a brand new token and connection state.
  const again = await call('GET', `/api/products?include_inactive=0`, { token: await login('owner', 'owner123') });
  assert.equal(again.body.products.find((p) => p.id === liquor.id).stock_bottles, openingStock + 50);
});

test('a second stock purchase accumulates and stays unique per entry', async () => {
  const res = await call('POST', `/api/products/${liquor.id}/stock`, {
    token: ownerToken,
    body: { change_qty: 12, movement: 'purchase', note: 'Top-up' },
  });
  assert.equal(res.status, 200, res.text);
  const row = db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(liquor.id);
  assert.equal(row.stock_bottles, openingStock + 62);

  const ids = db
    .prepare("SELECT txn_id FROM stock_ledger WHERE product_id = ? AND movement = 'purchase'")
    .all(liquor.id)
    .map((r) => r.txn_id);
  assert.equal(new Set(ids).size, ids.length, 'transaction ids must be unique');
});

/* ------------------------------------------------------ day / month reports */

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

test('day-wise stock report shows opening, received, sold and closing stock', async () => {
  const res = await call('GET', `/api/reports/report/stock_daily?from=${today}&to=${today}`, { token: ownerToken });
  assert.equal(res.status, 200, res.text);
  const report = res.body.report;
  assert.equal(report.title, 'Day-wise Stock Report');
  assert.ok(Array.isArray(report.rows) && report.rows.length > 0);
  const headers = report.columns.map((c) => (Array.isArray(c) ? c[0] : c)).join(' ').toLowerCase();
  for (const word of ['opening', 'received', 'sold', 'closing']) {
    assert.ok(headers.includes(word), `stock report should show ${word}`);
  }
  assert.ok(report.totals && typeof report.totals === 'object');
});

test('monthly stock and monthly sales reports are admin-only and complete', async () => {
  const monthly = await call('GET', `/api/reports/report/monthly?from=${monthStart}&to=${today}`, { token: ownerToken });
  assert.equal(monthly.status, 200, monthly.text);
  assert.ok(monthly.body.report.rows.length > 0);

  const stockMonthly = await call('GET', `/api/reports/report/stock_monthly?from=${monthStart}&to=${today}`, {
    token: ownerToken,
  });
  assert.equal(stockMonthly.status, 200, stockMonthly.text);
  assert.ok(stockMonthly.body.report.columns.length > 3);

  const denied = await call('GET', `/api/reports/report/stock_monthly?from=${monthStart}&to=${today}`, {
    token: managerToken,
  });
  assert.equal(denied.status, 403, 'monthly stock is Owner only');
});

/* ----------------------------------------------------------- excel exports */

const isXlsx = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

test('Excel export returns a real .xlsx file for daily and monthly stock reports', async () => {
  for (const name of ['stock_daily', 'stock_monthly', 'monthly', 'daily']) {
    const res = await fetch(
      `${base}/api/reports/export?report=${name}&format=xlsx&from=${monthStart}&to=${today}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(res.status, 200, `${name} export failed`);
    assert.match(res.headers.get('content-type') || '', /spreadsheetml\.sheet/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(isXlsx(buf), `${name} must be a ZIP-based .xlsx, not CSV text`);
    assert.ok(buf.length > 500, `${name} workbook looks empty`);
  }
});

/* --------------------------------------------------------------- passwords */

test('admin can reset another user password and the new password works', async () => {
  const res = await call('POST', `/api/settings/users/${staffId}/password`, {
    token: ownerToken,
    body: { password: 'brandnew123' },
  });
  assert.equal(res.status, 200, res.text);
  const token = await login('testbilling', 'brandnew123');
  assert.ok(token);
  const old = await call('POST', '/api/auth/login', {
    body: { username: 'testbilling', password: 'secret123' },
  });
  assert.equal(old.status, 401, 'the previous password must stop working');
});

test('deactivated accounts cannot sign in and do not lose their records', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM stock_ledger').get().c;
  const res = await call('PATCH', `/api/settings/users/${staffId}`, {
    token: ownerToken,
    body: { is_active: false },
  });
  assert.equal(res.status, 200, res.text);
  const denied = await call('POST', '/api/auth/login', {
    body: { username: 'testbilling', password: 'brandnew123' },
  });
  assert.equal(denied.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stock_ledger').get().c, before, 'no stock history may be lost');
});

test('database storage endpoint reports the persistent file and record counts', async () => {
  const res = await call('GET', '/api/settings/storage', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.database_path.endsWith('.db'));
  assert.ok(res.body.counts.stock_entries >= 2);
  assert.ok(res.body.database_size > 0);
});

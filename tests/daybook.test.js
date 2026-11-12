import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database per run - must be set before the app (and db.js) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barflow-day-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'day.db');
process.env.JWT_SECRET = 'test-secret-for-barflow-day';

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

const D = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const YESTERDAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() - 24 * 3600 * 1000));

const tokens = {};
const state = {};

// Seed data ships sample expenses dated today. Clear today's day-book rows so the
// cash scenario below matches the specification numbers exactly.
db.prepare('DELETE FROM expenses').run();
db.prepare('DELETE FROM refunds').run();
db.prepare('DELETE FROM cash_movements').run();

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

async function rawGet(urlPath, token) {
  const res = await fetch(base + urlPath, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf };
}

const bottlesOf = (id) => db.prepare('SELECT stock_bottles FROM products WHERE id = ?').get(id)?.stock_bottles ?? null;

/** Insert a paid bill fixture so the cash arithmetic can be checked exactly. */
let billSeq = 0;
function insertPaidBill({ total, cash = 0, upi = 0, mode = 'cash', date = D, uuid }) {
  billSeq += 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bills (bill_no, bill_date, subtotal, total, payment_mode, cash_amount, upi_amount,
                        status, cashier_name, client_uuid, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', 'Fixture Cashier', ?, ?, ?)`,
  ).run(`FIX-${billSeq}`, date, total, total, mode, cash, upi, uuid || `fixture-${billSeq}`, now, now);
}

function insertExpense(amount, category = 'Supplies') {
  db.prepare(
    `INSERT INTO expenses (expense_date, category, amount, note, spent_by, created_by, client_uuid, created_at)
     VALUES (?, ?, ?, ?, 'Fixture', NULL, ?, ?)`,
  ).run(D, category, amount, 'Fixture expense', `exp-${Math.random().toString(36).slice(2)}`, new Date().toISOString());
}

/* ------------------------------------------------------------------ setup */

test('owner, manager and staff log in', async () => {
  for (const [role, username, password] of [
    ['owner', 'owner', 'owner123'],
    ['manager', 'manager', 'manager123'],
    ['staff', 'staff', 'staff123'],
  ]) {
    const res = await call('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(res.status, 200, `${role} login failed: ${res.text}`);
    tokens[role] = res.body.token;
  }
});

test('day audit tables exist and a fresh day is Not Opened', async () => {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  for (const required of [
    'day_sessions',
    'day_stock_openings',
    'day_stock_counts',
    'day_stock_adjustments',
    'cash_movements',
    'day_reopens',
  ]) {
    assert.ok(names.has(required), `expected table ${required}`);
  }
  const res = await call('GET', `/api/day/status?date=${D}`, { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.status, 'not_opened');
  assert.equal(res.body.label, 'Not Opened');
});

test('stock cannot be counted before the day is opened', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  assert.equal(stock.status, 200, stock.text);
  const first = stock.body.products[0];
  assert.ok(first, 'expected seeded products');
  const res = await call('POST', '/api/day/stock/count', {
    token: tokens.manager,
    body: { date: D, product_id: first.product_id, actual_bottles: first.expected },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Open the business day/i);
});

/* ------------------------------------------------- scenario 1: opening cash */

test('opening cash of Rs 5,000 opens the day', async () => {
  const staffTry = await call('POST', '/api/day/opening', {
    token: tokens.staff,
    body: { date: D, opening_cash: 5000 },
  });
  assert.equal(staffTry.status, 403, 'staff must not open the day');

  const res = await call('POST', '/api/day/opening', {
    token: tokens.manager,
    body: { date: D, opening_cash: 5000, opening_upi: 1000, remarks: 'Morning shift' },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.session.opening_cash, 5000);
  assert.equal(res.body.status.status, 'open');
  assert.equal(res.body.status.label, 'Day Open');
  assert.equal(res.body.session.opened_by_name, 'Suresh Kumar');
  assert.ok(res.body.session.opened_at, 'opening time recorded');
  // Opening stock carried forward for every active product.
  assert.ok(res.body.opening.length > 0, 'opening stock snapshot captured');
  state.openingSnapshot = res.body.opening;
});

test('opening cash is mandatory', async () => {
  const res = await call('POST', '/api/day/opening', {
    token: tokens.manager,
    body: { date: YESTERDAY, opening_cash: '' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /opening cash/i);
});

test('a second opening entry is refused; only Owner can correct it', async () => {
  const dup = await call('POST', '/api/day/opening', {
    token: tokens.manager,
    body: { date: D, opening_cash: 6000 },
  });
  assert.equal(dup.status, 409, dup.text);

  const managerCorrect = await call('POST', '/api/day/opening/correct', {
    token: tokens.manager,
    body: { date: D, pin: '4321', opening_cash: 5500 },
  });
  assert.equal(managerCorrect.status, 403);

  const wrongPin = await call('POST', '/api/day/opening/correct', {
    token: tokens.owner,
    body: { date: D, pin: '0000', opening_cash: 5500 },
  });
  assert.equal(wrongPin.status, 403);

  const ok = await call('POST', '/api/day/opening/correct', {
    token: tokens.owner,
    body: { date: D, pin: '4321', opening_cash: 5000, remarks: 'Corrected to counted float' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.session.opening_cash, 5000);

  const audit = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('day_open', 'day_opening_correct')")
    .get();
  assert.ok(audit.n >= 1, 'opening correction is audited');
  const correction = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'day_opening_correct'")
    .get();
  assert.ok(correction.n >= 1, 'the correction itself is audited');
});

/* ------------------------------------ scenario 2-6: cash maths and shortage */

test('expected closing cash = 5000 opening + 8000 cash - 500 expense = 12500', async () => {
  insertPaidBill({ total: 8000, cash: 8000, mode: 'cash' });
  insertPaidBill({ total: 4000, upi: 4000, mode: 'upi' });
  insertExpense(500);

  const res = await call('GET', `/api/day/summary?date=${D}`, { token: tokens.manager });
  assert.equal(res.status, 200, res.text);
  const cash = res.body.cash;
  assert.equal(cash.opening_cash, 5000);
  assert.equal(cash.cash_sales, 8000);
  assert.equal(cash.upi_sales, 4000, 'UPI tracked separately');
  assert.equal(cash.cash_expenses, 500);
  assert.equal(cash.expected_cash, 12500);
  assert.equal(cash.total_sales, 12000);
  assert.equal(cash.bill_count, 2);
  // UPI never enters physical cash.
  assert.equal(cash.expected_cash, cash.opening_cash + cash.cash_sales - cash.cash_expenses);
});

test('a paid 90 ml liquor sale deducts exactly half a bottle', async () => {
  const products = await call('GET', '/api/products', { token: tokens.staff });
  assert.equal(products.status, 200, products.text);
  const liquor = products.body.products.find(
    (p) => p.unit_type === 'ml' && (p.variants || []).some((v) => v.ml === 90) && p.stock_bottles > 2,
  );
  assert.ok(liquor, 'expected a liquor product with a 90 ml pour');
  const pour90 = liquor.variants.find((v) => v.ml === 90);
  state.liquor = liquor;
  state.pour90 = pour90;

  const before = bottlesOf(liquor.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: liquor.id, variant_id: pour90.id, qty: 1 }],
      payment_mode: 'upi',
      upi_amount: pour90.price,
      upi_ref: 'UPI-TEST-90',
      client_uuid: 'day-90ml-upi',
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.bill.status, 'paid');
  const after = bottlesOf(liquor.id);
  assert.ok(Math.abs(before - after - 0.5) < 1e-9, `expected 0.5 bottle deducted, got ${before - after}`);
  state.liquorBill = res.body.bill;
});

test('an unpaid / failed bill does not deduct stock', async () => {
  const before = bottlesOf(state.liquor.id);
  const res = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: state.pour90.id, qty: 1 }],
      payment_mode: 'cash',
      cash_amount: 0,
      client_uuid: 'day-unpaid-cash',
    },
  });
  assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  assert.equal(bottlesOf(state.liquor.id), before, 'stock unchanged for an unpaid bill');
});

test('replaying an offline sale does not deduct stock or count sales twice', async () => {
  const before = bottlesOf(state.liquor.id);
  const upiBefore = (await call('GET', `/api/day/summary?date=${D}`, { token: tokens.manager })).body.cash.upi_sales;
  const replay = await call('POST', '/api/bills', {
    token: tokens.staff,
    body: {
      items: [{ product_id: state.liquor.id, variant_id: state.pour90.id, qty: 1 }],
      payment_mode: 'upi',
      upi_amount: state.pour90.price,
      upi_ref: 'UPI-TEST-90',
      client_uuid: 'day-90ml-upi',
      synced_from_offline: true,
    },
  });
  assert.ok([200, 201].includes(replay.status), replay.text);
  assert.equal(bottlesOf(state.liquor.id), before, 'stock not deducted twice');
  const upiAfter = (await call('GET', `/api/day/summary?date=${D}`, { token: tokens.manager })).body.cash.upi_sales;
  assert.equal(upiAfter, upiBefore, 'UPI total not double counted');

  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  const row = stock.body.products.find((p) => p.product_id === state.liquor.id);
  assert.ok(Math.abs(row.sales - 0.5) < 1e-9, `reconciliation should show 0.5 bottle sold, got ${row.sales}`);
  assert.equal(row.sales_ml, 90);
  assert.equal(row.bottle_size_ml, 180);
  assert.equal(row.expected_ml, Math.round(row.expected * 180 * 100) / 100);
});

test('a cash movement is recorded once per client_uuid', async () => {
  const body = { date: D, kind: 'out', amount: 200, note: 'Ice', client_uuid: 'day-cash-move-1' };
  const first = await call('POST', '/api/day/cash', { token: tokens.manager, body });
  assert.equal(first.status, 201, first.text);
  const second = await call('POST', '/api/day/cash', { token: tokens.manager, body });
  assert.ok([200, 201].includes(second.status), second.text);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM cash_movements WHERE client_uuid = ?').get('day-cash-move-1');
  assert.equal(rows.n, 1, 'duplicate cash movement ignored');

  const cash = (await call('GET', `/api/day/cash?date=${D}`, { token: tokens.manager })).body.cash;
  assert.equal(cash.cash_paid_out, 200);
  assert.equal(cash.expected_cash, 5000 + 8000 - 500 - 200);
});

test('staff cannot record cash or read the cash summary', async () => {
  const staffCash = await call('POST', '/api/day/cash', {
    token: tokens.staff,
    body: { date: D, kind: 'out', amount: 50, note: 'x' },
  });
  assert.equal(staffCash.status, 403);
  const staffSummary = await call('GET', `/api/day/summary?date=${D}`, { token: tokens.staff });
  assert.equal(staffSummary.status, 403);
});

test('cash received from other sources is Owner-only and configurable', async () => {
  const managerTry = await call('POST', '/api/day/cash', {
    token: tokens.manager,
    body: { date: D, kind: 'in', amount: 300, note: 'Owner float' },
  });
  assert.equal(managerTry.status, 403);

  const disabled = await call('POST', '/api/day/cash', {
    token: tokens.owner,
    body: { date: D, kind: 'in', amount: 300, note: 'Owner float' },
  });
  assert.equal(disabled.status, 403, disabled.text);

  const enable = await call('PUT', '/api/day/settings', {
    token: tokens.owner,
    body: { cash_received_enabled: true },
  });
  assert.equal(enable.status, 200, enable.text);

  const ok = await call('POST', '/api/day/cash', {
    token: tokens.owner,
    body: { date: D, kind: 'in', amount: 300, note: 'Owner float', client_uuid: 'day-cash-in-1' },
  });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.cash.cash_received, 300);
  assert.equal(ok.body.cash.expected_cash, 5000 + 8000 - 500 - 200 + 300);

  // Back to the base case for the closing scenario.
  await call('POST', '/api/day/cash', {
    token: tokens.owner,
    body: { date: D, kind: 'out', amount: 300, note: 'Float returned', client_uuid: 'day-cash-out-2' },
  });
  const cash = (await call('GET', `/api/day/cash?date=${D}`, { token: tokens.manager })).body.cash;
  assert.equal(cash.expected_cash, 12500 - 200);
});

/* ------------------------------------------- scenario 3: stock reconciliation */

test('closing is refused until every product is counted', async () => {
  const res = await call('POST', '/api/day/close', {
    token: tokens.manager,
    body: { date: D, actual_cash: 12300, remarks: 'Trying to close early' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /physical stock count/i);
});

test('a stock difference requires a reason and is recorded with the counter', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  const liquor = stock.body.products.find((p) => p.product_id === state.liquor.id);
  const noReason = await call('POST', '/api/day/stock/count', {
    token: tokens.manager,
    body: {
      date: D,
      product_id: liquor.product_id,
      actual_bottles: Math.max(liquor.expected - 1, 0),
      actual_loose_ml: 0,
    },
  });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /reason is required/i);

  const withReason = await call('POST', '/api/day/stock/count', {
    token: tokens.manager,
    body: {
      date: D,
      product_id: liquor.product_id,
      actual_bottles: Math.max(liquor.expected - 1, 0),
      actual_loose_ml: 0,
      reason: 'One bottle broken during handling',
    },
  });
  assert.equal(withReason.status, 200, withReason.text);
  assert.ok(withReason.body.product.difference < 0, 'shortage detected');
  assert.equal(withReason.body.product.counted_by_name, 'Suresh Kumar');
  assert.equal(withReason.body.product.reason, 'One bottle broken during handling');
  state.liquorCounted = true;
});

test('loose millilitres must be less than one bottle', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  const liquor = stock.body.products.find((p) => p.product_id === state.liquor.id);
  const res = await call('POST', '/api/day/stock/count', {
    token: tokens.manager,
    body: { date: D, product_id: liquor.product_id, actual_bottles: 1, actual_loose_ml: 180, reason: 'Bad count' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /less than one bottle/i);
});

test('every remaining product is counted so the day can close', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  for (const product of stock.body.products) {
    if (product.counted) continue;
    const res = await call('POST', '/api/day/stock/count', {
      token: tokens.manager,
      body: {
        date: D,
        product_id: product.product_id,
        actual_bottles: product.expected,
        actual_loose_ml: 0,
      },
    });
    assert.equal(res.status, 200, `${product.name}: ${res.text}`);
  }
  const after = await call('GET', `/api/day/status?date=${D}`, { token: tokens.manager });
  assert.equal(after.body.stock.counted, after.body.stock.products);
  assert.equal(after.body.status, 'closing_pending');
  assert.equal(after.body.label, 'Closing Pending');
});

/* ----------------------------- scenario 5-6, 10: closing, lock and shortage */

test('actual cash of 12,200 against 12,300 expected shows a Rs 100 shortage', async () => {
  const noRemarks = await call('POST', '/api/day/close', {
    token: tokens.manager,
    body: { date: D, actual_cash: 12200 },
  });
  assert.equal(noRemarks.status, 400);
  assert.match(noRemarks.body.error, /remarks are required/i);

  const res = await call('POST', '/api/day/close', {
    token: tokens.manager,
    body: { date: D, actual_cash: 12200, remarks: 'Rs 100 short, pending vendor payment' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.status, 'closed');
  assert.equal(res.body.label, 'Closed');
  assert.equal(res.body.session.expected_cash, 12300);
  assert.equal(res.body.session.actual_cash, 12200);
  assert.equal(res.body.session.cash_difference, -100);
  assert.equal(res.body.session.closed_by_name, 'Suresh Kumar');
  assert.ok(res.body.session.closed_at, 'closing time recorded');
  assert.equal(res.body.session.locked, 1);
  assert.equal(res.body.stock.discrepancies, 1);

  const cash = (await call('GET', `/api/day/summary?date=${D}`, { token: tokens.manager })).body.cash;
  assert.equal(cash.shortage, 100);
  assert.equal(cash.excess, 0);
  assert.equal(cash.expected_cash, 12300, 'closed day keeps its frozen expected cash');
});

test('a closed day cannot be edited by manager or staff', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  assert.equal(stock.body.closed, true);
  const product = stock.body.products[0];

  const count = await call('POST', '/api/day/stock/count', {
    token: tokens.manager,
    body: { date: D, product_id: product.product_id, actual_bottles: 1 },
  });
  assert.equal(count.status, 409, count.text);

  const cash = await call('POST', '/api/day/cash', {
    token: tokens.manager,
    body: { date: D, kind: 'out', amount: 100, note: 'late edit' },
  });
  assert.equal(cash.status, 409, cash.text);

  const adjust = await call('POST', '/api/day/stock/adjustment', {
    token: tokens.owner,
    body: { date: D, product_id: product.product_id, direction: 'in', qty: 1, reason: 'late adjustment' },
  });
  assert.equal(adjust.status, 409, 'even the Owner must reopen before adjusting');

  const closeAgain = await call('POST', '/api/day/close', {
    token: tokens.manager,
    body: { date: D, actual_cash: 12500, remarks: 'second close attempt' },
  });
  assert.equal(closeAgain.status, 409, closeAgain.text);
});

/* --------------------------------------- scenario 11: Owner PIN to reopen */

test('only the Owner can reopen a closed day, with PIN and a reason', async () => {
  const managerTry = await call('POST', '/api/day/reopen', {
    token: tokens.manager,
    body: { date: D, pin: '4321', reason: 'manager wants to edit' },
  });
  assert.equal(managerTry.status, 403);

  const wrongPin = await call('POST', '/api/day/reopen', {
    token: tokens.owner,
    body: { date: D, pin: '9999', reason: 'wrong pin attempt' },
  });
  assert.equal(wrongPin.status, 403);

  const noReason = await call('POST', '/api/day/reopen', {
    token: tokens.owner,
    body: { date: D, pin: '4321', reason: 'no' },
  });
  assert.equal(noReason.status, 400);

  const ok = await call('POST', '/api/day/reopen', {
    token: tokens.owner,
    body: { date: D, pin: '4321', reason: 'Missed UPI entry at 21:40' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(['open', 'closing_pending'].includes(ok.body.status), ok.body.status);
  assert.equal(ok.body.session.reopen_count, 1);

  const reopenRow = db.prepare('SELECT * FROM day_reopens WHERE business_date = ?').get(D);
  assert.ok(reopenRow, 'reopen recorded');
  assert.equal(reopenRow.reason, 'Missed UPI entry at 21:40');
  assert.equal(reopenRow.reopened_by_name, 'Ramesh Sagarika');

  const auditRow = db.prepare("SELECT * FROM audit_logs WHERE action = 'day_reopen' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditRow, 'reopen audited');
});

/* ------------------------------------------ scenario 12: reports and exports */

test('day reports export as PDF and Excel for the Owner', async () => {
  const names = [
    'daily_cash',
    'upi',
    'sales',
    'expenses',
    'stock',
    'liquor',
    'difference',
    'staff',
    'monthly_cash',
    'monthly_stock',
  ];
  for (const name of names) {
    const pdf = await rawGet(`/api/day/reports/${name}?date=${D}&from=${D}&to=${D}&format=pdf`, tokens.owner);
    assert.equal(pdf.status, 200, `${name} pdf: ${pdf.status}`);
    assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF', `${name} is a PDF`);

    const xlsx = await rawGet(`/api/day/reports/${name}?date=${D}&from=${D}&to=${D}&format=xlsx`, tokens.owner);
    assert.equal(xlsx.status, 200, `${name} xlsx: ${xlsx.status}`);
    assert.equal(xlsx.buf.subarray(0, 2).toString(), 'PK', `${name} is an xlsx zip`);
  }

  const html = await rawGet(`/api/day/reports/daily_cash?date=${D}&from=${D}&to=${D}&format=print`, tokens.owner);
  assert.equal(html.status, 200);
  assert.match(html.buf.toString(), /Hotel Sagarika/i);
});

test('manager can read today but not historical closing reports', async () => {
  const today = await rawGet(`/api/day/reports/daily_cash?date=${D}&from=${D}&to=${D}&format=pdf`, tokens.manager);
  assert.equal(today.status, 200, today.text);

  const history = await call('GET', `/api/day/history?from=${YESTERDAY}&to=${YESTERDAY}`, {
    token: tokens.manager,
  });
  assert.equal(history.status, 403, history.text);

  const staffReports = await call('GET', `/api/day/report-list`, { token: tokens.staff });
  assert.equal(staffReports.status, 403);

  const ownerHistory = await call('GET', `/api/day/history?from=${YESTERDAY}&to=${D}`, { token: tokens.owner });
  assert.equal(ownerHistory.status, 200, ownerHistory.text);
  assert.ok(ownerHistory.body.days.some((d) => d.business_date === D), 'closed day appears in history');
});

test('staff see only the day status, never cash figures', async () => {
  const res = await call('GET', `/api/day/status?date=${D}`, { token: tokens.staff });
  assert.equal(res.status, 200, res.text);
  assert.ok(['open', 'closing_pending'].includes(res.body.status), res.body.status);
  assert.equal(res.body.cash, undefined, 'no cash figures for staff');
  assert.equal(res.body.stock, undefined, 'no stock figures for staff');
});

test('Owner stock adjustment is audited and moves the ledger', async () => {
  const stock = await call('GET', `/api/day/stock?date=${D}`, { token: tokens.manager });
  const product = stock.body.products.find((p) => !p.is_liquor) || stock.body.products[0];
  const before = stock.body.products.find((p) => p.product_id === product.product_id);

  const res = await call('POST', '/api/day/stock/adjustment', {
    token: tokens.owner,
    body: { date: D, product_id: product.product_id, direction: 'in', qty: 2, reason: 'Supplier bonus stock' },
  });
  assert.equal(res.status, 201, res.text);
  const after = res.body.products.find((p) => p.product_id === product.product_id);
  assert.equal(after.adjustments_in, before.adjustments_in + 2);
  assert.equal(after.expected, before.expected + 2);

  const ledger = db
    .prepare("SELECT COUNT(*) AS n FROM stock_ledger WHERE ref_type = 'day_adjustment'")
    .get();
  assert.ok(ledger.n >= 1, 'adjustment written to stock ledger');

  const managerTry = await call('POST', '/api/day/stock/adjustment', {
    token: tokens.manager,
    body: { date: D, product_id: product.product_id, direction: 'in', qty: 1, reason: 'manager try' },
  });
  assert.equal(managerTry.status, 403);
});

test('no GST, tax, discount or card fields exist in the day module', async () => {
  const res = await call('GET', `/api/day/summary?date=${D}`, { token: tokens.owner });
  const flat = JSON.stringify(res.body).toLowerCase();
  for (const banned of ['gst', 'cgst', 'sgst', 'igst', 'tax_percent', 'discount', 'service_charge']) {
    assert.ok(!flat.includes(banned), `day summary must not expose ${banned}`);
  }
});

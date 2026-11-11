import bcrypt from 'bcryptjs';
import { db, setSetting } from './db.js';
import { nowISO, today, money } from './util.js';

const POUR_SIZES = [30, 60, 90, 120, 150, 180];

const CATEGORIES = [
  { name: 'Whisky', color: '#b45309', sort_order: 1 },
  { name: 'Rum', color: '#7c2d12', sort_order: 2 },
  { name: 'Vodka', color: '#0e7490', sort_order: 3 },
  { name: 'Gin', color: '#15803d', sort_order: 4 },
  { name: 'Brandy', color: '#9a3412', sort_order: 5 },
  { name: 'Beer', color: '#a16207', sort_order: 6 },
  { name: 'Wine', color: '#9d174d', sort_order: 7 },
  { name: 'Mixers & Snacks', color: '#4d7c0f', sort_order: 8 },
];

// peg = price of a 30 ml pour in INR. Larger pours scale linearly.
const LIQUOR = [
  { name: 'Blenders Pride Reserve', brand: 'Blenders Pride', cat: 'Whisky', bottle: 750, stockMl: 15000, cost: 640, peg: 70 },
  { name: 'Royal Stag Barrel Select', brand: 'Royal Stag', cat: 'Whisky', bottle: 750, stockMl: 22500, cost: 520, peg: 60 },
  { name: "Officer's Choice", brand: "Officer's Choice", cat: 'Whisky', bottle: 750, stockMl: 30000, cost: 380, peg: 45 },
  { name: 'Johnnie Walker Red Label', brand: 'Johnnie Walker', cat: 'Whisky', bottle: 750, stockMl: 4500, cost: 2100, peg: 180 },
  { name: 'Signature Rare Aged', brand: 'Signature', cat: 'Whisky', bottle: 750, stockMl: 9000, cost: 850, peg: 90 },
  { name: 'Old Monk Legend', brand: 'Old Monk', cat: 'Rum', bottle: 750, stockMl: 18000, cost: 420, peg: 50 },
  { name: 'Bacardi Carta Blanca', brand: 'Bacardi', cat: 'Rum', bottle: 750, stockMl: 9000, cost: 700, peg: 80 },
  { name: 'Absolut Vodka', brand: 'Absolut', cat: 'Vodka', bottle: 750, stockMl: 6000, cost: 1250, peg: 110 },
  { name: 'Magic Moments Grain', brand: 'Magic Moments', cat: 'Vodka', bottle: 750, stockMl: 12000, cost: 480, peg: 55 },
  { name: 'Bombay Sapphire', brand: 'Bombay Sapphire', cat: 'Gin', bottle: 750, stockMl: 4500, cost: 1600, peg: 140 },
  { name: 'Mansion House Brandy', brand: 'Mansion House', cat: 'Brandy', bottle: 750, stockMl: 15000, cost: 460, peg: 50 },
  { name: 'McDowell No.1 Brandy', brand: 'McDowell', cat: 'Brandy', bottle: 750, stockMl: 12000, cost: 520, peg: 60 },
];

const UNIT_PRODUCTS = [
  { name: 'Kingfisher Strong Beer', brand: 'Kingfisher', cat: 'Beer', stock: 120, cost: 130, price: 220, label: 'Bottle 650 ml' },
  { name: 'Tuborg Green Beer', brand: 'Tuborg', cat: 'Beer', stock: 96, cost: 120, price: 200, label: 'Bottle 650 ml' },
  { name: 'Sula Shiraz Wine', brand: 'Sula', cat: 'Wine', stock: 18, cost: 640, price: 1100, label: 'Bottle 750 ml' },
  { name: 'Soda Water', brand: 'Kinley', cat: 'Mixers & Snacks', stock: 200, cost: 12, price: 30, label: 'Bottle 300 ml' },
  { name: 'Cola / Lemonade', brand: 'Coca-Cola', cat: 'Mixers & Snacks', stock: 180, cost: 20, price: 40, label: 'Bottle 300 ml' },
  { name: 'Mineral Water', brand: 'Bisleri', cat: 'Mixers & Snacks', stock: 150, cost: 10, price: 25, label: 'Bottle 1 L' },
  { name: 'Masala Peanuts', brand: 'Kitchen', cat: 'Mixers & Snacks', stock: 60, cost: 35, price: 90, label: 'Plate' },
  { name: 'Chicken 65', brand: 'Kitchen', cat: 'Mixers & Snacks', stock: 40, cost: 120, price: 260, label: 'Plate' },
  { name: 'Veg Manchurian', brand: 'Kitchen', cat: 'Mixers & Snacks', stock: 40, cost: 70, price: 180, label: 'Plate' },
];

const TABLES = [
  ...Array.from({ length: 8 }, (_, i) => ({ label: `T${i + 1}`, zone: 'Main Hall', capacity: 4 })),
  ...Array.from({ length: 6 }, (_, i) => ({ label: `G${i + 1}`, zone: 'Garden', capacity: 6 })),
  ...Array.from({ length: 6 }, (_, i) => ({ label: `L${i + 1}`, zone: 'AC Lounge', capacity: 8 })),
];

function skuFor(name, i) {
  return `SKU${String(i + 1).padStart(4, '0')}-${name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()}`;
}

export function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return false;

  const now = nowISO();
  const todayStr = today();

  const insertUser = db.prepare(
    `INSERT INTO users (name, username, password_hash, role, phone, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const users = [
    { name: 'Ramesh Sagarika', username: 'owner', password: 'owner123', role: 'owner', phone: '9876500001' },
    { name: 'Suresh Kumar', username: 'manager', password: 'manager123', role: 'manager', phone: '9876500002' },
    { name: 'Anil Waiter', username: 'staff', password: 'staff123', role: 'staff', phone: '9876500003' },
  ];
  for (const u of users) {
    insertUser.run(u.name, u.username, bcrypt.hashSync(u.password, 10), u.role, u.phone, now, now);
  }

  const defaults = {
    hotel_name: 'Hotel Sagarika',
    tagline: 'Bar & Restaurant',
    address: 'Main Road, Sagarika Complex, Mangaluru',
    phone: '9876500000',
    gstin: '29ABCDE1234F1Z5',
    upi_id: 'hotelsagarika@upi',
    currency: '₹',
    tax_percent: '5',
    service_charge_percent: '0',
    allow_negative_stock: '1',
    low_stock_alert: '1',
    invoice_footer: 'Thank you for visiting Hotel Sagarika. Drink responsibly.',
  };
  for (const [k, v] of Object.entries(defaults)) setSetting(k, v);

  const insertCat = db.prepare(
    `INSERT INTO categories (name, description, color, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  const catIds = {};
  for (const c of CATEGORIES) {
    const res = insertCat.run(c.name, `${c.name} collection`, c.color, c.sort_order, now, now);
    catIds[c.name] = Number(res.lastInsertRowid);
  }

  const insertProduct = db.prepare(
    `INSERT INTO products (name, category_id, brand, sku, unit_type, bottle_size_ml, stock_qty,
       low_stock_qty, cost_price, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const insertVariant = db.prepare(
    `INSERT INTO product_variants (product_id, label, ml, consume_qty, price, sort_order, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const insertLedger = db.prepare(
    `INSERT INTO stock_ledger (product_id, change_qty, balance_qty, movement, ref_type, note, created_by, created_at)
     VALUES (?, ?, ?, 'opening', 'seed', ?, 1, ?)`,
  );

  let idx = 0;
  for (const p of LIQUOR) {
    const res = insertProduct.run(
      p.name,
      catIds[p.cat],
      p.brand,
      skuFor(p.name, idx++),
      'ml',
      p.bottle,
      p.stockMl,
      1500,
      p.cost,
      now,
      now,
    );
    const productId = Number(res.lastInsertRowid);
    POUR_SIZES.forEach((ml, i) => {
      insertVariant.run(productId, `${ml} ml`, ml, ml, money((p.peg * ml) / 30), i, now);
    });
    insertLedger.run(productId, p.stockMl, p.stockMl, 'Opening stock', now);
  }

  for (const p of UNIT_PRODUCTS) {
    const res = insertProduct.run(
      p.name,
      catIds[p.cat],
      p.brand,
      skuFor(p.name, idx++),
      'unit',
      null,
      p.stock,
      10,
      p.cost,
      now,
      now,
    );
    const productId = Number(res.lastInsertRowid);
    insertVariant.run(productId, p.label, 0, 1, p.price, 0, now);
    insertLedger.run(productId, p.stock, p.stock, 'Opening stock', now);
  }

  const insertTable = db.prepare(
    `INSERT INTO dining_tables (label, zone, capacity, status, sort_order, updated_at)
     VALUES (?, ?, ?, 'free', ?, ?)`,
  );
  TABLES.forEach((t, i) => insertTable.run(t.label, t.zone, t.capacity, i, now));

  const insertSupplier = db.prepare(
    `INSERT INTO suppliers (name, phone, gstin, address, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
  );
  insertSupplier.run('Sagarika Beverages Distributors', '9876511111', '29AABCS1234D1Z2', 'Industrial Area, Mangaluru', now);
  insertSupplier.run('Coastal Wines & Spirits', '9876522222', '29AABCC5678E1Z9', 'Port Road, Mangaluru', now);

  db.prepare(
    `INSERT INTO expenses (expense_date, category, amount, note, spent_by, created_by, created_at)
     VALUES (?, 'Electricity', 2400, 'Monthly current bill', 'Manager', 2, ?)`,
  ).run(todayStr, now);

  return true;
}

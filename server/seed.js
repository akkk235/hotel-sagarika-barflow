import bcrypt from 'bcryptjs';
import { db, setSetting } from './db.js';
import { nowISO, today, money } from './util.js';

/**
 * Liquor is purchased and stocked only in sealed 180 ml bottles.
 * Loose pours are 30/60/90/120/150 ml; the full sealed bottle is 180 ml.
 */
export const BOTTLE_SIZE_ML = 180;
export const POUR_SIZES = [
  { ml: 30, label: '30 ml' },
  { ml: 60, label: '60 ml' },
  { ml: 90, label: '90 ml' },
  { ml: 120, label: '120 ml' },
  { ml: 150, label: '150 ml' },
  { ml: 180, label: '180 ml (full bottle)' },
];

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

// peg = price of a 30 ml pour in INR. Larger pours scale from it, and every size
// keeps its own editable price in product_variants.
const LIQUOR = [
  { name: 'Blenders Pride Reserve', brand: 'Blenders Pride', cat: 'Whisky', bottles: 10, cost: 420, peg: 70 },
  { name: 'Royal Stag Barrel Select', brand: 'Royal Stag', cat: 'Whisky', bottles: 15, cost: 340, peg: 60 },
  { name: "Officer's Choice", brand: "Officer's Choice", cat: 'Whisky', bottles: 20, cost: 250, peg: 45 },
  { name: 'Johnnie Walker Red Label', brand: 'Johnnie Walker', cat: 'Whisky', bottles: 3, cost: 1450, peg: 180 },
  { name: 'Signature Rare Aged', brand: 'Signature', cat: 'Whisky', bottles: 6, cost: 560, peg: 90 },
  { name: 'Old Monk Legend', brand: 'Old Monk', cat: 'Rum', bottles: 12, cost: 280, peg: 50 },
  { name: 'Bacardi Carta Blanca', brand: 'Bacardi', cat: 'Rum', bottles: 6, cost: 460, peg: 80 },
  { name: 'Absolut Vodka', brand: 'Absolut', cat: 'Vodka', bottles: 4, cost: 820, peg: 110 },
  { name: 'Magic Moments Grain', brand: 'Magic Moments', cat: 'Vodka', bottles: 8, cost: 320, peg: 55 },
  { name: 'Bombay Sapphire', brand: 'Bombay Sapphire', cat: 'Gin', bottles: 3, cost: 1050, peg: 140 },
  { name: 'Mansion House Brandy', brand: 'Mansion House', cat: 'Brandy', bottles: 10, cost: 300, peg: 50 },
  { name: 'McDowell No.1 Brandy', brand: 'McDowell', cat: 'Brandy', bottles: 8, cost: 340, peg: 60 },
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

/** Exactly 20 independent restaurant tables: T1 - T20. Lodging rooms are separate. */
export const RESTAURANT_TABLES = Array.from({ length: 20 }, (_, i) => ({
  label: `T${i + 1}`,
  zone: i < 8 ? 'Main Hall' : i < 14 ? 'Garden' : 'AC Lounge',
  capacity: i < 8 ? 4 : i < 14 ? 6 : 8,
}));

/** Exactly 9 lodging rooms: 101 - 109. Never counted as restaurant tables. */
export const LODGING_ROOMS = [
  { room_no: '101', name: 'Room 101', floor: 'First Floor', room_type: 'Standard', rate: 1500 },
  { room_no: '102', name: 'Room 102', floor: 'First Floor', room_type: 'Standard', rate: 1500 },
  { room_no: '103', name: 'Room 103', floor: 'First Floor', room_type: 'Deluxe', rate: 1800 },
  { room_no: '104', name: 'Room 104', floor: 'First Floor', room_type: 'Deluxe', rate: 1800 },
  { room_no: '105', name: 'Room 105', floor: 'First Floor', room_type: 'Deluxe', rate: 1800 },
  { room_no: '106', name: 'Room 106', floor: 'Second Floor', room_type: 'Executive', rate: 2200 },
  { room_no: '107', name: 'Room 107', floor: 'Second Floor', room_type: 'Executive', rate: 2200 },
  { room_no: '108', name: 'Room 108', floor: 'Second Floor', room_type: 'Suite', rate: 2800 },
  { room_no: '109', name: 'Room 109', floor: 'Second Floor', room_type: 'Suite', rate: 2800 },
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

  // Owner PIN for destructive actions such as bill deletion. Change it in More → Security.
  db.prepare("UPDATE users SET pin_hash = ? WHERE role = 'owner' AND pin_hash IS NULL").run(
    bcrypt.hashSync('4321', 10),
  );

  const defaults = {
    hotel_name: 'Hotel Sagarika',
    tagline: 'Bar, Restaurant & Lodging',
    address: 'Main Road, Sagarika Complex, Mangaluru',
    phone: '9876500000',
    upi_id: 'hotelsagarika@upi',
    currency: '₹',
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
    `INSERT INTO products (name, category_id, brand, sku, unit_type, bottle_size_ml, stock_qty, stock_bottles,
       low_stock_qty, cost_price, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
      BOTTLE_SIZE_ML,
      money(p.bottles * BOTTLE_SIZE_ML), // ml mirror
      p.bottles, // authoritative bottle count
      2, // low-stock threshold in bottles
      p.cost,
      now,
      now,
    );
    const productId = Number(res.lastInsertRowid);
    POUR_SIZES.forEach((pour, i) => {
      // consume_qty is ml for liquor; the bill converts it to a bottle fraction.
      insertVariant.run(productId, pour.label, pour.ml, pour.ml, money((p.peg * pour.ml) / 30), i, now);
    });
    insertLedger.run(productId, p.bottles, p.bottles, 'Opening stock (180 ml bottles)', now);
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
      0,
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
  RESTAURANT_TABLES.forEach((t, i) => insertTable.run(t.label, t.zone, t.capacity, i, now));

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

/**
 * Guarantees exactly 20 restaurant tables labelled T1..T20.
 * Legacy G-series and L-series tables are renamed in place (history kept) and any surplus removed.
 */
export function ensureDiningTables() {
  const rows = db.prepare('SELECT id, label FROM dining_tables ORDER BY sort_order, id').all();
  const isCorrect = rows.length === RESTAURANT_TABLES.length && rows.every((r, i) => r.label === `T${i + 1}`);
  if (isCorrect) return false;
  const now = nowISO();
  db.transaction(() => {
    // two-phase rename so the UNIQUE(label) constraint is never violated
    for (const row of rows) {
      db.prepare('UPDATE dining_tables SET label = ? WHERE id = ?').run(`__migrating_${row.id}`, row.id);
    }
    rows.slice(0, RESTAURANT_TABLES.length).forEach((row, i) => {
      const preset = RESTAURANT_TABLES[i];
      db.prepare(
        `UPDATE dining_tables SET label = ?, zone = COALESCE(NULLIF(zone, ''), ?), capacity = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
      ).run(`T${i + 1}`, preset.zone, row.capacity ?? preset.capacity, i, now, row.id);
    });
    for (const extra of rows.slice(RESTAURANT_TABLES.length)) {
      db.prepare('DELETE FROM dining_tables WHERE id = ?').run(extra.id);
    }
    const insert = db.prepare(
      `INSERT INTO dining_tables (label, zone, capacity, status, sort_order, updated_at)
       VALUES (?, ?, ?, 'free', ?, ?)`,
    );
    for (let i = rows.length; i < RESTAURANT_TABLES.length; i++) {
      insert.run(`T${i + 1}`, RESTAURANT_TABLES[i].zone, RESTAURANT_TABLES[i].capacity, i, now);
    }
  })();
  return true;
}

/** Guarantees the nine lodging rooms 101-109 exist and stay separate from restaurant tables. */
export function ensureRooms() {
  const now = nowISO();
  const insert = db.prepare(
    `INSERT INTO rooms (room_no, name, floor, room_type, rate_per_night, status, sort_order, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)
     ON CONFLICT(room_no) DO NOTHING`,
  );
  db.transaction(() => {
    LODGING_ROOMS.forEach((room, i) => {
      insert.run(room.room_no, room.name, room.floor, room.room_type, room.rate, i, now, now);
    });
    const allowed = LODGING_ROOMS.map((r) => r.room_no);
    db.prepare(
      `DELETE FROM rooms WHERE room_no NOT IN (${allowed.map(() => '?').join(',')}) AND current_stay_id IS NULL`,
    ).run(...allowed);
  })();
}

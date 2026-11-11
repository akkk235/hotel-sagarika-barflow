import { db, audit } from './db.js';
import { HttpError, localDate, money, nowISO, toInt, toNum, today } from './util.js';

/**
 * Lodging module. Completely separate from restaurant tables:
 * rooms live in `rooms`, occupancy in `room_stays`.
 * Check-in / check-out / release are Owner-only (enforced in routes/lodging.js).
 */

export const ROOM_STATUSES = ['available', 'occupied', 'maintenance'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function nightsBetween(checkInAt, checkOutAt) {
  const inMs = new Date(checkInAt).getTime();
  const outMs = new Date(checkOutAt).getTime();
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) return 1;
  return Math.max(1, Math.ceil((outMs - inMs) / DAY_MS));
}

export function roomList() {
  const rows = db
    .prepare(
      `SELECT r.id, r.room_no, r.name, r.floor, r.room_type, r.rate_per_night, r.status,
              r.current_stay_id, r.sort_order, r.updated_at,
              s.id AS stay_id, s.guest_name, s.guest_phone, s.guests AS stay_guests,
              s.check_in_at, s.expected_check_out_at, s.rate_per_night AS stay_rate,
              s.room_charges, s.extra_charges, s.total_charges, s.amount_paid, s.status AS stay_status,
              s.created_by_name
       FROM rooms r
       LEFT JOIN room_stays s ON s.id = r.current_stay_id
       ORDER BY r.sort_order, r.room_no`,
    )
    .all();
  return rows.map((r) => ({
    ...r,
    nights: r.check_in_at ? nightsBetween(r.check_in_at, nowISO()) : 0,
    due: r.stay_id ? money((r.total_charges || 0) - (r.amount_paid || 0)) : 0,
  }));
}

export function roomById(id) {
  return roomList().find((r) => r.id === Number(id)) || null;
}

export function occupancyHistory({ limit = 50, roomId = null } = {}) {
  const capped = Math.min(Math.max(toInt(limit, 50), 1), 200);
  const where = roomId ? 'WHERE s.room_id = ?' : '';
  const params = roomId ? [Number(roomId), capped] : [capped];
  return db
    .prepare(
      `SELECT s.*, r.room_no, r.name AS room_name
       FROM room_stays s JOIN rooms r ON r.id = s.room_id
       ${where}
       ORDER BY s.check_in_at DESC, s.id DESC
       LIMIT ?`,
    )
    .all(...params);
}

export function roomSummary() {
  const date = today();
  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM rooms GROUP BY status').all();
  const countOf = (status) => counts.find((c) => c.status === status)?.c || 0;
  const total = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  const checkInsToday = db
    .prepare('SELECT COUNT(*) AS c FROM room_stays WHERE substr(check_in_at, 1, 10) = ?')
    .get(date).c;
  const outToday = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total_charges), 0) AS charges, COALESCE(SUM(amount_paid), 0) AS paid
       FROM room_stays WHERE status = 'checked_out' AND substr(check_out_at, 1, 10) = ?`,
    )
    .get(date);
  const outstanding = db
    .prepare(
      `SELECT COALESCE(SUM(total_charges - amount_paid), 0) AS v FROM room_stays WHERE status = 'in_house'`,
    )
    .get().v;
  const revenueToday = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paid), 0) AS v FROM room_stays
       WHERE status = 'checked_out' AND substr(check_out_at, 1, 10) = ?`,
    )
    .get(date).v;

  return {
    date,
    total,
    available: countOf('available'),
    occupied: countOf('occupied'),
    maintenance: countOf('maintenance'),
    in_house_guests: db
      .prepare('SELECT COALESCE(SUM(guests), 0) AS v FROM room_stays WHERE status = ?')
      .get('in_house').v,
    check_ins_today: checkInsToday,
    check_outs_today: outToday.c,
    room_revenue_today: money(revenueToday),
    collected_today: money(outToday.paid),
    outstanding: money(outstanding),
  };
}

function requireRoom(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(roomId));
  if (!room) throw new HttpError(404, 'Room not found');
  return room;
}

/** Owner-only check-in. Creates the stay, records guest details and room charges. */
export const checkIn = db.transaction((roomId, body = {}, user) => {
  const room = requireRoom(roomId);
  if (room.status === 'occupied' || room.current_stay_id) {
    throw new HttpError(400, `Room ${room.room_no} is already occupied`);
  }
  const guestName = String(body.guest_name || '').trim();
  if (!guestName) throw new HttpError(400, 'Guest name is required');

  const now = nowISO();
  const checkInAt = body.check_in_at ? new Date(body.check_in_at).toISOString() : now;
  const expectedOut = body.expected_check_out_at
    ? new Date(body.expected_check_out_at).toISOString()
    : new Date(new Date(checkInAt).getTime() + DAY_MS).toISOString();
  if (new Date(expectedOut).getTime() < new Date(checkInAt).getTime()) {
    throw new HttpError(400, 'Check-out date cannot be before check-in date');
  }
  const rate = Math.max(0, toNum(body.rate_per_night, room.rate_per_night));
  const nights = nightsBetween(checkInAt, expectedOut);
  const roomCharges = money(nights * rate);

  const res = db
    .prepare(
      `INSERT INTO room_stays (room_id, guest_name, guest_phone, guest_id_proof, guests,
         check_in_at, expected_check_out_at, rate_per_night, nights, room_charges, total_charges,
         amount_paid, status, notes, created_by, created_by_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'in_house', ?, ?, ?, ?, ?)`,
    )
    .run(
      room.id,
      guestName,
      body.guest_phone ? String(body.guest_phone) : null,
      body.guest_id_proof ? String(body.guest_id_proof) : null,
      Math.max(1, toInt(body.guests, 1)),
      checkInAt,
      expectedOut,
      rate,
      nights,
      roomCharges,
      roomCharges,
      body.notes ? String(body.notes) : null,
      user?.id ?? null,
      user?.name ?? null,
      now,
      now,
    );
  const stayId = Number(res.lastInsertRowid);
  db.prepare(`UPDATE rooms SET status = 'occupied', current_stay_id = ?, updated_at = ? WHERE id = ?`).run(
    stayId,
    now,
    room.id,
  );
  audit(user, 'room.checkin', 'room', room.id, {
    stay_id: stayId,
    room_no: room.room_no,
    guest: guestName,
    nights,
    room_charges: roomCharges,
  });
  return { room: roomById(room.id), stay: db.prepare('SELECT * FROM room_stays WHERE id = ?').get(stayId) };
});

/** Owner-only check-out. Finalises nights, extra charges, payment and frees the room. */
export const checkOut = db.transaction((roomId, body = {}, user) => {
  const room = requireRoom(roomId);
  if (room.status !== 'occupied' || !room.current_stay_id) {
    throw new HttpError(400, `Room ${room.room_no} is not occupied`);
  }
  const stay = db.prepare('SELECT * FROM room_stays WHERE id = ?').get(room.current_stay_id);
  if (!stay) throw new HttpError(400, 'No active stay found for this room');

  const now = nowISO();
  const checkOutAt = body.check_out_at ? new Date(body.check_out_at).toISOString() : now;
  if (new Date(checkOutAt).getTime() < new Date(stay.check_in_at).getTime()) {
    throw new HttpError(400, 'Check-out cannot be before check-in');
  }
  const nights = nightsBetween(stay.check_in_at, checkOutAt);
  const rate = Math.max(0, toNum(body.rate_per_night, stay.rate_per_night));
  const roomCharges = money(nights * rate);
  const extraCharges = Math.max(0, toNum(body.extra_charges, stay.extra_charges));
  const total = money(roomCharges + extraCharges);
  const paid = body.amount_paid === undefined ? total : Math.max(0, toNum(body.amount_paid, total));
  const mode = body.payment_mode ? String(body.payment_mode) : 'cash';
  if (!['cash', 'upi', 'card', 'credit'].includes(mode)) {
    throw new HttpError(400, 'payment_mode must be cash, upi, card or credit');
  }

  db.prepare(
    `UPDATE room_stays SET check_out_at = ?, nights = ?, rate_per_night = ?, room_charges = ?,
       extra_charges = ?, total_charges = ?, amount_paid = ?, payment_mode = ?, status = 'checked_out',
       checked_out_by = ?, checked_out_by_name = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    checkOutAt,
    nights,
    rate,
    roomCharges,
    extraCharges,
    total,
    paid,
    mode,
    user?.id ?? null,
    user?.name ?? null,
    now,
    stay.id,
  );
  db.prepare(`UPDATE rooms SET status = 'available', current_stay_id = NULL, updated_at = ? WHERE id = ?`).run(
    now,
    room.id,
  );
  audit(user, 'room.checkout', 'room', room.id, {
    stay_id: stay.id,
    room_no: room.room_no,
    nights,
    total_charges: total,
    amount_paid: paid,
    payment_mode: mode,
  });
  return {
    room: roomById(room.id),
    stay: db.prepare('SELECT * FROM room_stays WHERE id = ?').get(stay.id),
    bill: { nights, rate_per_night: rate, room_charges: roomCharges, extra_charges: extraCharges, total, paid, due: money(total - paid), payment_mode: mode },
  };
});

/** Owner-only release: cancel a stay without billing and free the room. */
export const releaseRoom = db.transaction((roomId, body = {}, user) => {
  const room = requireRoom(roomId);
  const now = nowISO();
  if (room.current_stay_id) {
    const stay = db.prepare('SELECT * FROM room_stays WHERE id = ?').get(room.current_stay_id);
    if (stay) {
      db.prepare(
        `UPDATE room_stays SET status = 'cancelled', check_out_at = ?, notes = COALESCE(?, notes), updated_at = ?
         WHERE id = ?`,
      ).run(now, body.reason ? String(body.reason) : null, now, stay.id);
      audit(user, 'room.release', 'room', room.id, {
        stay_id: stay.id,
        room_no: room.room_no,
        reason: body.reason || null,
      });
    }
  } else {
    audit(user, 'room.release', 'room', room.id, { room_no: room.room_no, reason: body.reason || null });
  }
  db.prepare(`UPDATE rooms SET status = 'available', current_stay_id = NULL, updated_at = ? WHERE id = ?`).run(
    now,
    room.id,
  );
  return { room: roomById(room.id) };
});

/** Manager/Owner: rename a room, set its number, or take it out of service. */
export function updateRoom(roomId, body = {}, user) {
  const room = requireRoom(roomId);
  const now = nowISO();
  const isOwner = user?.role === 'owner';
  const wantsOwnerFields = ['floor', 'room_type', 'rate_per_night', 'status'].some((k) => body[k] !== undefined);
  if (wantsOwnerFields && !isOwner) {
    throw new HttpError(403, 'Only the Owner can change floor, room type, tariff or room status');
  }

  const nextNo = body.room_no !== undefined ? String(body.room_no).trim() : room.room_no;
  if (!nextNo) throw new HttpError(400, 'Room number is required');
  if (nextNo !== room.room_no) {
    const clash = db.prepare('SELECT id FROM rooms WHERE room_no = ? AND id <> ?').get(nextNo, room.id);
    if (clash) throw new HttpError(409, `Room number ${nextNo} already exists`);
  }
  const nextName = body.name !== undefined ? String(body.name).trim() || `Room ${nextNo}` : room.name;

  let nextStatus = room.status;
  if (body.status !== undefined) {
    if (!ROOM_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid room status');
    if (room.status === 'occupied' && body.status !== 'occupied') {
      throw new HttpError(400, 'Check the guest out before changing an occupied room');
    }
    nextStatus = body.status;
  }

  db.prepare(
    `UPDATE rooms SET room_no = ?, name = ?, floor = ?, room_type = ?, rate_per_night = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextNo,
    nextName,
    body.floor !== undefined ? String(body.floor).trim() || room.floor : room.floor,
    body.room_type !== undefined ? String(body.room_type).trim() || room.room_type : room.room_type,
    body.rate_per_night !== undefined ? Math.max(0, toNum(body.rate_per_night, room.rate_per_night)) : room.rate_per_night,
    nextStatus,
    now,
    room.id,
  );
  audit(user, 'room.update', 'room', room.id, { room_no: nextNo, name: nextName, status: nextStatus });
  return roomById(room.id);
}

export { localDate };

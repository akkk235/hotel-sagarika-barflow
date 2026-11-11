import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const dt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const dateOnly = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

/**
 * Lodging module: 9 rooms (101-109), completely separate from restaurant tables.
 * Owner: check-in, check-out, release, tariff and status.
 * Manager: view room status and edit room number/name only.
 */
export default function Lodging({ user, online, notify, refresh }) {
  const [rooms, setRooms] = useState([]);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isOwner = user?.role === 'owner';
  const canEdit = ['owner', 'manager'].includes(user?.role);

  const load = useCallback(async () => {
    if (!online) return;
    try {
      const res = await api('/rooms');
      setRooms(res.rooms || []);
      setSummary(res.summary || null);
      const h = await api('/rooms/history?limit=25');
      setHistory(h.history || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [online]);

  useEffect(() => {
    load();
  }, [load]);

  function openRoom(room) {
    setSelected(room);
    setAction(null);
    setForm({
      guest_name: '',
      guest_phone: '',
      guest_id_proof: '',
      guests: 1,
      rate_per_night: room.stay_rate || room.rate_per_night || 0,
      expected_check_out_at: dateOnly(new Date(Date.now() + 86400000).toISOString()),
      extra_charges: room.extra_charges || 0,
      amount_paid: room.total_charges || 0,
      payment_mode: 'cash',
      reason: '',
      room_no: room.room_no,
      name: room.name,
      floor: room.floor,
      room_type: room.room_type,
      status: room.status,
    });
  }

  async function run(path, body, successMessage) {
    setBusy(true);
    try {
      const res = await api(path, { method: 'POST', body });
      notify(successMessage, 'ok');
      setSelected(res.room || null);
      setAction(null);
      await load();
      if (refresh) await refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveRoom() {
    setBusy(true);
    try {
      const body = { room_no: form.room_no, name: form.name };
      if (isOwner) {
        body.floor = form.floor;
        body.room_type = form.room_type;
        body.rate_per_night = Number(form.rate_per_night) || 0;
      }
      const res = await api(`/rooms/${selected.id}`, { method: 'PATCH', body });
      notify(`Room ${res.room.room_no} updated`, 'ok');
      setSelected(res.room);
      setAction(null);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>Lodging · rooms</h2>
        <span className="tiny muted">{rooms.length} rooms</span>
      </div>

      {error ? <div className="empty">{error}</div> : null}

      {summary ? (
        <div className="stat-grid">
          <div className="stat">
            <span className="k">Available</span>
            <span className="v" style={{ color: 'var(--green)' }}>{summary.available}</span>
          </div>
          <div className="stat">
            <span className="k">Occupied</span>
            <span className="v" style={{ color: 'var(--amber)' }}>{summary.occupied}</span>
          </div>
          <div className="stat">
            <span className="k">Guests</span>
            <span className="v">{summary.in_house_guests}</span>
          </div>
          <div className="stat">
            <span className="k">Due</span>
            <span className="v" style={{ fontSize: 15 }}>{money(summary.outstanding)}</span>
          </div>
        </div>
      ) : null}

      <div className="table-grid" style={{ marginTop: 10 }}>
        {rooms.map((r) => (
          <div key={r.id} className={`table-tile ${r.status === 'occupied' ? 'occupied' : r.status === 'available' ? 'free' : ''}`}>
            <div className="row between">
              <strong style={{ fontSize: 16 }}>{r.room_no}</strong>
              <span className="tiny muted">{r.room_type}</span>
            </div>
            <div className="tiny muted">{r.name}</div>
            <div className="tiny" style={{ color: r.status === 'occupied' ? 'var(--amber)' : 'var(--green)' }}>
              {r.status}
            </div>
            {r.guest_name ? (
              <div className="tiny muted">
                {r.guest_name} · {r.nights}n
              </div>
            ) : null}
            {r.stay_id && Number(r.due) > 0 ? (
              <div className="small" style={{ fontWeight: 750 }}>{money(r.due)}</div>
            ) : null}
            <div className="tile-actions">
              <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => openRoom(r)}>
                Manage
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="tiny muted">Recent occupancy</div>
        {history.length === 0 ? (
          <div className="tiny muted" style={{ marginTop: 6 }}>No stays recorded yet.</div>
        ) : (
          history.slice(0, 8).map((s) => (
            <div className="row between" key={s.id} style={{ marginTop: 6 }}>
              <div style={{ minWidth: 0 }}>
                <div className="small">{s.room_no} · {s.guest_name}</div>
                <div className="tiny muted">
                  {dt(s.check_in_at)} → {s.check_out_at ? dt(s.check_out_at) : 'in house'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="small">{money(s.total_charges)}</div>
                <div className="tiny muted">{s.status}</div>
              </div>
            </div>
          ))
        )}
      </div>

      {selected ? (
        <div className="sheet-backdrop" onClick={() => setSelected(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>
                Room {selected.room_no} · {selected.status}
              </h3>
              <button className="btn btn-sm" type="button" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>

            {selected.stay_id ? (
              <div className="card" style={{ marginBottom: 10 }}>
                <div className="row between">
                  <strong>{selected.guest_name}</strong>
                  <span className="tiny muted">{selected.stay_status}</span>
                </div>
                <div className="tiny muted">{selected.guest_phone || 'no phone'} · {selected.stay_guests} guest(s)</div>
                <div className="tiny muted">In: {dt(selected.check_in_at)}</div>
                <div className="tiny muted">Out: {selected.expected_check_out_at ? dt(selected.expected_check_out_at) : '—'}</div>
                <div className="row between" style={{ marginTop: 6 }}>
                  <span className="small">Nights</span>
                  <strong className="small">{selected.nights}</strong>
                </div>
                <div className="row between">
                  <span className="small">Rate / night</span>
                  <strong className="small">{money(selected.stay_rate)}</strong>
                </div>
                <div className="row between">
                  <span className="small">Charges</span>
                  <strong className="small">{money(selected.total_charges)}</strong>
                </div>
                <div className="row between">
                  <span className="small">Due</span>
                  <strong className="small">{money(selected.due)}</strong>
                </div>
              </div>
            ) : (
              <p className="small muted">
                Room is {selected.status}. Tariff {money(selected.rate_per_night)} per night.
              </p>
            )}

            {!action ? (
              <div className="row" style={{ marginBottom: 8 }}>
                {isOwner && selected.status !== 'occupied' ? (
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => setAction('checkin')}>
                    Check-in
                  </button>
                ) : null}
                {isOwner && selected.status === 'occupied' ? (
                  <>
                    <button className="btn btn-green btn-sm" type="button" onClick={() => setAction('checkout')}>
                      Check-out
                    </button>
                    <button className="btn btn-sm" type="button" onClick={() => setAction('release')}>
                      Release
                    </button>
                  </>
                ) : null}
                {canEdit ? (
                  <button className="btn btn-sm" type="button" onClick={() => setAction('edit')}>
                    Edit room
                  </button>
                ) : null}
              </div>
            ) : null}

            {action === 'checkin' ? (
              <>
                <div className="field">
                  <label htmlFor="gname">Guest name</label>
                  <input
                    id="gname"
                    className="input"
                    value={form.guest_name}
                    onChange={(e) => setForm({ ...form, guest_name: e.target.value })}
                    placeholder="Guest full name"
                  />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="gphone">Phone</label>
                    <input id="gphone" className="input" value={form.guest_phone} onChange={(e) => setForm({ ...form, guest_phone: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="gid">ID proof</label>
                    <input id="gid" className="input" value={form.guest_id_proof} onChange={(e) => setForm({ ...form, guest_id_proof: e.target.value })} placeholder="Aadhaar / DL" />
                  </div>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="gguests">Guests</label>
                    <input id="gguests" className="input" type="number" value={form.guests} onChange={(e) => setForm({ ...form, guests: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="grate">Rate / night</label>
                    <input id="grate" className="input" type="number" value={form.rate_per_night} onChange={(e) => setForm({ ...form, rate_per_night: e.target.value })} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="gout">Expected check-out date</label>
                  <input
                    id="gout"
                    className="input"
                    type="date"
                    value={form.expected_check_out_at}
                    onChange={(e) => setForm({ ...form, expected_check_out_at: e.target.value })}
                  />
                </div>
                <button
                  className="btn btn-primary btn-block"
                  type="button"
                  disabled={busy || !form.guest_name.trim()}
                  onClick={() =>
                    run(
                      `/rooms/${selected.id}/checkin`,
                      {
                        guest_name: form.guest_name,
                        guest_phone: form.guest_phone,
                        guest_id_proof: form.guest_id_proof,
                        guests: Number(form.guests) || 1,
                        rate_per_night: Number(form.rate_per_night) || 0,
                        expected_check_out_at: form.expected_check_out_at
                          ? new Date(`${form.expected_check_out_at}T12:00:00`).toISOString()
                          : undefined,
                      },
                      `Checked in to room ${selected.room_no}`,
                    )
                  }
                >
                  {busy ? 'Saving…' : 'Confirm check-in'}
                </button>
              </>
            ) : null}

            {action === 'checkout' ? (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="extra">Extra charges</label>
                    <input id="extra" className="input" type="number" value={form.extra_charges} onChange={(e) => setForm({ ...form, extra_charges: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="paid">Amount paid</label>
                    <input id="paid" className="input" type="number" value={form.amount_paid} onChange={(e) => setForm({ ...form, amount_paid: e.target.value })} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="mode">Payment mode</label>
                  <select id="mode" className="input" value={form.payment_mode} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                    <option value="credit">Credit</option>
                  </select>
                </div>
                <button
                  className="btn btn-green btn-block"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      `/rooms/${selected.id}/checkout`,
                      {
                        extra_charges: Number(form.extra_charges) || 0,
                        amount_paid: Number(form.amount_paid) || 0,
                        payment_mode: form.payment_mode,
                      },
                      `Room ${selected.room_no} checked out`,
                    )
                  }
                >
                  {busy ? 'Saving…' : 'Confirm check-out'}
                </button>
              </>
            ) : null}

            {action === 'release' ? (
              <>
                <div className="field">
                  <label htmlFor="reason">Reason</label>
                  <input id="reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Cancelled / no show" />
                </div>
                <button
                  className="btn btn-block"
                  type="button"
                  disabled={busy}
                  onClick={() => run(`/rooms/${selected.id}/release`, { reason: form.reason }, `Room ${selected.room_no} released`)}
                >
                  {busy ? 'Working…' : 'Release room without billing'}
                </button>
              </>
            ) : null}

            {action === 'edit' ? (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="rno">Room number</label>
                    <input id="rno" className="input" value={form.room_no} onChange={(e) => setForm({ ...form, room_no: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="rname">Room name</label>
                    <input id="rname" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                </div>
                {isOwner ? (
                  <>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor="rfloor">Floor</label>
                        <input id="rfloor" className="input" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="rtype">Type</label>
                        <input id="rtype" className="input" value={form.room_type} onChange={(e) => setForm({ ...form, room_type: e.target.value })} />
                      </div>
                    </div>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor="rrate">Tariff / night</label>
                        <input id="rrate" className="input" type="number" value={form.rate_per_night} onChange={(e) => setForm({ ...form, rate_per_night: e.target.value })} />
                      </div>
                      <div className="field">
                        <label htmlFor="rstatus">Status</label>
                        <select id="rstatus" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                          <option value="available">available</option>
                          <option value="occupied">occupied</option>
                          <option value="maintenance">maintenance</option>
                        </select>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="tiny muted">Only the Owner can change floor, type, tariff or status.</p>
                )}
                <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={saveRoom}>
                  {busy ? 'Saving…' : 'Save room'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

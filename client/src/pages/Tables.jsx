import React, { useState } from 'react';
import { api } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const STATUSES = ['free', 'occupied', 'reserved', 'cleaning'];

export default function Tables({ data, online, notify, refresh, onOpenTab }) {
  const tables = data?.tables || [];
  const [zone, setZone] = useState('all');
  const [busy, setBusy] = useState(false);
  const zones = ['all', ...Array.from(new Set(tables.map((t) => t.zone).filter(Boolean)))];
  const shown = tables.filter((t) => zone === 'all' || t.zone === zone);
  const counts = {
    free: tables.filter((t) => t.status === 'free').length,
    occupied: tables.filter((t) => t.status === 'occupied').length,
    reserved: tables.filter((t) => t.status === 'reserved').length,
    cleaning: tables.filter((t) => t.status === 'cleaning').length,
  };

  async function openTab(table) {
    if (!online) {
      notify('Opening a running tab needs a connection', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await api(`/tables/${table.id}/open`, { method: 'POST', body: { guests: 2 } });
      await api(`/orders/${res.order.id}`).then((r) => onOpenTab(r.order));
      notify(`${table.label} tab ${res.order.order_no} ready`, 'ok');
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function viewTab(table) {
    setBusy(true);
    try {
      const res = await api(`/orders/${table.current_order_id}`);
      onOpenTab(res.order);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(table, status) {
    setBusy(true);
    try {
      await api(`/tables/${table.id}/status`, { method: 'POST', body: { status } });
      notify(`${table.label} marked ${status}`, 'ok');
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>Dining tables</h2>
        <span className="tiny muted">{tables.length} tables</span>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <span className="k">Free</span>
          <span className="v" style={{ color: 'var(--green)' }}>
            {counts.free}
          </span>
        </div>
        <div className="stat">
          <span className="k">Occupied</span>
          <span className="v" style={{ color: 'var(--amber)' }}>
            {counts.occupied}
          </span>
        </div>
        <div className="stat">
          <span className="k">Reserved</span>
          <span className="v" style={{ color: 'var(--blue)' }}>
            {counts.reserved}
          </span>
        </div>
        <div className="stat">
          <span className="k">Cleaning</span>
          <span className="v muted">{counts.cleaning}</span>
        </div>
      </div>

      <div className="chips">
        {zones.map((z) => (
          <button key={z} type="button" className={`chip ${zone === z ? 'active' : ''}`} onClick={() => setZone(z)}>
            {z === 'all' ? 'All zones' : z}
          </button>
        ))}
      </div>

      <div className="table-grid">
        {shown.map((t) => (
          <div key={t.id} className={`table-tile ${t.status}`}>
            <div className="row between">
              <strong style={{ fontSize: 16 }}>{t.label}</strong>
              <span className="tiny muted">{t.capacity} seats</span>
            </div>
            <div className="tiny muted">{t.zone}</div>
            {t.order_no ? (
              <div className="tiny" style={{ color: 'var(--amber)' }}>
                {t.order_no} · {t.open_items} items
              </div>
            ) : (
              <div className="tiny muted">{t.status}</div>
            )}
            {Number(t.open_amount) > 0 ? <div className="small" style={{ fontWeight: 750 }}>{money(t.open_amount)}</div> : null}
            <div className="tile-actions">
              {t.current_order_id ? (
                <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => viewTab(t)}>
                  Open tab
                </button>
              ) : (
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => openTab(t)}>
                  Start tab
                </button>
              )}
              <select
                className="input"
                style={{ padding: '6px 8px', fontSize: 12 }}
                value={t.status}
                onChange={(e) => setStatus(t, e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

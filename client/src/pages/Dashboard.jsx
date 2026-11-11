import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const bottles = (n) => (Number(n) || 0).toFixed(2);

/**
 * Dashboard hub. Restaurant sales and room occupancy are shown in
 * separate sections and are never mixed together.
 */
export default function Dashboard({ user, online, notify, go }) {
  const [dash, setDash] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!online) return;
    try {
      const res = await api('/dashboard');
      setDash(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [online]);

  useEffect(() => {
    load();
  }, [load]);

  const restaurant = dash?.restaurant;
  const lodging = dash?.lodging;
  const billing = dash?.billing;
  const inventory = dash?.inventory;
  const reports = dash?.reports;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>Dashboard</h2>
        <span className="tiny muted">{user?.role} · {dash?.date || 'today'}</span>
      </div>

      {error ? <div className="empty">{error}</div> : null}
      {!dash && !error ? <div className="empty">Loading dashboard…</div> : null}

      {restaurant ? (
        <div className="card">
          <div className="row between">
            <div>
              <div className="tiny muted">Restaurant</div>
              <strong style={{ fontSize: 17 }}>{restaurant.tables_total} Tables</strong>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => go('tables')}>
              Open
            </button>
          </div>
          <div className="stat-grid" style={{ marginTop: 10 }}>
            <div className="stat">
              <span className="k">Free</span>
              <span className="v" style={{ color: 'var(--green)' }}>{restaurant.free}</span>
            </div>
            <div className="stat">
              <span className="k">Occupied</span>
              <span className="v" style={{ color: 'var(--amber)' }}>{restaurant.occupied}</span>
            </div>
            <div className="stat">
              <span className="k">Reserved</span>
              <span className="v" style={{ color: 'var(--blue)' }}>{restaurant.reserved}</span>
            </div>
            <div className="stat">
              <span className="k">Open tabs</span>
              <span className="v">{restaurant.open_tabs}</span>
            </div>
          </div>
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="small muted">Running tab value</span>
            <strong className="small">{money(restaurant.open_amount)}</strong>
          </div>
          <div className="row between">
            <span className="small muted">Restaurant sales today</span>
            <strong className="small">{money(restaurant.revenue)}</strong>
          </div>
        </div>
      ) : null}

      {lodging ? (
        <div className="card">
          <div className="row between">
            <div>
              <div className="tiny muted">Lodging</div>
              <strong style={{ fontSize: 17 }}>{lodging.total} Rooms</strong>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => go('rooms')}>
              Open
            </button>
          </div>
          <div className="stat-grid" style={{ marginTop: 10 }}>
            <div className="stat">
              <span className="k">Available</span>
              <span className="v" style={{ color: 'var(--green)' }}>{lodging.available}</span>
            </div>
            <div className="stat">
              <span className="k">Occupied</span>
              <span className="v" style={{ color: 'var(--amber)' }}>{lodging.occupied}</span>
            </div>
            <div className="stat">
              <span className="k">Guests in house</span>
              <span className="v">{lodging.in_house_guests}</span>
            </div>
            <div className="stat">
              <span className="k">Check-ins today</span>
              <span className="v">{lodging.check_ins_today}</span>
            </div>
          </div>
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="small muted">Room collection today</span>
            <strong className="small">{money(lodging.room_revenue_today)}</strong>
          </div>
          <div className="row between">
            <span className="small muted">Outstanding room dues</span>
            <strong className="small">{money(lodging.outstanding)}</strong>
          </div>
        </div>
      ) : null}

      {billing ? (
        <div className="card">
          <div className="row between">
            <div>
              <div className="tiny muted">Billing</div>
              <strong style={{ fontSize: 17 }}>{money(billing.revenue)}</strong>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => go('billing')}>
              New bill
            </button>
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>
            {billing.bills} bill{billing.bills === 1 ? '' : 's'} today
          </div>
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="small muted">Cash</span>
            <strong className="small">{money(billing.cash)}</strong>
          </div>
          <div className="row between">
            <span className="small muted">UPI</span>
            <strong className="small">{money(billing.upi)}</strong>
          </div>
          <div className="row between">
            <span className="small muted">Card</span>
            <strong className="small">{money(billing.card)}</strong>
          </div>
        </div>
      ) : null}

      {inventory ? (
        <div className="card">
          <div className="row between">
            <div>
              <div className="tiny muted">Inventory</div>
              <strong style={{ fontSize: 17 }}>{bottles(inventory.total_bottles)} bottles</strong>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => go('products')}>
              Open
            </button>
          </div>
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="small muted">180 ml bottles sold today</span>
            <strong className="small">{bottles(inventory.bottles_sold_today)}</strong>
          </div>
          <div className="row between">
            <span className="small muted">Low stock items</span>
            <strong className="small" style={{ color: inventory.low_stock_count ? 'var(--amber)' : undefined }}>
              {inventory.low_stock_count}
            </strong>
          </div>
          {inventory.low_stock?.length ? (
            <div className="tiny muted" style={{ marginTop: 6 }}>
              {inventory.low_stock
                .map((p) =>
                  p.unit_type === 'ml'
                    ? `${p.name} ${bottles(p.stock_bottles)} bt`
                    : `${p.name} ${Math.floor(p.stock_qty)} u`,
                )
                .join(' · ')}
            </div>
          ) : null}
        </div>
      ) : null}

      {reports ? (
        <div className="card">
          <div className="row between">
            <div>
              <div className="tiny muted">Reports · last 7 days</div>
              <strong style={{ fontSize: 17 }}>{money(reports.week_revenue)}</strong>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => go('reports')}>
              Open
            </button>
          </div>
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="small muted">Bills</span>
            <strong className="small">{reports.week_bills}</strong>
          </div>
          {reports.top_item ? (
            <div className="row between">
              <span className="small muted">Top seller</span>
              <strong className="small">{reports.top_item}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <button className="btn btn-block" type="button" onClick={load} disabled={!online}>
        Refresh
      </button>
    </div>
  );
}

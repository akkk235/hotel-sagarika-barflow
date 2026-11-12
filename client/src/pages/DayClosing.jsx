import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api.js';

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const timeOf = (iso) => (iso ? String(iso).slice(11, 16) : '—');
const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const STATUS_TONE = {
  not_opened: '#94a3b8',
  open: '#2563eb',
  stock_count_pending: '#d97706',
  closing_pending: '#7c3aed',
  closed: '#16a34a',
};

const REPORTS = [
  { name: 'daily_cash', label: 'Daily opening & closing cash', kind: 'range' },
  { name: 'upi', label: 'Daily UPI collection', kind: 'date' },
  { name: 'sales', label: 'Daily sales', kind: 'date' },
  { name: 'expenses', label: 'Daily expenses', kind: 'date' },
  { name: 'stock', label: 'Daily product-wise stock', kind: 'date' },
  { name: 'liquor', label: 'Liquor bottle-wise stock', kind: 'date' },
  { name: 'difference', label: 'Physical stock difference', kind: 'date' },
  { name: 'staff', label: 'Staff-wise sales', kind: 'date' },
  { name: 'monthly_cash', label: 'Monthly cash closing', kind: 'range' },
  { name: 'monthly_stock', label: 'Monthly stock movement', kind: 'range' },
];

function print58mm(title, lines, meta = []) {
  const win = window.open('', '_blank', 'width=380,height=600');
  if (!win) return false;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>
    @page { size: 58mm auto; margin: 2mm; }
    body { font-family: "Courier New", monospace; font-size: 11px; width: 54mm; margin: 0; color: #000; }
    h1 { font-size: 13px; text-align: center; margin: 0 0 2px; }
    .muted { text-align: center; font-size: 10px; margin-bottom: 4px; }
    .row { display: flex; justify-content: space-between; gap: 4px; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .b { font-weight: 700; }
    .note { font-size: 9px; margin-top: 4px; }
  </style></head><body>
  <h1>HOTEL SAGARIKA</h1>
  <div class="muted">${title}</div>
  ${meta.map((m) => `<div class="muted">${m}</div>`).join('')}
  <div class="sep"></div>
  ${lines
    .map((l) =>
      l.sep
        ? '<div class="sep"></div>'
        : `<div class="row${l.bold ? ' b' : ''}"><span>${l.label}</span><span>${l.value}</span></div>`,
    )
    .join('')}
  <div class="sep"></div>
  <div class="note">Cash &amp; UPI only. No GST, service charge or discount.</div>
  <script>window.onload = function(){ window.print(); };</script>
  </body></html>`;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

export default function DayClosing({ user, notify, online }) {
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [stock, setStock] = useState([]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [openingForm, setOpeningForm] = useState({ opening_cash: '', opening_upi: '', remarks: '' });
  const [movementForm, setMovementForm] = useState({ kind: 'out', amount: '', note: '' });
  const [counts, setCounts] = useState({});
  const [adjustForm, setAdjustForm] = useState({ product_id: '', direction: 'out', qty: '', loose_ml: '', reason: '' });
  const [closeForm, setCloseForm] = useState({ actual_cash: '', remarks: '', cashVerified: false, stockCounted: false });
  const [reopenForm, setReopenForm] = useState({ pin: '', reason: '' });

  const role = user?.role || 'staff';
  const isManager = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';

  const load = useCallback(
    async (target = date) => {
      setError('');
      try {
        const st = await api(`/day/status?date=${target}`);
        setStatus(st);
        if (isManager) {
          const [sum, stk] = await Promise.all([
            api(`/day/summary?date=${target}`),
            api(`/day/stock?date=${target}`),
          ]);
          setSummary(sum);
          setStock(stk.products || []);
          setCloseForm((f) => ({
            ...f,
            actual_cash: sum.cash?.actual_cash != null ? String(sum.cash.actual_cash) : f.actual_cash,
          }));
        }
      } catch (err) {
        setError(err.message || 'Could not load the day book');
      } finally {
        setLoading(false);
      }
    },
    [date, isManager],
  );

  useEffect(() => {
    setLoading(true);
    load(date);
  }, [date, load]);

  const cash = summary?.cash || status?.cash || null;
  const dayStatus = status?.status || 'not_opened';
  const closed = dayStatus === 'closed';

  const countsFor = (productId) => counts[productId] || { bottles: '', loose: '', reason: '' };
  const setCount = (productId, patch) =>
    setCounts((prev) => ({ ...prev, [productId]: { ...countsFor(productId), ...patch } }));

  const run = async (fn, okMessage) => {
    if (!online) {
      notify?.('This action needs a connection. Reconnect and try again.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await fn();
      if (okMessage) notify?.(okMessage);
      await load(date);
    } catch (err) {
      setError(err.message || 'Action failed');
      notify?.(err.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const openDay = () =>
    run(
      () =>
        api('/day/opening', {
          method: 'POST',
          body: {
            date,
            opening_cash: Number(openingForm.opening_cash),
            opening_upi: Number(openingForm.opening_upi || 0),
            remarks: openingForm.remarks,
          },
        }),
      'Business day opened',
    );

  const correctOpening = () => {
    const pin = window.prompt('Owner PIN to correct the opening entry:');
    if (!pin) return;
    run(
      () =>
        api('/day/opening/correct', {
          method: 'POST',
          body: {
            date,
            pin,
            opening_cash: Number(openingForm.opening_cash),
            opening_upi: Number(openingForm.opening_upi || 0),
            remarks: openingForm.remarks,
          },
        }),
      'Opening entry corrected',
    );
  };

  const addMovement = () =>
    run(
      () =>
        api('/day/cash', {
          method: 'POST',
          body: { date, kind: movementForm.kind, amount: Number(movementForm.amount), note: movementForm.note },
        }),
      'Cash movement recorded',
    );

  const saveCount = (product) =>
    run(async () => {
      const c = countsFor(product.product_id);
      await api('/day/stock/count', {
        method: 'POST',
        body: {
          date,
          product_id: product.product_id,
          actual_bottles: Number(c.bottles === '' ? product.expected : c.bottles),
          actual_loose_ml: Number(c.loose || 0),
          reason: c.reason,
        },
      });
    }, 'Stock count saved');

  const saveAllCounts = () =>
    run(async () => {
      for (const product of stock) {
        const c = counts[product.product_id];
        const bottles = c && c.bottles !== '' ? Number(c.bottles) : product.expected;
        await api('/day/stock/count', {
          method: 'POST',
          body: {
            date,
            product_id: product.product_id,
            actual_bottles: bottles,
            actual_loose_ml: Number(c?.loose || 0),
            reason: c?.reason || '',
          },
        });
      }
    }, 'All stock counts saved');

  const addAdjustment = () =>
    run(
      () =>
        api('/day/stock/adjustment', {
          method: 'POST',
          body: {
            date,
            product_id: Number(adjustForm.product_id),
            direction: adjustForm.direction,
            qty: Number(adjustForm.qty),
            loose_ml: Number(adjustForm.loose_ml || 0),
            reason: adjustForm.reason,
          },
        }),
      'Stock adjustment recorded',
    );

  const closeDayNow = () =>
    run(
      () =>
        api('/day/close', {
          method: 'POST',
          body: { date, actual_cash: Number(closeForm.actual_cash), remarks: closeForm.remarks },
        }),
      'Day closed and locked',
    );

  const reopenDayNow = () =>
    run(
      () => api('/day/reopen', { method: 'POST', body: { date, pin: reopenForm.pin, reason: reopenForm.reason } }),
      'Day reopened — remember to close it again',
    );

  const download = async (name, format) => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ format, date, to: date, from: date });
      const res = await fetch(`/api/day/reports/${name}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      if (format === 'print') {
        const html = await res.text();
        const win = window.open('', '_blank');
        if (!win) throw new Error('Allow pop-ups to print reports');
        win.document.open();
        win.document.write(html);
        win.document.close();
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-${date}.${format === 'xlsx' ? 'xlsx' : 'pdf'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify?.(`${name} ${format === 'xlsx' ? 'Excel' : 'PDF'} downloaded`);
    } catch (err) {
      setError(err.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const printClosing = () => {
    if (!cash) return;
    const lines = [
      { label: 'Date', value: date },
      { label: 'Status', value: status?.label || dayStatus },
      { sep: true },
      { label: 'Opening cash', value: inr(cash.opening_cash) },
      { label: 'Cash sales', value: inr(cash.cash_sales) },
      { label: 'UPI sales', value: inr(cash.upi_sales) },
      { label: 'Cash received', value: inr(cash.cash_received) },
      { label: 'Cash expenses', value: `-${inr(cash.cash_expenses)}` },
      { label: 'Cash refunds', value: `-${inr(cash.cash_refunds)}` },
      { sep: true },
      { label: 'Expected cash', value: inr(cash.expected_cash), bold: true },
      { label: 'Actual cash', value: cash.actual_cash == null ? '—' : inr(cash.actual_cash) },
      { label: 'Difference', value: cash.cash_difference == null ? '—' : inr(cash.cash_difference), bold: true },
      { sep: true },
      { label: 'Total sales', value: inr(cash.total_sales) },
      { label: 'Bills', value: String(cash.bill_count ?? 0) },
      { label: 'Stock items counted', value: `${status?.stock?.counted ?? 0}/${status?.stock?.products ?? 0}` },
      { label: 'Stock discrepancies', value: String(status?.stock?.discrepancies ?? 0) },
    ];
    if (!print58mm('DAILY CLOSING', lines, [date, `By ${user?.name || ''}`])) {
      notify?.('Allow pop-ups to print the closing statement');
    }
  };

  const totals = useMemo(() => {
    const counted = stock.filter((s) => s.counted).length;
    const discrepancies = stock.filter((s) => s.counted && Math.abs(s.difference || 0) > 0.0001).length;
    return { counted, discrepancies };
  }, [stock]);

  if (!isManager) {
    return (
      <div className="page">
        <div className="card">
          <h2>Daily closing &amp; stock audit</h2>
          <p className="small">
            Day status: <strong>{status?.label || '—'}</strong>
          </p>
          <p className="small muted">
            Only the Manager and Owner can open the day, count stock or close cash. Ask your manager if a count is
            pending.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Daily closing &amp; stock audit</h2>
            <p className="small muted" style={{ margin: '2px 0 0' }}>
              Cash, UPI, stock reconciliation and day lock
            </p>
          </div>
          <span
            style={{
              background: STATUS_TONE[dayStatus] || '#64748b',
              color: '#fff',
              borderRadius: 999,
              padding: '4px 10px',
              fontSize: 12,
              whiteSpace: 'nowrap',
            }}
          >
            {status?.label || 'Not Opened'}
          </span>
        </div>
        <label className="small" htmlFor="day-date" style={{ display: 'block', marginTop: 10 }}>
          Business date
        </label>
        <input
          id="day-date"
          type="date"
          value={date}
          max={todayISO()}
          onChange={(e) => setDate(e.target.value || todayISO())}
        />
        {!online ? <p className="small" style={{ color: '#b45309' }}>Offline — opening, counts and closing need a connection.</p> : null}
        {error ? <p className="small" style={{ color: '#b91c1c' }}>{error}</p> : null}
      </div>

      {cash ? (
        <div className="card">
          <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            <Tile label="Opening cash" value={inr(cash.opening_cash)} />
            <Tile label="Expected cash" value={inr(cash.expected_cash)} />
            <Tile label="Actual cash" value={cash.actual_cash == null ? '—' : inr(cash.actual_cash)} />
            <Tile
              label="Difference"
              value={cash.cash_difference == null ? '—' : inr(cash.cash_difference)}
              tone={cash.cash_difference == null ? undefined : cash.cash_difference < 0 ? '#b91c1c' : '#15803d'}
            />
            <Tile label="Total sales" value={inr(cash.total_sales)} />
            <Tile
              label="Stock discrepancies"
              value={`${status?.stock?.discrepancies ?? 0}`}
              tone={(status?.stock?.discrepancies ?? 0) > 0 ? '#b45309' : undefined}
            />
          </div>
        </div>
      ) : null}

      <div className="tabs" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 2px' }}>
        {[
          ['overview', 'Closing'],
          ['opening', 'Opening'],
          ['cash', 'Cash'],
          ['stock', 'Stock'],
          ['reports', 'Reports'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn ${tab === id ? 'btn-primary' : ''}`}
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'opening' ? (
        <div className="card">
          <h3>Daily opening</h3>
          {status?.session ? (
            <div className="small" style={{ marginBottom: 8 }}>
              <p style={{ margin: '2px 0' }}>
                Opened {timeOf(status.session.opened_at)} by {status.session.opened_by_name || '—'}
              </p>
              <p style={{ margin: '2px 0' }}>Opening cash {inr(status.session.opening_cash)}</p>
              <p style={{ margin: '2px 0' }}>
                Opening UPI reference {inr(status.session.opening_upi)}
              </p>
              {status.session.opening_remarks ? <p style={{ margin: '2px 0' }}>Remarks: {status.session.opening_remarks}</p> : null}
              {status.session.reopen_count > 0 ? (
                <p style={{ margin: '2px 0', color: '#b45309' }}>Reopened {status.session.reopen_count} time(s) by Owner</p>
              ) : null}
            </div>
          ) : (
            <p className="small muted">Opening stock will carry forward from the previous verified closing.</p>
          )}
          <label className="small" htmlFor="op-cash">
            Opening cash in hand (mandatory)
          </label>
          <input
            id="op-cash"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={openingForm.opening_cash}
            onChange={(e) => setOpeningForm({ ...openingForm, opening_cash: e.target.value })}
            placeholder="5000"
          />
          <label className="small" htmlFor="op-upi">
            Opening UPI balance (optional, reference only)
          </label>
          <input
            id="op-upi"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={openingForm.opening_upi}
            onChange={(e) => setOpeningForm({ ...openingForm, opening_upi: e.target.value })}
            placeholder="0"
          />
          <label className="small" htmlFor="op-rem">
            Opening remarks
          </label>
          <input
            id="op-rem"
            value={openingForm.remarks}
            onChange={(e) => setOpeningForm({ ...openingForm, remarks: e.target.value })}
            placeholder="Shift handover notes"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {!status?.session ? (
              <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={openDay}>
                Confirm opening
              </button>
            ) : isOwner ? (
              <button className="btn btn-block" type="button" disabled={busy || closed} onClick={correctOpening}>
                Owner: correct opening (PIN)
              </button>
            ) : (
              <p className="small muted">Only the Owner can correct an opening entry.</p>
            )}
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="small">Opening stock carried forward ({stock.length} products)</summary>
            <ul className="small" style={{ paddingLeft: 16 }}>
              {stock.map((p) => (
                <li key={p.product_id}>
                  {p.name} — {qty(p.opening)} {p.is_liquor ? 'btl' : 'units'}
                  {p.is_liquor ? ` (${qty(p.sealed_bottles)} sealed + ${qty(p.loose_ml)} ml)` : ''}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {tab === 'cash' ? (
        <>
          <div className="card">
            <h3>Cash position</h3>
            <Row label="Opening cash" value={inr(cash?.opening_cash)} />
            <Row label="Cash sales" value={inr(cash?.cash_sales)} />
            <Row label="UPI sales (not cash)" value={inr(cash?.upi_sales)} />
            <Row label="Cash received" value={inr(cash?.cash_received)} />
            <Row label="Cash expenses" value={`-${inr(cash?.cash_expenses)}`} />
            <Row label="Other cash paid out" value={`-${inr(cash?.cash_paid_out)}`} />
            <Row label="Cash refunds" value={`-${inr(cash?.cash_refunds)}`} />
            <div style={{ borderTop: '1px dashed #cbd5e1', margin: '6px 0' }} />
            <Row label="Expected closing cash" value={inr(cash?.expected_cash)} bold />
            <Row label="Actual closing cash" value={cash?.actual_cash == null ? '—' : inr(cash.actual_cash)} />
            <Row
              label={cash?.cash_difference != null && cash.cash_difference < 0 ? 'Shortage' : 'Excess / difference'}
              value={cash?.cash_difference == null ? '—' : inr(cash.cash_difference)}
              bold
            />
            <p className="small muted">
              Expected = opening + cash sales + cash received − cash expenses − cash refunds. UPI never enters cash.
            </p>
          </div>

          <div className="card">
            <h3>Record cash movement</h3>
            <label className="small" htmlFor="mv-kind">
              Type
            </label>
            <select
              id="mv-kind"
              value={movementForm.kind}
              onChange={(e) => setMovementForm({ ...movementForm, kind: e.target.value })}
            >
              <option value="out">Cash paid out (expense)</option>
              <option value="in" disabled={!isOwner || !cash?.cash_received_enabled}>
                Cash received {(!isOwner || !cash?.cash_received_enabled) ? '(Owner only)' : ''}
              </option>
            </select>
            <label className="small" htmlFor="mv-amount">
              Amount
            </label>
            <input
              id="mv-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={movementForm.amount}
              onChange={(e) => setMovementForm({ ...movementForm, amount: e.target.value })}
            />
            <label className="small" htmlFor="mv-note">
              Note
            </label>
            <input
              id="mv-note"
              value={movementForm.note}
              onChange={(e) => setMovementForm({ ...movementForm, note: e.target.value })}
              placeholder="Vegetables purchase"
            />
            <button className="btn btn-primary btn-block" type="button" disabled={busy || closed} onClick={addMovement} style={{ marginTop: 8 }}>
              Save movement
            </button>
            {!isOwner ? (
              <p className="small muted">Owner can enable “cash received from other sources” in settings.</p>
            ) : (
              <button
                className="btn btn-block"
                type="button"
                style={{ marginTop: 6 }}
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      api('/day/settings', {
                        method: 'PUT',
                        body: { cash_received_enabled: !cash?.cash_received_enabled },
                      }),
                    'Cash received setting updated',
                  )
                }
              >
                {cash?.cash_received_enabled ? 'Disable' : 'Enable'} cash received from other sources
              </button>
            )}
            {summary?.cash_movements?.length ? (
              <ul className="small" style={{ paddingLeft: 16 }}>
                {summary.cash_movements.map((m) => (
                  <li key={m.id}>
                    {m.kind === 'in' ? '+' : '−'}
                    {inr(m.amount)} · {m.note} · {m.created_by_name || '—'}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="card">
            <h3>Expenses today</h3>
            {summary?.transactions?.expenses?.length ? (
              summary.transactions.expenses.map((e) => (
                <Row key={e.id} label={`${e.category}${e.note ? ` · ${e.note}` : ''}`} value={inr(e.amount)} />
              ))
            ) : (
              <p className="small muted">No expenses recorded today.</p>
            )}
          </div>
        </>
      ) : null}

      {tab === 'stock' ? (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Physical stock count</h3>
              <span className="small muted">
                {totals.counted}/{stock.length} counted · {totals.discrepancies} differences
              </span>
            </div>
            {closed ? <p className="small" style={{ color: '#15803d' }}>Day closed — stock counts are locked.</p> : null}
            <button
              className="btn btn-primary btn-block"
              type="button"
              style={{ marginTop: 8 }}
              disabled={busy || closed || !stock.length}
              onClick={saveAllCounts}
            >
              Save all counts
            </button>
          </div>

          {stock.map((p) => {
            const c = countsFor(p.product_id);
            const shown = c.bottles === '' ? p.expected : Number(c.bottles) + (p.is_liquor ? Number(c.loose || 0) / p.bottle_size_ml : 0);
            const diff = Math.round((shown - p.expected) * 10000) / 10000;
            return (
              <div className="card" key={p.product_id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <strong>{p.name}</strong>
                    <div className="small muted">
                      {p.category_name} · {p.is_liquor ? `${p.bottle_size_ml} ml bottles` : 'units'}
                    </div>
                  </div>
                  {p.counted ? <span className="small" style={{ color: '#15803d' }}>Counted</span> : null}
                </div>
                <div className="small" style={{ marginTop: 6 }}>
                  <Row label="Opening" value={qty(p.opening)} />
                  <Row label="Purchases" value={qty(p.purchases)} />
                  <Row label="Sold" value={qty(p.sales)} />
                  <Row label="Adj in / out" value={`${qty(p.adjustments_in)} / ${qty(p.adjustments_out)}`} />
                  <Row label="Expected closing" value={qty(p.expected)} bold />
                  {p.is_liquor ? (
                    <Row label="Expected sealed + loose" value={`${qty(p.sealed_bottles)} btl + ${qty(p.loose_ml)} ml`} />
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <div style={{ flex: 1 }}>
                    <label className="small" htmlFor={`cnt-${p.product_id}`}>
                      Actual {p.is_liquor ? 'sealed bottles' : 'units'}
                    </label>
                    <input
                      id={`cnt-${p.product_id}`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step={p.is_liquor ? '1' : '0.01'}
                      value={c.bottles}
                      placeholder={String(p.expected)}
                      disabled={closed}
                      onChange={(e) => setCount(p.product_id, { bottles: e.target.value })}
                    />
                  </div>
                  {p.is_liquor ? (
                    <div style={{ flex: 1 }}>
                      <label className="small" htmlFor={`loose-${p.product_id}`}>
                        Loose ml
                      </label>
                      <input
                        id={`loose-${p.product_id}`}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max={p.bottle_size_ml - 1}
                        step="1"
                        value={c.loose}
                        placeholder="0"
                        disabled={closed}
                        onChange={(e) => setCount(p.product_id, { loose: e.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
                <label className="small" htmlFor={`why-${p.product_id}`}>
                  Reason (required when there is a difference)
                </label>
                <input
                  id={`why-${p.product_id}`}
                  value={c.reason}
                  disabled={closed}
                  onChange={(e) => setCount(p.product_id, { reason: e.target.value })}
                  placeholder="Breakage, spillage, counting error"
                />
                <div className="small" style={{ marginTop: 4, color: Math.abs(diff) > 0.0001 ? '#b45309' : '#15803d' }}>
                  Difference: {qty(diff)} {p.is_liquor ? 'btl' : 'units'}
                </div>
                <button className="btn btn-block" type="button" disabled={busy || closed} onClick={() => saveCount(p)} style={{ marginTop: 6 }}>
                  Save count
                </button>
              </div>
            );
          })}

          {isOwner ? (
            <div className="card">
              <h3>Owner stock adjustment</h3>
              <label className="small" htmlFor="adj-prod">
                Product
              </label>
              <select
                id="adj-prod"
                value={adjustForm.product_id}
                onChange={(e) => setAdjustForm({ ...adjustForm, product_id: e.target.value })}
              >
                <option value="">Select product</option>
                {stock.map((p) => (
                  <option key={p.product_id} value={p.product_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <label className="small" htmlFor="adj-dir">
                Direction
              </label>
              <select
                id="adj-dir"
                value={adjustForm.direction}
                onChange={(e) => setAdjustForm({ ...adjustForm, direction: e.target.value })}
              >
                <option value="in">Adjustment in</option>
                <option value="out">Adjustment out</option>
              </select>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <label className="small" htmlFor="adj-qty">
                    Bottles / units
                  </label>
                  <input
                    id="adj-qty"
                    type="number"
                    min="0"
                    step="0.01"
                    value={adjustForm.qty}
                    onChange={(e) => setAdjustForm({ ...adjustForm, qty: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="small" htmlFor="adj-ml">
                    Loose ml
                  </label>
                  <input
                    id="adj-ml"
                    type="number"
                    min="0"
                    step="1"
                    value={adjustForm.loose_ml}
                    onChange={(e) => setAdjustForm({ ...adjustForm, loose_ml: e.target.value })}
                  />
                </div>
              </div>
              <label className="small" htmlFor="adj-reason">
                Reason
              </label>
              <input
                id="adj-reason"
                value={adjustForm.reason}
                onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                placeholder="Breakage approved by Owner"
              />
              <button className="btn btn-primary btn-block" type="button" disabled={busy || closed} onClick={addAdjustment} style={{ marginTop: 8 }}>
                Post adjustment
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'overview' ? (
        <>
          <div className="card">
            <h3>Daily closing</h3>
            {closed ? (
              <div className="small" style={{ color: '#15803d' }}>
                <p style={{ margin: '2px 0' }}>
                  Closed {timeOf(status.session.closed_at)} by {status.session.closed_by_name || '—'}
                </p>
                <p style={{ margin: '2px 0' }}>Closing remarks: {status.session.closing_remarks || '—'}</p>
                <p style={{ margin: '2px 0' }}>This day is locked against edits.</p>
              </div>
            ) : (
              <>
                <label className="small" htmlFor="cl-cash">
                  Actual cash counted (physical)
                </label>
                <input
                  id="cl-cash"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={closeForm.actual_cash}
                  onChange={(e) => setCloseForm({ ...closeForm, actual_cash: e.target.value })}
                  placeholder={String(cash?.expected_cash ?? '')}
                />
                <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={closeForm.cashVerified}
                    onChange={(e) => setCloseForm({ ...closeForm, cashVerified: e.target.checked })}
                  />
                  I verified the cash physically
                </label>
                <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={closeForm.stockCounted}
                    onChange={(e) => setCloseForm({ ...closeForm, stockCounted: e.target.checked })}
                  />
                  Stock counting is complete ({totals.counted}/{stock.length})
                </label>
                <label className="small" htmlFor="cl-rem">
                  Closing remarks (required if cash or stock differs)
                </label>
                <input
                  id="cl-rem"
                  value={closeForm.remarks}
                  onChange={(e) => setCloseForm({ ...closeForm, remarks: e.target.value })}
                  placeholder="₹100 short, paid to vegetable vendor"
                />
                <button
                  className="btn btn-primary btn-block"
                  type="button"
                  style={{ marginTop: 8 }}
                  disabled={busy || !status?.session || !closeForm.cashVerified || !closeForm.stockCounted}
                  onClick={closeDayNow}
                >
                  Close day &amp; lock
                </button>
                {!status?.session ? <p className="small muted">Open the business day first.</p> : null}
                {status?.session && totals.counted < stock.length ? (
                  <p className="small" style={{ color: '#b45309' }}>
                    {stock.length - totals.counted} product(s) still need a physical count.
                  </p>
                ) : null}
              </>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button className="btn btn-block" type="button" onClick={printClosing}>
                Print 58mm statement
              </button>
              <button className="btn btn-block" type="button" disabled={busy} onClick={() => download('daily_cash', 'pdf')}>
                PDF
              </button>
              <button className="btn btn-block" type="button" disabled={busy} onClick={() => download('daily_cash', 'xlsx')}>
                Excel
              </button>
            </div>
          </div>

          <div className="card">
            <h3>Staff-wise sales</h3>
            {summary?.staff_sales?.length ? (
              summary.staff_sales.map((s) => (
                <Row key={s.staff_name} label={`${s.staff_name} · ${s.bills} bills`} value={inr(s.total)} />
              ))
            ) : (
              <p className="small muted">No paid bills yet today.</p>
            )}
          </div>

          <div className="card">
            <h3>Transaction summary</h3>
            <Row label="Paid bills" value={String(cash?.bill_count ?? 0)} />
            <Row label="Total sales" value={inr(cash?.total_sales)} />
            <Row label="Cash sales" value={inr(cash?.cash_sales)} />
            <Row label="UPI sales" value={inr(cash?.upi_sales)} />
            <Row label="Refunds" value={`${cash?.refund_count ?? 0} · ${inr(cash?.cash_refunds)}`} />
            <Row label="Stock adjustments" value={String(summary?.transactions?.adjustments?.length ?? 0)} />
          </div>

          {status?.stock?.rows?.length ? (
            <div className="card">
              <h3>Stock discrepancies</h3>
              {status.stock.rows.map((r) => (
                <Row key={r.product_id} label={r.name} value={`${qty(r.difference)} ${r.unit_type === 'ml' ? 'btl' : 'units'}`} />
              ))}
            </div>
          ) : null}

          {closed && isOwner ? (
            <div className="card">
              <h3>Reopen closed day (Owner)</h3>
              <label className="small" htmlFor="re-pin">
                Owner PIN
              </label>
              <input
                id="re-pin"
                type="password"
                inputMode="numeric"
                value={reopenForm.pin}
                onChange={(e) => setReopenForm({ ...reopenForm, pin: e.target.value })}
              />
              <label className="small" htmlFor="re-why">
                Reason
              </label>
              <input
                id="re-why"
                value={reopenForm.reason}
                onChange={(e) => setReopenForm({ ...reopenForm, reason: e.target.value })}
                placeholder="Missed UPI entry"
              />
              <button className="btn btn-block" type="button" disabled={busy} onClick={reopenDayNow} style={{ marginTop: 8 }}>
                Reopen day
              </button>
              {status?.session?.reopen_count > 0 ? (
                <p className="small muted">Reopened {status.session.reopen_count} time(s) before.</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'reports' ? (
        <div className="card">
          <h3>Daily &amp; monthly reports</h3>
          {!isOwner ? (
            <p className="small muted">Managers can view and export today's closing report only.</p>
          ) : null}
          {REPORTS.map((r) => (
            <div key={r.name} style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8, marginTop: 8 }}>
              <div className="small" style={{ marginBottom: 4 }}>
                <strong>{r.label}</strong>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-block" type="button" disabled={busy} onClick={() => download(r.name, 'pdf')}>
                  PDF
                </button>
                <button className="btn btn-block" type="button" disabled={busy} onClick={() => download(r.name, 'xlsx')}>
                  Excel
                </button>
                <button className="btn btn-block" type="button" disabled={busy} onClick={() => download(r.name, 'print')}>
                  Print
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {loading ? <p className="small muted">Loading day book…</p> : null}
    </div>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 10, padding: '8px 10px' }}>
      <div className="small muted">{label}</div>
      <div style={{ fontWeight: 700, color: tone || '#0f172a' }}>{value}</div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, margin: '2px 0' }}>
      <span className="small">{label}</span>
      <span className="small" style={{ fontWeight: bold ? 700 : 500 }}>
        {value}
      </span>
    </div>
  );
}

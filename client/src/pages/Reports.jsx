import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { buildReceiptHtml, printReceiptHtml } from '../receipt.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${todayStr().slice(0, 7)}-01`;

export default function Reports({ data, notify, online, user, refresh }) {
  const [date, setDate] = useState(todayStr());
  const isOwner = user?.role === 'owner';
  const [deletions, setDeletions] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [dash, setDash] = useState(null);
  const [printingId, setPrintingId] = useState(null);
  const [sales, setSales] = useState(null);
  const [items, setItems] = useState(null);
  const [stock, setStock] = useState(null);
  const [expenses, setExpenses] = useState(null);
  const [view, setView] = useState('today');
  const [busy, setBusy] = useState(false);
  const [expForm, setExpForm] = useState({ category: 'Purchase', amount: '', note: '' });
  const canExpense = ['owner', 'manager'].includes(user?.role);

  const loadDeletions = useCallback(async () => {
    if (!online) return;
    try {
      setDeletions(await api('/bills/deleted'));
    } catch {
      setDeletions(null);
    }
  }, [online]);

  useEffect(() => {
    loadDeletions();
  }, [loadDeletions]);

  /** Reprint an old bill on the 58 mm layout, clearly marked DUPLICATE. */
  async function reprint(billId) {
    try {
      setPrintingId(billId);
      const res = await api(`/bills/${billId}`);
      const ok = printReceiptHtml(buildReceiptHtml(res.bill, data?.settings || {}, { duplicate: true }));
      notify(
        ok
          ? 'Duplicate receipt sent to the print dialog'
          : 'The browser blocked printing. Allow pop-ups for this site and try again.',
        ok ? 'ok' : 'error',
      );
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setPrintingId(null);
    }
  }

  function closeDelete() {
    setDeleteTarget(null);
    setPin('');
    setReason('');
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/bills/${deleteTarget.id}`, {
        method: 'DELETE',
        body: { pin: pin.trim(), reason: reason.trim() || null },
      });
      notify(`Bill ${deleteTarget.bill_no} deleted`, 'ok');
      closeDelete();
      await loadDeletions();
      if (refresh) await refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setDeleting(false);
    }
  }

  const load = useCallback(async () => {
    if (!online) return;
    setBusy(true);
    try {
      const [d, s, i, st, ex] = await Promise.all([
        api(`/reports/dashboard?date=${date}`),
        api(`/reports/sales?from=${monthStart()}&to=${todayStr()}`),
        api(`/reports/items?from=${monthStart()}&to=${todayStr()}`),
        api('/reports/stock'),
        api(`/reports/expenses?from=${monthStart()}&to=${todayStr()}`),
      ]);
      setDash(d);
      setSales(s);
      setItems(i);
      setStock(st);
      setExpenses(ex);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [date, notify, online]);

  useEffect(() => {
    load();
  }, [load]);

  async function addExpense() {
    if (!expForm.amount) {
      notify('Enter an amount', 'error');
      return;
    }
    setBusy(true);
    try {
      await api('/reports/expenses', {
        method: 'POST',
        body: {
          category: expForm.category,
          amount: Number(expForm.amount),
          note: expForm.note,
          expense_date: date,
        },
      });
      setExpForm({ category: 'Purchase', amount: '', note: '' });
      notify('Expense recorded', 'ok');
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const summary = dash?.summary;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>Reports</h2>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 150 }} />
      </div>

      <div className="chips">
        {[
          ['today', 'Day'],
          ['items', 'Top items'],
          ['stock', 'Stock'],
          ['expenses', 'Expenses'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={`chip ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>

      {!online ? <div className="empty">Reports need a connection. Bills taken offline stay queued on this device.</div> : null}

      {view === 'today' ? (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span className="k">Sales today</span>
              <span className="v">{money(summary?.revenue)}</span>
            </div>
            <div className="stat">
              <span className="k">Bills</span>
              <span className="v">{summary?.bills ?? 0}</span>
            </div>
            <div className="stat">
              <span className="k">Cash</span>
              <span className="v" style={{ color: 'var(--green)' }}>
                {money(summary?.cash)}
              </span>
            </div>
            <div className="stat">
              <span className="k">UPI</span>
              <span className="v" style={{ color: 'var(--blue)' }}>
                {money(summary?.upi)}
              </span>
            </div>
            <div className="stat">
              <span className="k">Pours sold</span>
              <span className="v">{Math.round(summary?.pours ?? 0)}</span>
            </div>
            <div className="stat">
              <span className="k">Low stock</span>
              <span className="v" style={{ color: 'var(--amber)' }}>
                {summary?.low_stock ?? 0}
              </span>
            </div>
          </div>

          <div className="card">
            <div className="row between">
              <strong className="small">Month to date</strong>
              <span className="tiny muted">
                {sales?.from} → {sales?.to}
              </span>
            </div>
            <div className="row between" style={{ marginTop: 6 }}>
              <span className="muted small">Revenue</span>
              <strong>{money(sales?.totals?.revenue)}</strong>
            </div>
            <div className="row between">
              <span className="muted small">Bills</span>
              <span>{sales?.totals?.bills ?? 0}</span>
            </div>
          </div>

          <div className="card">
            <strong className="small">Recent bills</strong>
            {(dash?.recent || []).length === 0 ? (
              <p className="tiny muted">No bills on this date yet.</p>
            ) : (
              (dash?.recent || []).map((b) => (
                <div className="row between" key={b.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <div>
                    <div className="small">{b.bill_no}</div>
                    <div className="tiny muted">
                      {b.table_label} · {String(b.payment_mode).toUpperCase()} · {b.cashier_name}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong className="small">{money(b.total)}</strong>
                    {!b.deleted_at ? (
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={printingId === b.id}
                        onClick={() => reprint(b.id)}
                      >
                        {printingId === b.id ? '…' : 'Print'}
                      </button>
                    ) : null}
                    {isOwner && b.status === 'paid' && !b.deleted_at ? (
                      <button className="btn btn-sm" type="button" onClick={() => setDeleteTarget(b)}>
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <div className="row between">
              <strong className="small">Deleted bills</strong>
              <span className="tiny muted">{deletions?.totals?.count ?? 0} record(s)</span>
            </div>
            <p className="tiny muted">
              Deleted bills are kept for financial tracking and are not counted as active sales.
            </p>
            {(deletions?.deletions || []).length === 0 ? (
              <p className="tiny muted">No bills have been deleted.</p>
            ) : (
              (deletions?.deletions || []).map((d) => (
                <div key={d.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <div className="row between">
                    <span className="small">{d.bill_no}</span>
                    <strong className="small">{money(d.amount)}</strong>
                  </div>
                  <div className="tiny muted">
                    Bill date {d.bill_date} · deleted by {d.deleted_by_name} on{' '}
                    {String(d.deleted_at).replace('T', ' ').slice(0, 16)}
                    {d.reason ? ` · ${d.reason}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>

          {deleteTarget ? (
            <div className="sheet-backdrop" onClick={closeDelete}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-head">
                  <h3>Delete bill?</h3>
                  <button className="btn btn-sm" type="button" onClick={closeDelete}>
                    ✕
                  </button>
                </div>
                <div className="card" style={{ margin: 0 }}>
                  <div className="row between">
                    <span className="small">{deleteTarget.bill_no}</span>
                    <strong>{money(deleteTarget.total)}</strong>
                  </div>
                  <p className="tiny muted">
                    {deleteTarget.table_label} · {deleteTarget.bill_date} · Only the Owner can delete a bill.
                  </p>
                  <p className="tiny muted">
                    The bill stops counting as a sale, stock is returned and a permanent record is kept.
                  </p>
                  <div className="field">
                    <label htmlFor="ownerpin">Owner PIN</label>
                    <input
                      id="ownerpin"
                      className="input"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder="4–8 digit PIN"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="delreason">Reason (optional)</label>
                    <input
                      id="delreason"
                      className="input"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                  <button
                    className="btn btn-block"
                    type="button"
                    style={{ background: '#b3261e', color: '#fff' }}
                    onClick={confirmDelete}
                    disabled={deleting || pin.trim().length < 4}
                  >
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="card">
            <strong className="small">Last 7 days</strong>
            {(dash?.trend || []).map((t) => {
              const max = Math.max(...(dash?.trend || []).map((x) => x.revenue), 1);
              return (
                <div key={t.date} style={{ marginTop: 6 }}>
                  <div className="row between tiny muted">
                    <span>{t.date}</span>
                    <span>{money(t.revenue)}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--card-2)', borderRadius: 4 }}>
                    <div
                      style={{
                        height: 6,
                        width: `${Math.round((t.revenue / max) * 100)}%`,
                        background: 'var(--amber)',
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {view === 'items' ? (
        <div className="card">
          <strong className="small">Top selling pours (this month)</strong>
          {(items?.items || []).length === 0 ? (
            <p className="tiny muted">No sales yet this month.</p>
          ) : (
            (items?.items || []).map((it, idx) => (
              <div className="row between" key={idx} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div className="small">{it.product_name}</div>
                  <div className="tiny muted">
                    {it.variant_label} · {Math.round(it.qty)} sold
                  </div>
                </div>
                <strong className="small">{money(it.amount)}</strong>
              </div>
            ))
          )}
        </div>
      ) : null}

      {view === 'stock' ? (
        <div className="card">
          <div className="row between">
            <strong className="small">Stock on hand</strong>
            <span className="tiny muted">value {money(stock?.totals?.stock_value)}</span>
          </div>
          <p className="tiny muted">
            {stock?.totals?.products ?? 0} products · {stock?.totals?.low ?? 0} low · {stock?.totals?.out ?? 0} out
          </p>
          {(stock?.stock || []).map((s) => (
            <div className="row between" key={s.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <div>
                <div className="small">{s.name}</div>
                <div className="tiny muted">{s.category_name || '—'}</div>
              </div>
              <span
                className="small"
                style={{ color: s.stock_qty <= 0 ? 'var(--red)' : s.stock_qty <= s.low_stock_qty ? 'var(--amber)' : 'var(--text)' }}
              >
                {Math.floor(s.stock_qty)} {s.unit_type === 'ml' ? 'ml' : 'u'}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view === 'expenses' ? (
        <div className="card">
          <div className="row between">
            <strong className="small">Expenses this month</strong>
            <span className="small">{money(expenses?.total)}</span>
          </div>
          {(expenses?.expenses || []).map((e) => (
            <div className="row between" key={e.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <div>
                <div className="small">{e.category}</div>
                <div className="tiny muted">
                  {e.expense_date} · {e.note || e.spent_by || ''}
                </div>
              </div>
              <span className="small">{money(e.amount)}</span>
            </div>
          ))}
          {canExpense ? (
            <div style={{ marginTop: 10 }}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="ecat">Category</label>
                  <select
                    id="ecat"
                    className="input"
                    value={expForm.category}
                    onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}
                  >
                    {['Purchase', 'Salary', 'Rent', 'Electricity', 'Maintenance', 'Licence', 'Other'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="eamt">Amount</label>
                  <input
                    id="eamt"
                    className="input"
                    type="number"
                    value={expForm.amount}
                    onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="enote">Note</label>
                <input
                  id="enote"
                  className="input"
                  value={expForm.note}
                  onChange={(e) => setExpForm({ ...expForm, note: e.target.value })}
                />
              </div>
              <button className="btn btn-primary btn-block" type="button" onClick={addExpense} disabled={busy || !online}>
                Add expense
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

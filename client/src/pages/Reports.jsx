import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const shift = (days) => {
  const d = new Date(`${todayStr()}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const monthStart = () => `${todayStr().slice(0, 7)}-01`;
const prevMonth = () => {
  const d = new Date(`${monthStart()}T00:00:00`);
  d.setMonth(d.getMonth() - 1);
  const from = d.toISOString().slice(0, 10);
  const end = new Date(`${monthStart()}T00:00:00`);
  end.setDate(0);
  return { from, to: end.toISOString().slice(0, 10) };
};

const RANGES = [
  { id: 'today', label: 'Today', get: () => ({ from: todayStr(), to: todayStr() }) },
  { id: 'yesterday', label: 'Yesterday', get: () => ({ from: shift(-1), to: shift(-1) }) },
  { id: 'week', label: 'Last 7 days', get: () => ({ from: shift(-6), to: todayStr() }) },
  { id: 'month', label: 'This month', get: () => ({ from: monthStart(), to: todayStr() }) },
  { id: 'prev', label: 'Previous month', get: () => prevMonth() },
];

const ALL_TABS = [
  { id: 'daily', label: 'Daily Sales', managerToday: true },
  { id: 'trend', label: 'Date-wise', owner: true },
  { id: 'compare', label: 'Compare', owner: true },
  { id: 'product', label: 'Products', managerToday: true },
  { id: 'liquor', label: 'Liquor', managerToday: true },
  { id: 'stock', label: 'Stock', owner: true },
  { id: 'purchases', label: 'Purchases' },
  { id: 'payments', label: 'Payments', managerToday: true },
  { id: 'tables', label: 'Tables', managerToday: true },
  { id: 'staff', label: 'Staff', managerToday: true },
  { id: 'cancellations', label: 'Cancellations', owner: true },
  { id: 'closing', label: 'Closing', managerToday: true },
  { id: 'pnl', label: 'Profit & Loss', owner: true },
];

const CACHE_PREFIX = 'barflow.report.';

function cacheKey(name, filters) {
  return `${CACHE_PREFIX}${name}:${JSON.stringify(filters)}`;
}

function readCache(name, filters) {
  try {
    const raw = localStorage.getItem(cacheKey(name, filters));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(name, filters, payload) {
  try {
    localStorage.setItem(cacheKey(name, filters), JSON.stringify({ ...payload, cached_at: new Date().toISOString() }));
  } catch {
    /* storage full — ignore */
  }
}

export default function Reports({ notify, online, user }) {
  const isOwner = user?.role === 'owner';
  const isManager = user?.role === 'manager';
  const tabs = useMemo(
    () => ALL_TABS.filter((t) => (t.owner ? isOwner : true)),
    [isOwner],
  );

  const [tab, setTab] = useState('daily');
  const [rangeId, setRangeId] = useState('today');
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [group, setGroup] = useState('day');
  const [filters, setFilters] = useState({ staff_id: '', product_id: '', category_id: '', payment_mode: '' });
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cachedAt, setCachedAt] = useState(null);
  const [bill, setBill] = useState(null);
  const [catalogue, setCatalogue] = useState({ products: [], categories: [], staff: [] });
  const [compare, setCompare] = useState({
    from_a: prevMonth().from,
    to_a: prevMonth().to,
    from_b: monthStart(),
    to_b: todayStr(),
  });
  const [closing, setClosing] = useState({ opening_cash: '', closing_cash: '' });
  const [expenses, setExpenses] = useState(null);
  const [expForm, setExpForm] = useState({ category: 'Purchase', amount: '', note: '' });

  // Managers may only look at today, so pin the range for them.
  useEffect(() => {
    if (isManager) {
      setRangeId('today');
      setFrom(todayStr());
      setTo(todayStr());
    }
  }, [isManager]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api('/products?include_inactive=0');
        if (!alive) return;
        const products = res.products || [];
        const catMap = new Map();
        for (const p of products) if (p.category_id) catMap.set(p.category_id, p.category_name || `Category ${p.category_id}`);
        setCatalogue({ products, categories: [...catMap.entries()].map(([id, name]) => ({ id, name })) });
      } catch {
        /* filters still work without the catalogue */
      }
      try {
        const res = await api('/reports/staff-options');
        if (alive && Array.isArray(res.staff)) setCatalogue((c) => ({ ...c, staff: res.staff }));
      } catch {
        /* optional helper */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const activeFilters = useMemo(
    () => ({ from, to, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')) }),
    [from, to, filters],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (tab === 'compare') {
        const res = await api(`/reports/compare?from_a=${compare.from_a}&to_a=${compare.to_a}&from_b=${compare.from_b}&to_b=${compare.to_b}`);
        setReport(res.report);
        setCachedAt(null);
      } else {
        const qs = new URLSearchParams(activeFilters);
        if (tab === 'trend') qs.set('group', group);
        const res = await api(`/reports/report/${tab}?${qs.toString()}`);
        setReport(res.report);
        setCachedAt(null);
        writeCache(tab, activeFilters, res);
      }
    } catch (err) {
      const cached = readCache(tab, activeFilters);
      if (cached?.report) {
        setReport(cached.report);
        setCachedAt(cached.cached_at);
        setError(err.status === 0 ? 'Offline — showing the last saved snapshot for this period' : err.message);
      } else {
        setReport(null);
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }, [tab, activeFilters, group, compare]);

  useEffect(() => {
    load();
  }, [load]);

  const loadExpenses = useCallback(async () => {
    if (!isOwner) return;
    try {
      const res = await api(`/reports/expenses?from=${from}&to=${to}`);
      setExpenses(res);
    } catch {
      setExpenses(null);
    }
  }, [from, to, isOwner]);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  const applyRange = (id) => {
    const r = RANGES.find((x) => x.id === id);
    if (!r) return;
    const { from: f, to: t } = r.get();
    setRangeId(id);
    setFrom(f);
    setTo(t);
  };

  const columns = report?.columns || [];
  const rows = report?.rows || [];
  const totals = report?.totals || {};

  async function download(format) {
    try {
      const qs = new URLSearchParams({ report: tab, format });
      if (tab === 'compare') {
        Object.entries(compare).forEach(([k, v]) => qs.set(k, v));
      } else {
        Object.entries(activeFilters).forEach(([k, v]) => qs.set(k, v));
        if (tab === 'trend') qs.set('group', group);
      }
      const res = await fetch(`/api/reports/export?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hotel-sagarika-${tab}-${from}_${to}.${format === 'xlsx' ? 'xlsx' : 'pdf'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      notify(`${format.toUpperCase()} downloaded`, 'ok');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function printReport() {
    try {
      const qs = new URLSearchParams({ report: tab, format: 'html' });
      if (tab === 'compare') Object.entries(compare).forEach(([k, v]) => qs.set(k, v));
      else {
        Object.entries(activeFilters).forEach(([k, v]) => qs.set(k, v));
        if (tab === 'trend') qs.set('group', group);
      }
      const res = await fetch(`/api/reports/export?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const html = await res.text();
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      document.body.appendChild(frame);
      frame.contentDocument.open();
      frame.contentDocument.write(html);
      frame.contentDocument.close();
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => frame.remove(), 60000);
      }, 350);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function openBill(row) {
    const billNo = Array.isArray(row) ? row[0] : row?.bill_no;
    if (!billNo) return;
    try {
      const res = await api(`/bills?search=${encodeURIComponent(billNo)}&limit=1`);
      const found = (res.bills || [])[0];
      if (!found) throw new Error('Bill not found');
      setBill(await api(`/bills/${found.id}`));
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function saveClosing() {
    try {
      await api('/reports/cash-session', {
        method: 'POST',
        body: {
          session_date: to,
          opening_cash: closing.opening_cash === '' ? undefined : Number(closing.opening_cash),
          closing_cash: closing.closing_cash === '' ? undefined : Number(closing.closing_cash),
        },
      });
      notify('Cash declaration saved', 'ok');
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function addExpense(e) {
    e.preventDefault();
    try {
      await api('/reports/expenses', {
        method: 'POST',
        body: { expense_date: todayStr(), category: expForm.category, amount: Number(expForm.amount), note: expForm.note },
      });
      setExpForm({ category: 'Purchase', amount: '', note: '' });
      notify('Expense recorded', 'ok');
      loadExpenses();
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  const billRows = report?.data?.bills || [];

  return (
    <div className="page reports-page">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            Hotel Sagarika · {from === to ? from : `${from} → ${to}`}
            {cachedAt ? ' · offline snapshot' : ''}
          </p>
        </div>
      </header>

      <div className="range-bar">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`chip ${rangeId === r.id ? 'active' : ''}`}
            onClick={() => applyRange(r.id)}
            disabled={isManager && r.id !== 'today'}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="filter-grid">
        <label>
          From
          <input type="date" value={from} max={to} disabled={isManager} onChange={(e) => { setFrom(e.target.value); setRangeId('custom'); }} />
        </label>
        <label>
          To
          <input type="date" value={to} min={from} disabled={isManager} onChange={(e) => { setTo(e.target.value); setRangeId('custom'); }} />
        </label>
        <label>
          Staff
          <select value={filters.staff_id} onChange={(e) => setFilters({ ...filters, staff_id: e.target.value })}>
            <option value="">All staff</option>
            {(catalogue.staff || []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select value={filters.category_id} onChange={(e) => setFilters({ ...filters, category_id: e.target.value })}>
            <option value="">All categories</option>
            {catalogue.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select value={filters.product_id} onChange={(e) => setFilters({ ...filters, product_id: e.target.value })}>
            <option value="">All products</option>
            {catalogue.products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label>
          Payment
          <select value={filters.payment_mode} onChange={(e) => setFilters({ ...filters, payment_mode: e.target.value })}>
            <option value="">All methods</option>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="split">Split</option>
          </select>
        </label>
      </div>

      <div className="tab-strip">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={`chip ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'compare' ? (
        <div className="compare-grid">
          <fieldset>
            <legend>Period A</legend>
            <input type="date" value={compare.from_a} onChange={(e) => setCompare({ ...compare, from_a: e.target.value })} />
            <input type="date" value={compare.to_a} onChange={(e) => setCompare({ ...compare, to_a: e.target.value })} />
          </fieldset>
          <fieldset>
            <legend>Period B</legend>
            <input type="date" value={compare.from_b} onChange={(e) => setCompare({ ...compare, from_b: e.target.value })} />
            <input type="date" value={compare.to_b} onChange={(e) => setCompare({ ...compare, to_b: e.target.value })} />
          </fieldset>
        </div>
      ) : null}

      {tab === 'trend' ? (
        <div className="range-bar">
          {['day', 'week', 'month'].map((g) => (
            <button key={g} type="button" className={`chip ${group === g ? 'active' : ''}`} onClick={() => setGroup(g)}>
              {g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      ) : null}

      <div className="report-actions">
        <button type="button" className="btn ghost" onClick={printReport} disabled={!report}>Print</button>
        <button type="button" className="btn ghost" onClick={() => download('xlsx')} disabled={!report}>Excel (.xlsx)</button>
        <button type="button" className="btn ghost" onClick={() => download('pdf')} disabled={!report}>PDF</button>
        <button type="button" className="btn ghost" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
      </div>

      {error ? <p className={`note ${cachedAt ? 'warn' : 'error'}`}>{error}</p> : null}

      {report ? (
        <>
          <section className="report-card">
            <h2>{report.title}</h2>
            {report.subtitle ? <p className="muted">{report.subtitle}</p> : null}
            {Object.keys(totals).length ? (
              <div className="stat-grid">
                {Object.entries(totals).map(([k, v]) => (
                  <div className="stat" key={k}>
                    <span>{k.replace(/_/g, ' ')}</span>
                    <strong>{typeof v === 'number' ? money(v) : String(v)}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="table-wrap">
              <table className="report-table">
                <thead>
                  <tr>{columns.map((c, i) => <th key={i}>{Array.isArray(c) ? c[0] : c}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={Math.max(columns.length, 1)} className="muted">No records for this selection.</td></tr>
                  ) : (
                    rows.map((row, ri) => (
                      <tr
                        key={ri}
                        className={tab === 'daily' && Array.isArray(row) ? 'clickable' : ''}
                        onClick={tab === 'daily' && Array.isArray(row) ? () => openBill(row) : undefined}
                      >
                        {(Array.isArray(row) ? row : [row]).map((cell, ci) => <td key={ci}>{cell}</td>)}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {report.note ? <p className="note">{report.note}</p> : null}
          </section>

          {tab === 'daily' && billRows.length ? (
            <section className="report-card">
              <h2>Bills in this period</h2>
              <div className="table-wrap">
                <table className="report-table">
                  <thead>
                    <tr><th>Bill</th><th>Time</th><th>Table</th><th>Cashier</th><th>Method</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {billRows.map((b) => (
                      <tr key={b.bill_no || b.id} className="clickable" onClick={() => openBill({ bill_no: b.bill_no })}>
                        <td>{b.bill_no}</td>
                        <td>{(b.bill_time || b.created_at || '').slice(11, 16) || b.bill_date}</td>
                        <td>{b.table_label || '—'}</td>
                        <td>{b.cashier_name || '—'}</td>
                        <td>{b.payment_mode}</td>
                        <td>{money(b.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {tab === 'closing' && ['owner', 'manager'].includes(user?.role) ? (
            <section className="report-card">
              <h2>Cash declaration</h2>
              <div className="filter-grid">
                <label>
                  Opening cash
                  <input type="number" inputMode="decimal" value={closing.opening_cash} onChange={(e) => setClosing({ ...closing, opening_cash: e.target.value })} />
                </label>
                <label>
                  Closing cash
                  <input type="number" inputMode="decimal" value={closing.closing_cash} onChange={(e) => setClosing({ ...closing, closing_cash: e.target.value })} />
                </label>
              </div>
              <button type="button" className="btn" onClick={saveClosing}>Save for {to}</button>
            </section>
          ) : null}
        </>
      ) : null}

      {isOwner && ['pnl', 'daily', 'stock'].includes(tab) ? (
        <section className="report-card">
          <h2>Operating expenses</h2>
          <form className="filter-grid" onSubmit={addExpense}>
            <label>
              Category
              <select value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}>
                {['Purchase', 'Salary', 'Rent', 'Electricity', 'Maintenance', 'Transport', 'Other'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <input type="number" inputMode="decimal" required value={expForm.amount} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} />
            </label>
            <label>
              Note
              <input type="text" value={expForm.note} onChange={(e) => setExpForm({ ...expForm, note: e.target.value })} />
            </label>
            <button type="submit" className="btn">Add expense</button>
          </form>
          {expenses?.expenses?.length ? (
            <div className="table-wrap">
              <table className="report-table">
                <thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Amount</th></tr></thead>
                <tbody>
                  {expenses.expenses.map((x) => (
                    <tr key={x.id}><td>{x.expense_date}</td><td>{x.category}</td><td>{x.note || '—'}</td><td>{money(x.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No expenses recorded for this period.</p>
          )}
        </section>
      ) : null}

      {bill ? (
        <div className="modal" onClick={() => setBill(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Bill {bill.bill?.bill_no || bill.bill_no}</h2>
              <button type="button" className="icon" onClick={() => setBill(null)}>✕</button>
            </header>
            <p className="muted">
              {(bill.bill?.bill_date || bill.bill_date)} · {bill.bill?.table_label || bill.bill?.table_label || '—'} ·{' '}
              {bill.bill?.payment_mode || bill.bill?.payment_mode}
            </p>
            <div className="table-wrap">
              <table className="report-table">
                <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
                <tbody>
                  {(bill.items || []).map((it, i) => (
                    <tr key={i}>
                      <td>{it.product_name || it.name}{it.variant_label ? ` · ${it.variant_label}` : ''}</td>
                      <td>{it.qty}</td>
                      <td>{money(it.unit_price)}</td>
                      <td>{money(it.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="total-line">Total <strong>{money(bill.bill?.total ?? bill.total)}</strong></p>
          </div>
        </div>
      ) : null}

      {!online ? <p className="note warn">Offline — reports show the last snapshot saved on this device.</p> : null}
    </div>
  );
}

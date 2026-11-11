import React, { useMemo, useState } from 'react';
import { api, enqueue, uuid } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const BOTTLE_ML = 180;
// Liquor stock is held in sealed 180 ml bottles; pours consume a fraction of one.
const bottlesOf = (p) =>
  Number(p.stock_bottles ?? (p.unit_type === 'ml' ? Number(p.stock_qty) / BOTTLE_ML : Number(p.stock_qty))) || 0;
const bottleText = (p) => {
  const total = bottlesOf(p);
  const sealed = Math.floor(total + 1e-9);
  const loose = Math.round((total - sealed) * BOTTLE_ML);
  return `${total.toFixed(2)} bottles left (${sealed} sealed${loose ? `, ${loose} ml loose` : ''})`;
};

export default function Billing({ data, settings, user, online, notify, refresh, activeTab, setActiveTab }) {
  const products = data?.products || [];
  const categories = data?.categories || [];
  const tables = data?.tables || [];
  const taxPercent = Number(settings?.tax_percent ?? 5);

  const [categoryId, setCategoryId] = useState('all');
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState(null); // { product, variantId, qty }
  const [cart, setCart] = useState([]);
  const [tableId, setTableId] = useState('');
  const [sheet, setSheet] = useState(null); // 'cart' | 'receipt'
  const [mode, setMode] = useState('cash');
  const [discount, setDiscount] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (categoryId !== 'all' && String(p.category_id) !== String(categoryId)) return false;
      if (!q) return true;
      return `${p.name} ${p.brand || ''} ${p.category_name || ''}`.toLowerCase().includes(q);
    });
  }, [products, categoryId, search]);

  const lines = activeTab
    ? activeTab.items.map((i) => ({
        key: `item-${i.id}`,
        itemId: i.id,
        product_id: i.product_id,
        variant_id: i.variant_id,
        name: i.product_name,
        variant_label: i.variant_label,
        unit_price: i.unit_price,
        qty: i.qty,
      }))
    : cart;

  const subtotal = r2(lines.reduce((s, l) => s + l.unit_price * l.qty, 0));
  const disc = Math.min(r2(Number(discount) || 0), subtotal);
  const taxable = r2(subtotal - disc);
  const taxAmount = r2((taxable * taxPercent) / 100);
  const total = Math.round(r2(taxable + taxAmount));
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const change = mode === 'cash' ? r2((Number(cashReceived) || 0) - total) : 0;

  function stockLabel(product, variant) {
    if (product.unit_type === 'ml') {
      const serves = variant.consume_qty > 0 ? Math.floor((bottlesOf(product) * BOTTLE_ML) / variant.consume_qty) : 0;
      return `${serves} left`;
    }
    return `${Math.floor(bottlesOf(product))} left`;
  }

  function openProduct(product) {
    const firstInStock =
      product.variants.find((v) => bottlesOf(product) * BOTTLE_ML >= (v.consume_qty || 0)) || product.variants[0];
    setPick({ product, variantId: firstInStock?.id, qty: 1 });
  }

  async function addToTab(product, variant, qty) {
    if (!online) {
      notify('Running tabs need a connection — use a quick bill instead', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await api(`/orders/${activeTab.id}/items`, {
        method: 'POST',
        body: { product_id: product.id, variant_id: variant.id, qty },
      });
      setActiveTab(res.order);
      setPick(null);
      notify(`${product.name} ${variant.label} added to tab`, 'ok');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function addToCart(product, variant, qty) {
    setCart((prev) => {
      const found = prev.find((l) => l.variant_id === variant.id);
      if (found) {
        return prev.map((l) => (l.variant_id === variant.id ? { ...l, qty: r2(l.qty + qty) } : l));
      }
      return [
        ...prev,
        {
          key: `cart-${variant.id}-${Date.now()}`,
          product_id: product.id,
          variant_id: variant.id,
          name: product.name,
          variant_label: variant.label,
          unit_price: variant.price,
          qty,
        },
      ];
    });
    setPick(null);
  }

  async function changeTabQty(line, nextQty) {
    setBusy(true);
    try {
      if (nextQty <= 0) {
        await api(`/orders/${activeTab.id}/items/${line.itemId}`, { method: 'DELETE' });
      } else {
        const res = await api(`/orders/${activeTab.id}/items/${line.itemId}`, {
          method: 'PATCH',
          body: { qty: nextQty },
        });
        setActiveTab(res.order);
        setBusy(false);
        return;
      }
      const res = await api(`/orders/${activeTab.id}`);
      setActiveTab(res.order);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function changeCartQty(line, nextQty) {
    if (nextQty <= 0) setCart((prev) => prev.filter((l) => l.key !== line.key));
    else setCart((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty: r2(nextQty) } : l)));
  }

  function buildPayload() {
    return {
      client_uuid: uuid(),
      table_id: tableId ? Number(tableId) : null,
      table_label: tableId ? tables.find((t) => String(t.id) === String(tableId))?.label : 'Counter',
      items: cart.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: l.qty })),
      payment_mode: mode,
      discount: disc,
      cash_received: mode === 'cash' ? Number(cashReceived) || total : total,
      upi_ref: mode === 'upi' ? upiRef || null : null,
      customer_name: customerName || null,
      customer_phone: customerPhone || null,
      device_id: localStorage.getItem('barflow.device.v1') || 'web',
      paid_at: new Date().toISOString(),
    };
  }

  function localReceipt(payload, billNo, offline) {
    return {
      bill_no: billNo,
      total,
      subtotal,
      discount: disc,
      tax_amount: taxAmount,
      tax_percent: taxPercent,
      payment_mode: mode,
      cash_received: payload.cash_received,
      change_returned: change > 0 ? change : 0,
      items: lines.map((l) => ({ name: l.name, variant_label: l.variant_label, qty: l.qty, line_total: r2(l.unit_price * l.qty) })),
      cashier_name: user?.name,
      table_label: payload.table_label,
      created_at: new Date().toISOString(),
      offline,
    };
  }

  async function pay() {
    if (lines.length === 0) {
      notify('Add at least one item', 'error');
      return;
    }
    setBusy(true);
    try {
      if (activeTab) {
        const res = await api(`/orders/${activeTab.id}/pay`, {
          method: 'POST',
          body: {
            payment_mode: mode,
            discount: disc,
            cash_received: mode === 'cash' ? Number(cashReceived) || total : total,
            upi_ref: mode === 'upi' ? upiRef : null,
            customer_name: customerName || null,
            customer_phone: customerPhone || null,
            device_id: localStorage.getItem('barflow.device.v1') || 'web',
          },
        });
        setReceipt(res.bill);
        setActiveTab(null);
        setSheet('receipt');
        resetAfterSale();
        await refresh();
        return;
      }

      const payload = buildPayload();
      try {
        const res = await api('/bills', { method: 'POST', body: payload });
        setReceipt(res.bill);
        if (res.warnings?.length) notify(res.warnings[0], 'error');
        setSheet('receipt');
        resetAfterSale();
        await refresh();
      } catch (err) {
        if (!err.network) throw err;
        enqueue('bill', payload);
        setReceipt(localReceipt(payload, 'OFFLINE', true));
        setSheet('receipt');
        resetAfterSale();
        notify('Saved on this device — it will sync automatically', 'ok');
      }
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function resetAfterSale() {
    setCart([]);
    setDiscount('');
    setCashReceived('');
    setUpiRef('');
    setCustomerName('');
    setCustomerPhone('');
    setTableId('');
  }

  return (
    <div>
      {activeTab ? (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <div className="row between">
            <div>
              <div className="small muted">Running tab</div>
              <strong>
                {activeTab.table_label || activeTab.table_zone || 'Table'} · {activeTab.order_no}
              </strong>
            </div>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                setActiveTab(null);
                notify('Switched to quick bill');
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      <div className="chips" style={{ marginTop: activeTab ? 10 : 0 }}>
        <input
          className="input"
          placeholder="Search drink, brand…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 150 }}
        />
      </div>

      <div className="chips">
        <button className={`chip ${categoryId === 'all' ? 'active' : ''}`} type="button" onClick={() => setCategoryId('all')}>
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip ${String(categoryId) === String(c.id) ? 'active' : ''}`}
            onClick={() => setCategoryId(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty">No drinks match this filter.</div>
      ) : (
        <div className="product-grid">
          {visible.map((p) => {
            const cheapest = p.variants.reduce((m, v) => (m === null || v.price < m ? v.price : m), null);
            const low = p.stock_qty <= p.low_stock_qty;
            const out = p.stock_qty <= 0;
            return (
              <button key={p.id} type="button" className="product-card" onClick={() => openProduct(p)}>
                <span className="pcat" style={{ color: p.category_color || 'var(--muted)' }}>
                  {p.category_name || 'Bar'}
                </span>
                <span className="pname">{p.name}</span>
                <span className="pprice">{cheapest === null ? '—' : `from ${money(cheapest)}`}</span>
                <span className={`stock-line ${out ? 'out' : low ? 'low' : ''}`}>
                  {out ? 'Out of stock' : `${Math.floor(p.stock_qty)} ${p.unit_type === 'ml' ? 'ml' : 'units'} left`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ height: 74 }} />

      <div className="cart-bar">
        <div className="cart-bar-inner">
          <div>
            <div className="amount">{money(total)}</div>
            <div className="tiny muted">
              {itemCount} item{itemCount === 1 ? '' : 's'}
              {disc > 0 ? ` · ₹${disc} off` : ''}
            </div>
          </div>
          <div className="spacer" />
          <button
            className="btn btn-primary"
            type="button"
            disabled={lines.length === 0}
            onClick={() => setSheet('cart')}
          >
            {activeTab ? 'Settle tab' : 'Review & pay'}
          </button>
        </div>
      </div>

      {pick ? (
        <div className="sheet-backdrop" onClick={() => setPick(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div>
                <h3>{pick.product.name}</h3>
                <div className="tiny muted">
                  {pick.product.category_name} · {pick.product.unit_type === 'ml' ? bottleText(pick.product) : `${Math.floor(bottlesOf(pick.product))} units in stock`}
                </div>
              </div>
              <button className="btn btn-sm" type="button" onClick={() => setPick(null)}>
                ✕
              </button>
            </div>

            <div className="tiny muted" style={{ marginBottom: 6 }}>
              Serving size
            </div>
            <div className="pour-grid">
              {pick.product.variants.map((v) => {
                const out = pick.product.unit_type === 'ml' ? bottlesOf(pick.product) * BOTTLE_ML < v.consume_qty : bottlesOf(pick.product) < 1;
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={`pour ${pick.variantId === v.id ? 'active' : ''}`}
                    onClick={() => setPick({ ...pick, variantId: v.id })}
                  >
                    <span className="ml">{v.ml ? `${v.ml} ml` : v.label}</span>
                    <span className="amt">{money(v.price)}</span>
                    <span className="stk" style={out ? { color: 'var(--red)' } : undefined}>
                      {out ? 'no stock' : stockLabel(pick.product, v)}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="row between" style={{ marginTop: 16 }}>
              <div className="row">
                <div className="qty">
                  <button type="button" onClick={() => setPick({ ...pick, qty: Math.max(1, pick.qty - 1) })}>
                    −
                  </button>
                  <span>{pick.qty}</span>
                  <button type="button" onClick={() => setPick({ ...pick, qty: pick.qty + 1 })}>
                    +
                  </button>
                </div>
                <span className="small muted">
                  {money(
                    (pick.product.variants.find((v) => v.id === pick.variantId)?.price || 0) * pick.qty,
                  )}
                </span>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  const variant = pick.product.variants.find((v) => v.id === pick.variantId);
                  if (!variant) return;
                  if (activeTab) addToTab(pick.product, variant, pick.qty);
                  else addToCart(pick.product, variant, pick.qty);
                }}
              >
                {activeTab ? 'Add to tab' : 'Add to bill'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sheet === 'cart' ? (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div>
                <h3>{activeTab ? 'Settle tab' : 'Current bill'}</h3>
                <div className="tiny muted">
                  {itemCount} item{itemCount === 1 ? '' : 's'} · {online ? 'online' : 'offline'}
                </div>
              </div>
              <button className="btn btn-sm" type="button" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>

            {lines.length === 0 ? (
              <div className="empty">Bill is empty.</div>
            ) : (
              lines.map((l) => (
                <div className="line-item" key={l.key}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small" style={{ fontWeight: 650 }}>
                      {l.name}
                    </div>
                    <div className="tiny muted">
                      {l.variant_label} · {money(l.unit_price)}
                    </div>
                  </div>
                  <div className="qty">
                    <button
                      type="button"
                      onClick={() =>
                        activeTab ? changeTabQty(l, l.qty - 1) : changeCartQty(l, l.qty - 1)
                      }
                    >
                      −
                    </button>
                    <span>{l.qty}</span>
                    <button
                      type="button"
                      onClick={() =>
                        activeTab ? changeTabQty(l, l.qty + 1) : changeCartQty(l, l.qty + 1)
                      }
                    >
                      +
                    </button>
                  </div>
                  <div className="small" style={{ width: 62, textAlign: 'right', fontWeight: 700 }}>
                    {money(l.unit_price * l.qty)}
                  </div>
                </div>
              ))
            )}

            {!activeTab ? (
              <div className="grid-2" style={{ marginTop: 12 }}>
                <div className="field">
                  <label htmlFor="table">Table (optional)</label>
                  <select id="table" className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}>
                    <option value="">Counter / parcel</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · {t.zone}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="discount">Discount ₹</label>
                  <input
                    id="discount"
                    className="input"
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>
            ) : (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="discount2">Discount ₹</label>
                <input
                  id="discount2"
                  className="input"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="0"
                />
              </div>
            )}

            <div className="totals">
              <div className="row">
                <span className="muted">Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              {disc > 0 ? (
                <div className="row">
                  <span className="muted">Discount</span>
                  <span>−{money(disc)}</span>
                </div>
              ) : null}
              <div className="row">
                <span className="muted">GST {taxPercent}%</span>
                <span>{money(taxAmount)}</span>
              </div>
              <div className="row grand">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
            </div>

            <div className="tiny muted" style={{ marginBottom: 6 }}>
              Payment mode
            </div>
            <div className="seg">
              <button type="button" className={mode === 'cash' ? 'active' : ''} onClick={() => setMode('cash')}>
                💵 Cash
              </button>
              <button type="button" className={mode === 'upi' ? 'active' : ''} onClick={() => setMode('upi')}>
                📱 UPI
              </button>
              <button type="button" className={mode === 'card' ? 'active' : ''} onClick={() => setMode('card')}>
                💳 Card
              </button>
            </div>

            {mode === 'cash' ? (
              <div className="grid-2" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="cash">Cash received</label>
                  <input
                    id="cash"
                    className="input"
                    type="number"
                    inputMode="decimal"
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder={String(total)}
                  />
                </div>
                <div className="field">
                  <label>Change</label>
                  <div className="input" style={{ borderStyle: 'dashed' }}>
                    {money(change > 0 ? change : 0)}
                  </div>
                </div>
              </div>
            ) : null}

            {mode === 'upi' ? (
              <div style={{ marginTop: 10 }}>
                {settings?.upi_id ? (
                  <div className="card" style={{ marginBottom: 8, textAlign: 'center' }}>
                    <div className="tiny muted">Collect UPI payment to</div>
                    <div style={{ fontWeight: 750, fontSize: 15 }}>{settings.upi_id}</div>
                    <div className="tiny muted">Amount {money(total)}</div>
                  </div>
                ) : (
                  <div className="tiny muted" style={{ marginBottom: 8 }}>
                    Set your UPI ID in More → Settings to show it on the payment screen.
                  </div>
                )}
                <div className="field">
                  <label htmlFor="upiref">UPI reference (optional)</label>
                  <input
                    id="upiref"
                    className="input"
                    value={upiRef}
                    onChange={(e) => setUpiRef(e.target.value)}
                    placeholder="UTR / txn id"
                  />
                </div>
              </div>
            ) : null}

            <div className="grid-2" style={{ marginTop: 4 }}>
              <div className="field">
                <label htmlFor="cname">Customer (optional)</label>
                <input id="cname" className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cphone">Phone</label>
                <input
                  id="cphone"
                  className="input"
                  inputMode="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </div>
            </div>

            <button
              className="btn btn-green btn-block"
              type="button"
              disabled={busy || lines.length === 0}
              onClick={pay}
            >
              {busy ? 'Saving…' : `Pay ${money(total)} by ${mode.toUpperCase()}`}
            </button>
            <p className="tiny muted" style={{ textAlign: 'center', marginBottom: 0 }}>
              Stock is deducted automatically when the bill is saved.
            </p>
          </div>
        </div>
      ) : null}

      {sheet === 'receipt' && receipt ? (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>{receipt.offline ? 'Saved offline' : 'Bill saved'}</h3>
              <button className="btn btn-sm" type="button" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>
            <div className="receipt">
              <h3>{settings.hotel_name || 'HOTEL SAGARIKA'}</h3>
              {settings.address ? <div style={{ textAlign: 'center' }}>{settings.address}</div> : null}
              {settings.gstin ? <div style={{ textAlign: 'center' }}>GSTIN {settings.gstin}</div> : null}
              <div className="sep" />
              <div className="r-row">
                <span>{receipt.bill_no}</span>
                <span>{new Date(receipt.created_at || Date.now()).toLocaleString()}</span>
              </div>
              <div className="r-row">
                <span>Table: {receipt.table_label || 'Counter'}</span>
                <span>By {receipt.cashier_name || user?.name}</span>
              </div>
              <div className="sep" />
              {(receipt.items || []).map((i, idx) => (
                <div className="r-row" key={idx}>
                  <span>
                    {i.product_name || i.name} {i.variant_label} × {i.qty}
                  </span>
                  <span>{money(i.line_total)}</span>
                </div>
              ))}
              <div className="sep" />
              <div className="r-row">
                <span>Subtotal</span>
                <span>{money(receipt.subtotal)}</span>
              </div>
              {Number(receipt.discount) > 0 ? (
                <div className="r-row">
                  <span>Discount</span>
                  <span>−{money(receipt.discount)}</span>
                </div>
              ) : null}
              <div className="r-row">
                <span>GST {receipt.tax_percent}%</span>
                <span>{money(receipt.tax_amount)}</span>
              </div>
              <div className="r-row r-total">
                <span>TOTAL</span>
                <span>{money(receipt.total)}</span>
              </div>
              <div className="r-row">
                <span>Paid by</span>
                <span>{String(receipt.payment_mode || '').toUpperCase()}</span>
              </div>
              {Number(receipt.change_returned) > 0 ? (
                <div className="r-row">
                  <span>Change</span>
                  <span>{money(receipt.change_returned)}</span>
                </div>
              ) : null}
              <div className="sep" />
              <div style={{ textAlign: 'center' }}>
                {settings.invoice_footer || 'Thank you, visit again!'}
              </div>
            </div>
            {receipt.offline ? (
              <p className="tiny" style={{ color: 'var(--amber)' }}>
                This bill is stored on this device and will be uploaded when the connection returns.
              </p>
            ) : null}
            <button className="btn btn-primary btn-block" type="button" onClick={() => setSheet(null)}>
              New bill
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import { api } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const POURS = [30, 60, 90, 120, 150, 180];

export default function Products({ data, user, notify, refresh, online }) {
  const products = data?.products || [];
  const categories = data?.categories || [];
  const canManage = ['owner', 'manager'].includes(user?.role);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [edit, setEdit] = useState(null);
  const [stockFor, setStockFor] = useState(null);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filter === 'low' && !(p.stock_qty <= p.low_stock_qty)) return false;
      if (filter === 'out' && p.stock_qty > 0) return false;
      if (!q) return true;
      return `${p.name} ${p.brand || ''} ${p.category_name || ''}`.toLowerCase().includes(q);
    });
  }, [products, search, filter]);

  const lowCount = products.filter((p) => p.stock_qty <= p.low_stock_qty).length;

  function newProduct() {
    setEdit({
      id: null,
      name: '',
      brand: '',
      category_id: categories[0]?.id || '',
      unit_type: 'ml',
      bottle_size_ml: 750,
      stock_qty: 0,
      low_stock_qty: 1500,
      cost_price: 0,
      peg_price: 60,
      variants: POURS.map((ml) => ({ ml, label: `${ml} ml`, price: Math.round((60 * ml) / 3) / 10 })),
    });
  }

  function editProduct(p) {
    setEdit({
      id: p.id,
      name: p.name,
      brand: p.brand || '',
      category_id: p.category_id || '',
      unit_type: p.unit_type,
      bottle_size_ml: p.bottle_size_ml || '',
      stock_qty: p.stock_qty,
      low_stock_qty: p.low_stock_qty,
      cost_price: p.cost_price,
      variants: p.variants.map((v) => ({ ml: v.ml, label: v.label, price: v.price, consume_qty: v.consume_qty })),
    });
  }

  async function save() {
    if (!edit.name.trim()) {
      notify('Product name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: edit.name,
        brand: edit.brand,
        category_id: edit.category_id || null,
        unit_type: edit.unit_type,
        bottle_size_ml: edit.bottle_size_ml ? Number(edit.bottle_size_ml) : null,
        low_stock_qty: Number(edit.low_stock_qty) || 0,
        cost_price: Number(edit.cost_price) || 0,
        variants: edit.variants.map((v) => ({
          label: v.label || `${v.ml} ml`,
          ml: Number(v.ml) || 0,
          consume_qty: Number(v.consume_qty ?? v.ml) || 1,
          price: Number(v.price) || 0,
        })),
      };
      if (edit.id) await api(`/products/${edit.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body: { ...body, stock_qty: Number(edit.stock_qty) || 0 } });
      notify(edit.id ? 'Product updated' : 'Product added', 'ok');
      setEdit(null);
      await refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveStock() {
    setBusy(true);
    try {
      await api(`/products/${stockFor.product.id}/stock`, {
        method: 'POST',
        body: {
          change_qty: Number(stockFor.change),
          movement: stockFor.movement,
          note: stockFor.note,
        },
      });
      notify('Stock updated', 'ok');
      setStockFor(null);
      await refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addCategory() {
    const name = window.prompt('New category name');
    if (!name) return;
    try {
      await api('/categories', { method: 'POST', body: { name } });
      notify('Category added', 'ok');
      await refresh();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19 }}>Products & stock</h2>
        <span className="tiny muted">{lowCount} low</span>
      </div>

      <input
        className="input"
        placeholder="Search products"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div className="chips">
        {[
          ['all', 'All'],
          ['low', 'Low stock'],
          ['out', 'Out of stock'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={`chip ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      {canManage ? (
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-primary btn-sm" type="button" onClick={newProduct} disabled={!online}>
            + Product
          </button>
          <button className="btn btn-sm" type="button" onClick={addCategory} disabled={!online}>
            + Category
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? <div className="empty">No products found.</div> : null}

      {shown.map((p) => {
        const low = p.stock_qty <= p.low_stock_qty;
        return (
          <div className="card" key={p.id}>
            <div className="row between">
              <div style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                <div className="tiny muted">
                  {p.category_name || 'Uncategorised'}
                  {p.brand ? ` · ${p.brand}` : ''} · {p.unit_type === 'ml' ? 'liquor' : 'unit'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 750, color: low ? 'var(--amber)' : 'var(--text)' }}>
                  {Math.floor(p.stock_qty)} {p.unit_type === 'ml' ? 'ml' : 'u'}
                </div>
                <div className="tiny muted">min {Math.floor(p.low_stock_qty)}</div>
              </div>
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              {p.variants.map((v) => `${v.ml ? `${v.ml}ml` : v.label} ${money(v.price)}`).join('  ·  ')}
            </div>
            {canManage ? (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-sm" type="button" onClick={() => editProduct(p)} disabled={!online}>
                  Edit
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setStockFor({ product: p, change: '', movement: 'purchase', note: '' })}
                  disabled={!online}
                >
                  Stock in/out
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      {edit ? (
        <div className="sheet-backdrop" onClick={() => setEdit(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>{edit.id ? 'Edit product' : 'New product'}</h3>
              <button className="btn btn-sm" type="button" onClick={() => setEdit(null)}>
                ✕
              </button>
            </div>
            <div className="field">
              <label htmlFor="pname">Name</label>
              <input
                id="pname"
                className="input"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="e.g. Royal Stag"
              />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="pbrand">Brand</label>
                <input id="pbrand" className="input" value={edit.brand} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pcat">Category</label>
                <select
                  id="pcat"
                  className="input"
                  value={edit.category_id}
                  onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}
                >
                  <option value="">None</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="punit">Sold by</label>
                <select
                  id="punit"
                  className="input"
                  value={edit.unit_type}
                  onChange={(e) => setEdit({ ...edit, unit_type: e.target.value })}
                >
                  <option value="ml">Liquor (ml pours)</option>
                  <option value="unit">Unit (bottle/plate)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="pbottle">Bottle size (ml)</label>
                <input
                  id="pbottle"
                  className="input"
                  type="number"
                  value={edit.bottle_size_ml}
                  onChange={(e) => setEdit({ ...edit, bottle_size_ml: e.target.value })}
                />
              </div>
            </div>
            {!edit.id ? (
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="pstock">Opening stock</label>
                  <input
                    id="pstock"
                    className="input"
                    type="number"
                    value={edit.stock_qty}
                    onChange={(e) => setEdit({ ...edit, stock_qty: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="pcost">Cost price</label>
                  <input
                    id="pcost"
                    className="input"
                    type="number"
                    value={edit.cost_price}
                    onChange={(e) => setEdit({ ...edit, cost_price: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="plow">Low stock alert (ml/units)</label>
                <input
                  id="plow"
                  className="input"
                  type="number"
                  value={edit.low_stock_qty}
                  onChange={(e) => setEdit({ ...edit, low_stock_qty: e.target.value })}
                />
              </div>
            )}

            <div className="tiny muted" style={{ marginTop: 8 }}>
              Pour sizes and prices
            </div>
            {edit.variants.map((v, i) => (
              <div className="row" key={`${v.ml}-${i}`} style={{ marginBottom: 6 }}>
                <span className="small" style={{ width: 64 }}>
                  {v.ml ? `${v.ml} ml` : v.label}
                </span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  value={v.price}
                  onChange={(e) => {
                    const next = [...edit.variants];
                    next[i] = { ...next[i], price: e.target.value };
                    setEdit({ ...edit, variants: next });
                  }}
                  placeholder="price"
                />
              </div>
            ))}

            <button className="btn btn-primary btn-block" type="button" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save product'}
            </button>
          </div>
        </div>
      ) : null}

      {stockFor ? (
        <div className="sheet-backdrop" onClick={() => setStockFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>Stock movement</h3>
              <button className="btn btn-sm" type="button" onClick={() => setStockFor(null)}>
                ✕
              </button>
            </div>
            <p className="small muted">
              {stockFor.product.name} — current {Math.floor(stockFor.product.stock_qty)}{' '}
              {stockFor.product.unit_type === 'ml' ? 'ml' : 'units'}
            </p>
            <div className="field">
              <label htmlFor="qty">Quantity to add (use minus to remove)</label>
              <input
                id="qty"
                className="input"
                type="number"
                value={stockFor.change}
                onChange={(e) => setStockFor({ ...stockFor, change: e.target.value })}
                placeholder={stockFor.product.unit_type === 'ml' ? 'e.g. 750' : 'e.g. 12'}
              />
            </div>
            <div className="field">
              <label htmlFor="movement">Reason</label>
              <select
                id="movement"
                className="input"
                value={stockFor.movement}
                onChange={(e) => setStockFor({ ...stockFor, movement: e.target.value })}
              >
                <option value="purchase">Purchase / stock in</option>
                <option value="adjustment">Adjustment</option>
                <option value="wastage">Wastage / breakage</option>
                <option value="return">Return</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="note">Note</label>
              <input
                id="note"
                className="input"
                value={stockFor.note}
                onChange={(e) => setStockFor({ ...stockFor, note: e.target.value })}
              />
            </div>
            <button className="btn btn-primary btn-block" type="button" onClick={saveStock} disabled={busy}>
              Save movement
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

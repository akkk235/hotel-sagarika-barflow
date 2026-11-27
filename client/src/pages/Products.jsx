import React, { useMemo, useState } from 'react';
import { api } from '../api.js';

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const POURS = [30, 60, 90, 120, 150, 180];
const BOTTLE_ML = 180;
const BEER_SIZES = [650, 500, 330];

/** Loose pour = (bottle price / 180) × ml + ₹5, rounded UP to the next ₹5. 180 ml stays as entered. */
const roundUpToFive = (v) => {
  const n = Number(v) || 0;
  if (n <= 0) return 0;
  return Math.ceil((n - 1e-9) / 5) * 5;
};
const servePrice = (bottlePrice, ml) => {
  const share = ((Number(bottlePrice) || 0) / BOTTLE_ML) * ml;
  if (share <= 0) return 0;
  return Number(ml) === BOTTLE_ML ? roundUpToFive(share) : roundUpToFive(share + 5);
};

const bottlesOf = (p) =>
  Number(p.stock_bottles ?? (p.unit_type === 'ml' ? Number(p.stock_qty) / BOTTLE_ML : Number(p.stock_qty))) || 0;
const unitsOf = (p) => (p.unit_type === 'ml' ? bottlesOf(p) : Number(p.stock_qty) || 0);
const isLow = (p) => unitsOf(p) <= Number(p.low_stock_qty || 0);
const bottleLabel = (p) => {
  const total = bottlesOf(p);
  const sealed = Math.floor(total + 1e-9);
  const loose = Math.round((total - sealed) * BOTTLE_ML);
  return { total: total.toFixed(2), sealed, loose };
};

/** Beer: every bottle size is its own product row with its own stock. */
const isBeer = (p) => p?.stock_mode === 'variant';
const variantStock = (v) => Math.floor(Number(v?.stock_qty) || 0);
const modeOf = (p) => (p.unit_type === 'ml' ? 'liquor' : isBeer(p) ? 'beer' : 'unit');

function beerRow(ml = '') {
  return { ml, label: ml ? `${ml} ml` : '', price: '', cost_price: '', stock_qty: '' };
}

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
      if (filter === 'low' && !isLow(p)) return false;
      if (filter === 'out' && unitsOf(p) > 0) return false;
      if (filter === 'beer' && !isBeer(p)) return false;
      if (filter === 'liquor' && p.unit_type !== 'ml') return false;
      if (!q) return true;
      return `${p.name} ${p.brand || ''} ${p.category_name || ''}`.toLowerCase().includes(q);
    });
  }, [products, search, filter]);

  const lowCount = products.filter(isLow).length;

  function newProduct(mode = 'liquor') {
    setEdit({
      id: null,
      mode,
      name: '',
      brand: '',
      category_id: categories[0]?.id || '',
      unit_type: mode === 'liquor' ? 'ml' : 'unit',
      bottle_size_ml: 180,
      stock_qty: 0,
      low_stock_qty: 2,
      cost_price: 0,
      bottle_price: 300,
      variants:
        mode === 'beer'
          ? BEER_SIZES.map((ml) => beerRow(ml))
          : mode === 'unit'
            ? [{ label: 'Bottle', ml: 0, price: '', stock_qty: '' }]
            : [],
    });
  }

  function editProduct(p) {
    const mode = modeOf(p);
    setEdit({
      id: p.id,
      mode,
      name: p.name,
      brand: p.brand || '',
      category_id: p.category_id || '',
      unit_type: p.unit_type,
      bottle_size_ml: p.bottle_size_ml || 180,
      stock_qty: mode === 'liquor' ? bottlesOf(p) : p.stock_qty,
      low_stock_qty: p.low_stock_qty,
      cost_price: p.cost_price,
      bottle_price: Number(p.bottle_price) || Number(p.variants.find((v) => Number(v.ml) === 180)?.price) || 0,
      variants: p.variants.map((v) => ({
        ml: v.ml,
        label: v.label,
        price: v.price,
        cost_price: v.cost_price ?? '',
        stock_qty: isBeer(p) ? Number(v.stock_qty) || 0 : '',
        consume_qty: v.consume_qty,
        supplier_id: v.supplier_id || null,
      })),
    });
  }

  function changeMode(mode) {
    setEdit((prev) => {
      const next = { ...prev, mode, unit_type: mode === 'liquor' ? 'ml' : 'unit' };
      if (mode === 'beer' && !prev.variants.some((v) => Number(v.ml) >= 300)) {
        next.variants = BEER_SIZES.map((ml) => beerRow(ml));
      }
      if (mode === 'liquor') next.variants = [];
      if (mode === 'unit' && prev.variants.length !== 1) {
        next.variants = [{ label: prev.variants[0]?.label || 'Bottle', ml: 0, price: prev.variants[0]?.price || '', stock_qty: '' }];
      }
      return next;
    });
  }

  async function save() {
    if (!edit.name.trim()) {
      notify('Product name is required', 'error');
      return;
    }
    if (edit.mode === 'beer' && edit.variants.every((v) => !Number(v.ml))) {
      notify('Add at least one bottle size (for example 650 ml)', 'error');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: edit.name,
        brand: edit.brand,
        category_id: edit.category_id || null,
        unit_type: edit.mode === 'liquor' ? 'ml' : 'unit',
        stock_mode: edit.mode === 'beer' ? 'variant' : undefined,
        bottle_size_ml: edit.mode === 'liquor' ? 180 : null,
        low_stock_qty: Number(edit.low_stock_qty) || 0,
        cost_price: Number(edit.cost_price) || 0,
      };
      if (edit.mode === 'liquor') {
        // The server derives every pour price from this bottle price (round up to ₹5).
        body.bottle_price = Number(edit.bottle_price) || 0;
      } else if (edit.mode === 'beer') {
        body.variants = edit.variants.map((v) => ({
          label: v.label || `${Number(v.ml) || 0} ml`,
          ml: Number(v.ml) || 0,
          price: Number(v.price) || 0,
          cost_price: Number(v.cost_price) || 0,
          stock_qty: Number(v.stock_qty) || 0,
          supplier_id: v.supplier_id || null,
        }));
      } else {
        body.variants = [
          {
            label: edit.variants[0]?.label || 'Bottle',
            ml: 0,
            consume_qty: 1,
            price: Number(edit.variants[0]?.price) || 0,
          },
        ];
      }

      if (edit.id) await api(`/products/${edit.id}`, { method: 'PUT', body });
      else {
        const qty = Number(edit.stock_qty) || 0;
        await api('/products', {
          method: 'POST',
          body: { ...body, ...(edit.mode === 'liquor' ? { stock_bottles: qty } : edit.mode === 'beer' ? {} : { stock_qty: qty }) },
        });
      }
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
          ...(isBeer(stockFor.product) ? { variant_id: Number(stockFor.variantId) } : {}),
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

  function openStock(product) {
    setStockFor({
      product,
      variantId: isBeer(product) ? product.variants[0]?.id : null,
      change: '',
      movement: 'purchase',
      note: '',
    });
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
          ['liquor', 'Liquor'],
          ['beer', 'Beer'],
          ['low', 'Low stock'],
          ['out', 'Out of stock'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={`chip ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      {canManage ? (
        <div className="chips" style={{ marginBottom: 10 }}>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => newProduct('liquor')} disabled={!online}>
            + Liquor
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => newProduct('beer')} disabled={!online}>
            + Beer
          </button>
          <button className="btn btn-sm" type="button" onClick={() => newProduct('unit')} disabled={!online}>
            + Snacks
          </button>
          <button className="btn btn-sm" type="button" onClick={addCategory} disabled={!online}>
            + Category
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? <div className="empty">No products found.</div> : null}

      {shown.map((p) => {
        const low = isLow(p);
        const b = bottleLabel(p);
        return (
          <div className="card" key={p.id}>
            <div className="row between">
              <div style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                <div className="tiny muted">
                  {p.category_name || 'Uncategorised'}
                  {p.brand ? ` · ${p.brand}` : ''} ·{' '}
                  {p.unit_type === 'ml' ? 'liquor' : isBeer(p) ? 'beer' : 'unit'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 750, color: low ? 'var(--amber)' : 'var(--text)' }}>
                  {p.unit_type === 'ml' ? `${b.total} bt` : `${Math.floor(b.total)} u`}
                </div>
                <div className="tiny muted">
                  {p.unit_type === 'ml'
                    ? `${b.sealed} sealed${b.loose ? ` + ${b.loose} ml loose` : ''}`
                    : isBeer(p)
                      ? `${p.variants.length} bottle sizes`
                      : `min ${Math.floor(p.low_stock_qty)}`}
                </div>
              </div>
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              {isBeer(p)
                ? p.variants
                    .map((v) => `${v.ml} ml ${money(v.price)} · ${variantStock(v)} bt`)
                    .join('  ·  ')
                : p.variants
                    .map((v) => `${v.ml === 180 ? '180ml full' : v.ml ? `${v.ml}ml` : v.label} ${money(v.price)}`)
                    .join('  ·  ')}
            </div>
            {isBeer(p) && p.bottle_price ? (
              <div className="tiny muted">Bottle price ₹{Number(p.bottle_price).toFixed(0)} · prices are independent per size</div>
            ) : null}
            {canManage ? (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-sm" type="button" onClick={() => editProduct(p)} disabled={!online}>
                  Edit
                </button>
                <button className="btn btn-sm" type="button" onClick={() => openStock(p)} disabled={!online}>
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
                placeholder={edit.mode === 'beer' ? 'e.g. Kingfisher Strong' : 'e.g. Royal Stag'}
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
            <div className="field">
              <label htmlFor="punit">Sold by</label>
              <select
                id="punit"
                className="input"
                value={edit.mode}
                onChange={(e) => changeMode(e.target.value)}
                disabled={Boolean(edit.id)}
              >
                <option value="liquor">Liquor (180 ml bottles, loose pours)</option>
                <option value="beer">Beer (separate bottle sizes)</option>
                <option value="unit">Unit (snacks / soft drinks)</option>
              </select>
            </div>

            {edit.mode === 'liquor' ? (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="pbottleprice">180 ml bottle price</label>
                    <input
                      id="pbottleprice"
                      className="input"
                      type="number"
                      inputMode="decimal"
                      value={edit.bottle_price}
                      onChange={(e) => setEdit({ ...edit, bottle_price: e.target.value })}
                      placeholder="e.g. 440"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="pcost">Purchase cost / bottle</label>
                    <input
                      id="pcost"
                      className="input"
                      type="number"
                      value={edit.cost_price}
                      onChange={(e) => setEdit({ ...edit, cost_price: e.target.value })}
                    />
                  </div>
                </div>
                {!edit.id ? (
                  <div className="field">
                    <label htmlFor="pstock">Opening stock (180 ml bottles)</label>
                    <input
                      id="pstock"
                      className="input"
                      type="number"
                      step="0.5"
                      value={edit.stock_qty}
                      onChange={(e) => setEdit({ ...edit, stock_qty: e.target.value })}
                    />
                  </div>
                ) : null}
                <div className="tiny muted" style={{ marginTop: 8 }}>
                  Serving prices (bottle share + ₹5, rounded up to the next ₹5; 180 ml full bottle unchanged)
                </div>
                <div className="card" style={{ marginTop: 6 }}>
                  {POURS.map((ml) => (
                    <div className="row between" key={ml} style={{ marginBottom: 2 }}>
                      <span className="small">{ml} ml</span>
                      <span className="small" style={{ fontWeight: 650 }}>
                        {money(servePrice(edit.bottle_price, ml))}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {edit.mode === 'beer' ? (
              <>
                <div className="tiny muted" style={{ marginTop: 8 }}>
                  Bottle sizes — each size has its own purchase price, selling price and stock
                </div>
                {edit.variants.map((v, i) => (
                  <div className="card" key={`size-${i}`} style={{ marginTop: 6 }}>
                    <div className="row between">
                      <span className="small" style={{ fontWeight: 650 }}>
                        {Number(v.ml) ? `${v.ml} ml` : 'New size'}
                      </span>
                      {edit.variants.length > 1 ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => setEdit({ ...edit, variants: edit.variants.filter((_, idx) => idx !== i) })}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`ml-${i}`}>Bottle size (ml)</label>
                        <input
                          id={`ml-${i}`}
                          className="input"
                          type="number"
                          value={v.ml}
                          onChange={(e) => {
                            const next = [...edit.variants];
                            next[i] = { ...next[i], ml: e.target.value, label: `${e.target.value || ''} ml` };
                            setEdit({ ...edit, variants: next });
                          }}
                          placeholder="650"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`cost-${i}`}>Purchase price</label>
                        <input
                          id={`cost-${i}`}
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={v.cost_price}
                          onChange={(e) => {
                            const next = [...edit.variants];
                            next[i] = { ...next[i], cost_price: e.target.value };
                            setEdit({ ...edit, variants: next });
                          }}
                          placeholder="100"
                        />
                      </div>
                    </div>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`price-${i}`}>Selling price</label>
                        <input
                          id={`price-${i}`}
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={v.price}
                          onChange={(e) => {
                            const next = [...edit.variants];
                            next[i] = { ...next[i], price: e.target.value };
                            setEdit({ ...edit, variants: next });
                          }}
                          placeholder="160"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`stock-${i}`}>{edit.id ? 'Current stock (bottles)' : 'Opening stock (bottles)'}</label>
                        <input
                          id={`stock-${i}`}
                          className="input"
                          type="number"
                          value={v.stock_qty}
                          readOnly={Boolean(edit.id)}
                          disabled={Boolean(edit.id)}
                          onChange={(e) => {
                            const next = [...edit.variants];
                            next[i] = { ...next[i], stock_qty: e.target.value };
                            setEdit({ ...edit, variants: next });
                          }}
                          placeholder="50"
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  className="btn btn-sm"
                  type="button"
                  style={{ marginTop: 8 }}
                  onClick={() => setEdit({ ...edit, variants: [...edit.variants, beerRow('')] })}
                >
                  + Add bottle size
                </button>
                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor="plow">Low stock alert (bottles)</label>
                  <input
                    id="plow"
                    className="input"
                    type="number"
                    value={edit.low_stock_qty}
                    onChange={(e) => setEdit({ ...edit, low_stock_qty: e.target.value })}
                  />
                </div>
              </>
            ) : null}

            {edit.mode === 'unit' ? (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="uprice">Selling price</label>
                    <input
                      id="uprice"
                      className="input"
                      type="number"
                      inputMode="decimal"
                      value={edit.variants[0]?.price ?? ''}
                      onChange={(e) =>
                        setEdit({ ...edit, variants: [{ ...(edit.variants[0] || { label: 'Bottle', ml: 0 }), price: e.target.value }] })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="ucost">Purchase cost</label>
                    <input
                      id="ucost"
                      className="input"
                      type="number"
                      value={edit.cost_price}
                      onChange={(e) => setEdit({ ...edit, cost_price: e.target.value })}
                    />
                  </div>
                </div>
                {!edit.id ? (
                  <div className="field">
                    <label htmlFor="ustock">Opening stock (units)</label>
                    <input
                      id="ustock"
                      className="input"
                      type="number"
                      value={edit.stock_qty}
                      onChange={(e) => setEdit({ ...edit, stock_qty: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="ulow">Low stock alert (units)</label>
                    <input
                      id="ulow"
                      className="input"
                      type="number"
                      value={edit.low_stock_qty}
                      onChange={(e) => setEdit({ ...edit, low_stock_qty: e.target.value })}
                    />
                  </div>
                )}
              </>
            ) : null}

            {edit.mode === 'liquor' && edit.id ? (
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="lqlow">Low stock alert (bottles)</label>
                <input
                  id="lqlow"
                  className="input"
                  type="number"
                  value={edit.low_stock_qty}
                  onChange={(e) => setEdit({ ...edit, low_stock_qty: e.target.value })}
                />
              </div>
            ) : null}

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
              {stockFor.product.name} — current{' '}
              {stockFor.product.unit_type === 'ml'
                ? `${bottleLabel(stockFor.product).total} bottles (${bottleLabel(stockFor.product).sealed} sealed)`
                : isBeer(stockFor.product)
                  ? `${variantStock(stockFor.product.variants.find((v) => v.id === stockFor.variantId))} bottles`
                  : `${Math.floor(Number(stockFor.product.stock_qty) || 0)} units`}
            </p>
            {isBeer(stockFor.product) ? (
              <div className="field">
                <label htmlFor="size">Bottle size</label>
                <select
                  id="size"
                  className="input"
                  value={stockFor.variantId || ''}
                  onChange={(e) => setStockFor({ ...stockFor, variantId: e.target.value })}
                >
                  {stockFor.product.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.ml} ml · {variantStock(v)} in stock
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="qty">
                {stockFor.product.unit_type === 'ml'
                  ? 'Bottles to add (180 ml each; use minus to remove)'
                  : isBeer(stockFor.product)
                    ? 'Bottles to add for this size (use minus to remove)'
                    : 'Quantity to add (use minus to remove)'}
              </label>
              <input
                id="qty"
                className="input"
                type="number"
                value={stockFor.change}
                onChange={(e) => setStockFor({ ...stockFor, change: e.target.value })}
                placeholder={stockFor.product.unit_type === 'ml' ? 'e.g. 12 bottles' : 'e.g. 12'}
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

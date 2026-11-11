import React, { useCallback, useEffect, useState } from 'react';
import { api, getQueue } from '../api.js';

export default function More({ data, user, online, notify, refresh, queueCount, sync, logout }) {
  const settings = data?.settings || {};
  const isManager = ['owner', 'manager'].includes(user?.role);
  const isOwner = user?.role === 'owner';
  const [form, setForm] = useState(settings);
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [newUser, setNewUser] = useState({ name: '', username: '', password: '', role: 'staff' });
  const [supplier, setSupplier] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(null);
  const queue = getQueue();

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const loadAdmin = useCallback(async () => {
    if (!online || !isManager) return;
    try {
      const [u, a, s, p] = await Promise.all([
        api('/admin/users'),
        api('/admin/audit?limit=40'),
        api('/admin/suppliers'),
        api('/admin/purchases'),
      ]);
      setUsers(u.users);
      setAudit(a.audit);
      setSuppliers(s.suppliers);
      setPurchases(p.purchases);
    } catch (err) {
      notify(err.message, 'error');
    }
  }, [online, isManager, notify]);

  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  async function saveSettings() {
    setBusy(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: form });
      notify('Settings saved', 'ok');
      await refresh();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addUser() {
    setBusy(true);
    try {
      await api('/admin/users', { method: 'POST', body: newUser });
      setNewUser({ name: '', username: '', password: '', role: 'staff' });
      notify('Login created', 'ok');
      await loadAdmin();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleUser(u) {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { is_active: u.is_active ? 0 : 1 } });
      await loadAdmin();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function addSupplier() {
    if (!supplier.name) return;
    setBusy(true);
    try {
      await api('/admin/suppliers', { method: 'POST', body: supplier });
      setSupplier({ name: '', phone: '' });
      notify('Supplier added', 'ok');
      await loadAdmin();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const field = (key, label, type = 'text') => (
    <div className="field">
      <label htmlFor={key}>{label}</label>
      <input
        id={key}
        className="input"
        type={type}
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <div>
      <div className="card">
        <div className="row between">
          <div>
            <strong>{user.name}</strong>
            <div className="tiny muted">
              {user.role} · {user.username}
            </div>
          </div>
          <button className="btn btn-sm" type="button" onClick={logout}>
            Log out
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <strong className="small">Offline & sync</strong>
          <span className={`badge ${online ? 'online' : 'offline'}`}>{online ? 'Online' : 'Offline'}</span>
        </div>
        <p className="tiny muted">
          Bills taken without a connection are stored on this device and uploaded automatically.
        </p>
        <div className="row between small">
          <span className="muted">Waiting to sync</span>
          <span>{queueCount}</span>
        </div>
        {queue.slice(0, 5).map((q, i) => (
          <div className="tiny" key={i} style={{ color: q.error ? 'var(--red)' : 'var(--muted)' }}>
            {q.type} · {new Date(q.queued_at).toLocaleString()} {q.error ? `· ${q.error}` : ''}
          </div>
        ))}
        <button className="btn btn-block" type="button" onClick={sync} disabled={!online || queueCount === 0}>
          Sync now
        </button>
      </div>

      <div className="chips">
        {[
          ['settings', 'Hotel settings'],
          ...(isManager ? [['team', 'Team']] : []),
          ...(isManager ? [['suppliers', 'Suppliers']] : []),
          ...(isManager ? [['audit', 'Audit log']] : []),
        ].map(([id, label]) => (
          <button key={id} type="button" className={`chip ${panel === id ? 'active' : ''}`} onClick={() => setPanel(panel === id ? null : id)}>
            {label}
          </button>
        ))}
      </div>

      {panel === 'settings' ? (
        <div className="card">
          <strong className="small">Hotel & billing settings</strong>
          {field('hotel_name', 'Hotel name')}
          {field('address', 'Address')}
          <div className="grid-2">
            {field('phone', 'Phone')}
            {field('gstin', 'GSTIN')}
          </div>
          <div className="grid-2">
            {field('upi_id', 'UPI ID')}
            {field('tax_percent', 'GST %', 'number')}
          </div>
          <div className="grid-2">
            {field('service_charge_percent', 'Service charge %', 'number')}
            {field('low_stock_alert', 'Low stock alert')}
          </div>
          {field('invoice_footer', 'Receipt footer')}
          <button className="btn btn-primary btn-block" type="button" onClick={saveSettings} disabled={busy || !isManager || !online}>
            {isManager ? 'Save settings' : 'Only managers can edit settings'}
          </button>
        </div>
      ) : null}

      {panel === 'team' ? (
        <div className="card">
          <strong className="small">Logins</strong>
          {users.map((u) => (
            <div className="row between" key={u.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <div>
                <div className="small">{u.name}</div>
                <div className="tiny muted">
                  {u.username} · {u.role}
                </div>
              </div>
              {isOwner ? (
                <button className="btn btn-sm" type="button" onClick={() => toggleUser(u)}>
                  {u.is_active ? 'Disable' : 'Enable'}
                </button>
              ) : (
                <span className="tiny muted">{u.is_active ? 'active' : 'disabled'}</span>
              )}
            </div>
          ))}
          {isOwner ? (
            <div style={{ marginTop: 10 }}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="nname">Name</label>
                  <input id="nname" className="input" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="nuser">Username</label>
                  <input
                    id="nuser"
                    className="input"
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="npass">Password</label>
                  <input
                    id="npass"
                    className="input"
                    type="password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="nrole">Role</label>
                  <select
                    id="nrole"
                    className="input"
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  >
                    <option value="staff">Staff</option>
                    <option value="manager">Manager</option>
                    <option value="owner">Owner</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-primary btn-block" type="button" onClick={addUser} disabled={busy || !online}>
                Create login
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {panel === 'suppliers' ? (
        <div className="card">
          <strong className="small">Suppliers</strong>
          {suppliers.map((s) => (
            <div className="row between" key={s.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="small">{s.name}</span>
              <span className="tiny muted">{s.phone || '—'}</span>
            </div>
          ))}
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="sname">Name</label>
              <input id="sname" className="input" value={supplier.name} onChange={(e) => setSupplier({ ...supplier, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sphone">Phone</label>
              <input id="sphone" className="input" value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} />
            </div>
          </div>
          <button className="btn btn-block" type="button" onClick={addSupplier} disabled={busy || !online}>
            Add supplier
          </button>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            Stock inward is recorded from Stock → Stock in/out, which also updates the ledger and cost price.
          </p>
          {purchases.slice(0, 5).map((p) => (
            <div className="row between tiny muted" key={p.id}>
              <span>
                #{p.id} {p.supplier_name || 'Supplier'} {p.purchase_date}
              </span>
              <span>₹{Number(p.total_amount).toFixed(2)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {panel === 'audit' ? (
        <div className="card">
          <strong className="small">Audit log</strong>
          {audit.map((a) => (
            <div key={a.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="small">
                {a.action} · {a.entity}
                {a.entity_id ? ` #${a.entity_id}` : ''}
              </div>
              <div className="tiny muted">
                {a.actor_name || 'system'} · {new Date(a.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <p className="tiny muted" style={{ textAlign: 'center' }}>
        Hotel Sagarika BarFlow · offline-first POS
      </p>
    </div>
  );
}

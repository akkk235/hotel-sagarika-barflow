import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken } from '../api.js';

const bytes = (n) =>
  n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const emptyForm = { name: '', username: '', password: '', role: 'staff', phone: '', permissions: [] };

/**
 * Admin Settings — user accounts, roles, permissions and database storage.
 * Only the Admin (owner) role reaches this screen; the API enforces the same
 * rule independently, so hiding the tab is never the only protection.
 */
export default function Settings({ user, notify }) {
  const isAdmin = user?.role === 'owner';
  const [state, setState] = useState(null);
  const [storage, setStorage] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [selfPw, setSelfPw] = useState({ current_password: '', new_password: '' });

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setBusy(true);
    setError('');
    try {
      const [data, store] = await Promise.all([api('/settings'), api('/settings/storage')]);
      setState(data);
      setStorage(store);
      setForm((f) => ({
        ...f,
        permissions: f.permissions.length ? f.permissions : data.roles.find((r) => r.key === f.role)?.defaults || [],
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Settings</h1>
        </header>
        <section className="report-card">
          <p className="note warn">
            Settings and user management are available to the Admin login only. Ask the Admin to change accounts,
            passwords or permissions.
          </p>
        </section>
      </div>
    );
  }

  const roles = state?.roles || [];
  const perms = state?.permissions || [];
  const togglePerm = (list, key) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const changeRole = (target, role) => {
    const defaults = roles.find((r) => r.key === role)?.defaults || [];
    if (target === 'create') setForm({ ...form, role, permissions: defaults });
    else setEditing({ ...editing, role, permissions: defaults });
  };

  const createUser = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/settings/users', { method: 'POST', body: form });
      notify(`${res.user.name} can now sign in as ${res.user.role_label}`, 'ok');
      setForm(emptyForm);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      const body = {
        name: editing.name,
        role: editing.role,
        phone: editing.phone,
        is_active: editing.is_active,
        permissions: editing.permissions,
      };
      await api(`/settings/users/${editing.id}`, { method: 'PATCH', body });
      if (editing.password) {
        await api(`/settings/users/${editing.id}/password`, {
          method: 'POST',
          body: { new_password: editing.password },
        });
      }
      notify('Account updated', 'ok');
      setEditing(null);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeOwnPassword = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/settings/password', { method: 'POST', body: selfPw });
      notify('Your password was changed', 'ok');
      setSelfPw({ current_password: '', new_password: '' });
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async () => {
    try {
      const res = await fetch('/api/settings/backup', { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Backup failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `barflow-backup-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify('Database backup downloaded', 'ok');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const permissionBoxes = (list, setList) => (
    <div className="perm-grid">
      {perms.map((p) => (
        <label key={p.key} className="perm">
          <input
            type="checkbox"
            checked={list.includes(p.key)}
            onChange={() => setList(togglePerm(list, p.key))}
          />
          <span>
            <strong>{p.label}</strong>
            <em>{p.hint}</em>
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Admin control · user accounts, permissions and database storage</p>
        </div>
      </header>

      {error ? <p className="note error">{error}</p> : null}

      <section className="report-card">
        <h2>Storage &amp; database</h2>
        <p className="muted">
          Stock, bills and purchases are written to the server database — not to the browser. Signing out, refreshing
          or switching users never touches this data.
        </p>
        {storage ? (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span>Stock entries</span>
                <strong>{storage.counts?.stock_entries ?? 0}</strong>
              </div>
              <div className="stat">
                <span>Products</span>
                <strong>{storage.counts?.products ?? 0}</strong>
              </div>
              <div className="stat">
                <span>Bills</span>
                <strong>{storage.counts?.bills ?? 0}</strong>
              </div>
              <div className="stat">
                <span>Database size</span>
                <strong>{bytes(storage.database_size)}</strong>
              </div>
            </div>
            <p className="note">Database file: {storage.database_path}</p>
          </>
        ) : (
          <p className="muted">Loading storage details…</p>
        )}
        <div className="report-actions">
          <button type="button" className="btn ghost" onClick={downloadBackup}>
            Download database backup
          </button>
          <button type="button" className="btn ghost" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </section>

      <section className="report-card">
        <h2>Add a staff account</h2>
        <form onSubmit={createUser} className="settings-form">
          <div className="filter-grid">
            <label>
              Full name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>
              Login ID
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="lowercase, 3-32 chars"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                minLength={6}
                required
              />
            </label>
            <label>
              Role
              <select value={form.role} onChange={(e) => changeRole('create', e.target.value)}>
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Phone (optional)
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
          </div>
          <h3>Permissions</h3>
          {permissionBoxes(form.permissions, (list) => setForm({ ...form, permissions: list }))}
          <button type="submit" className="btn primary" disabled={busy}>
            Create account
          </button>
        </form>
      </section>

      <section className="report-card">
        <h2>User accounts</h2>
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Login ID</th>
                <th>Role</th>
                <th>Status</th>
                <th>Permissions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(state?.users || []).map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'inactive-row'}>
                  <td>{u.name}</td>
                  <td>{u.username}</td>
                  <td>{u.role_label}</td>
                  <td>{u.is_active ? 'Active' : 'Deactivated'}</td>
                  <td className="perm-cell">{u.permissions.length ? u.permissions.join(', ') : 'Billing only'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() =>
                        setEditing({
                          id: u.id,
                          name: u.name,
                          role: u.role,
                          phone: u.phone || '',
                          is_active: u.is_active,
                          permissions: u.permissions,
                          password: '',
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <section className="report-card">
          <h2>Edit account</h2>
          <div className="filter-grid">
            <label>
              Full name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Role
              <select value={editing.role} onChange={(e) => changeRole('edit', e.target.value)}>
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Phone
              <input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </label>
            <label>
              New password (leave blank to keep)
              <input
                type="password"
                value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })}
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={!!editing.is_active}
                onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
              />
              Account active (can sign in)
            </label>
          </div>
          <h3>Permissions</h3>
          {permissionBoxes(editing.permissions, (list) => setEditing({ ...editing, permissions: list }))}
          <div className="report-actions">
            <button type="button" className="btn primary" onClick={saveEdit} disabled={busy}>
              Save changes
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <section className="report-card">
        <h2>Change my password</h2>
        <form onSubmit={changeOwnPassword} className="filter-grid">
          <label>
            Current password
            <input
              type="password"
              value={selfPw.current_password}
              onChange={(e) => setSelfPw({ ...selfPw, current_password: e.target.value })}
              required
            />
          </label>
          <label>
            New password
            <input
              type="password"
              value={selfPw.new_password}
              onChange={(e) => setSelfPw({ ...selfPw, new_password: e.target.value })}
              minLength={6}
              required
            />
          </label>
          <div className="report-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              Update password
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

import React, { useState } from 'react';
import { api, setSession } from '../api.js';

const DEMOS = [
  { label: 'Owner', username: 'owner', password: 'owner123' },
  { label: 'Manager', username: 'manager', password: 'manager123' },
  { label: 'Staff', username: 'staff', password: 'staff123' },
];

export default function Login({ onLogin, hotelName }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password, device: 'web' },
      });
      setSession(res.token, res.user);
      onLogin(res.user);
    } catch (err) {
      setError(err.message || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-logo">🍸</div>
      <h1>{hotelName || 'Hotel Sagarika'}</h1>
      <p className="tag">BarFlow POS · billing, tables, stock &amp; reports</p>
      <form onSubmit={submit} className="card">
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="input"
            autoCapitalize="none"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="owner / manager / staff"
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••"
          />
        </div>
        {error ? (
          <p className="small" style={{ color: 'var(--red)', marginTop: 0 }}>
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="demo-logins">
        {DEMOS.map((d) => (
          <button
            key={d.username}
            type="button"
            onClick={() => {
              setUsername(d.username);
              setPassword(d.password);
            }}
          >
            {d.label} demo
          </button>
        ))}
      </div>
      <p className="tiny muted" style={{ marginTop: 14 }}>
        Works offline once you have signed in on this device.
      </p>
    </div>
  );
}

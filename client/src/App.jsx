import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  clearCache,
  clearSession,
  flushQueue,
  getQueue,
  getToken,
  getUser,
  loadCache,
  saveCache,
} from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Lodging from './pages/Lodging.jsx';
import Billing from './pages/Billing.jsx';
import Tables from './pages/Tables.jsx';
import Products from './pages/Products.jsx';
import Reports from './pages/Reports.jsx';
import DayClosing from './pages/DayClosing.jsx';
import More from './pages/More.jsx';

const TABS = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'billing', label: 'Billing', icon: '🧾' },
  { id: 'tables', label: 'Tables', icon: '🪑' },
  { id: 'rooms', label: 'Rooms', icon: '🛏️' },
  { id: 'products', label: 'Stock', icon: '🍾' },
  { id: 'more', label: 'More', icon: '⚙️' },
];

export default function App() {
  const [user, setUser] = useState(getUser());
  const [data, setData] = useState(() => loadCache());
  const [tab, setTab] = useState('home');
  const [online, setOnline] = useState(navigator.onLine);
  const [queueCount, setQueueCount] = useState(getQueue().length);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(!loadCache());
  const [activeTab, setActiveTab] = useState(null); // running tab being edited
  const toastTimer = useRef(null);

  const notify = useCallback((message, kind = '') => {
    setToast({ message, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* offline logout still clears this device */
    }
    clearSession();
    clearCache();
    setUser(null);
    setData(null);
    setActiveTab(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const res = await api('/bootstrap');
      setData(res);
      saveCache(res);
      setOnline(true);
    } catch (err) {
      if (err.status === 401) {
        await logout();
        return;
      }
      if (err.network) setOnline(false);
      else notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [logout, notify]);

  const sync = useCallback(
    async (announce = false) => {
      if (getQueue().length === 0) return;
      try {
        const result = await flushQueue();
        setQueueCount(getQueue().length);
        setOnline(true);
        if (result.synced > 0) {
          notify(`${result.synced} offline bill(s) synced to the cloud`, 'ok');
          await refresh();
        } else if (result.failed > 0) {
          notify(`${result.failed} offline bill(s) could not sync`, 'error');
        } else if (announce) {
          notify('Nothing left to sync');
        }
      } catch (err) {
        setOnline(false);
        if (announce) notify(err.message || 'Sync needs a connection', 'error');
      }
    },
    [notify, refresh],
  );

  useEffect(() => {
    refresh();
    const onQueue = () => setQueueCount(getQueue().length);
    const onOnline = () => {
      setOnline(true);
      sync();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('barflow:queue', onQueue);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = setInterval(() => {
      if (navigator.onLine && getQueue().length > 0) sync();
    }, 20000);
    return () => {
      window.removeEventListener('barflow:queue', onQueue);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearInterval(timer);
    };
  }, [refresh, sync]);

  if (!user || !getToken()) {
    return (
      <Login
        hotelName={data?.settings?.hotel_name}
        onLogin={(u) => {
          setUser(u);
          refresh();
        }}
      />
    );
  }

  if (loading && !data) {
    return (
      <div className="login-wrap">
        <p className="muted">Loading Hotel Sagarika BarFlow…</p>
      </div>
    );
  }

  const settings = data?.settings || {};

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="avatar">{String(user.name || 'U').slice(0, 1).toUpperCase()}</div>
        <div className="brand">
          <strong>{settings.hotel_name || 'Hotel Sagarika'}</strong>
          <span>
            {user.name} · {user.role}
            {data?.saved_at && !online ? ` · saved ${new Date(data.saved_at).toLocaleTimeString()}` : ''}
          </span>
        </div>
        <span className={`badge ${online ? 'online' : 'offline'}`}>{online ? 'Online' : 'Offline'}</span>
        {queueCount > 0 ? (
          <button className="badge queue" type="button" onClick={() => sync(true)}>
            {queueCount} to sync
          </button>
        ) : null}
      </header>

      <main className="content">
        {tab === 'home' ? (
          <Dashboard
            user={user}
            online={online}
            notify={notify}
            refresh={refresh}
            go={(id) => setTab(id)}
          />
        ) : null}
        {tab === 'billing' ? (
          <Billing
            data={data}
            settings={settings}
            user={user}
            online={online}
            notify={notify}
            refresh={refresh}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            goToTables={() => setTab('tables')}
          />
        ) : null}
        {tab === 'tables' ? (
          <Tables
            data={data}
            user={user}
            online={online}
            notify={notify}
            refresh={refresh}
            onOpenTab={(order) => {
              setActiveTab(order);
              setTab('billing');
            }}
            goToBilling={() => setTab('billing')}
          />
        ) : null}
        {tab === 'rooms' ? (
          <Lodging user={user} online={online} notify={notify} refresh={refresh} />
        ) : null}
        {tab === 'products' ? (
          <Products data={data} user={user} notify={notify} refresh={refresh} online={online} />
        ) : null}
        {tab === 'reports' ? (
          <Reports data={data} notify={notify} online={online} user={user} refresh={refresh} />
        ) : null}
        {tab === 'day' ? (
          <DayClosing user={user} notify={notify} online={online} />
        ) : null}
        {tab === 'more' ? (
          <More
            data={data}
            user={user}
            online={online}
            notify={notify}
            refresh={refresh}
            queueCount={queueCount}
            sync={() => sync(true)}
            logout={logout}
            go={(id) => setTab(id)}
          />
        ) : null}
      </main>

      <nav className="bottom-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            <span className="ico">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </div>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA: register the app-shell service worker in production builds only.
// It caches static assets and never intercepts /api, so billing, authentication
// and the offline sync queue keep working exactly as before.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('[barflow] service worker registration failed', error);
    });
  });
}

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedIfEmpty, ensureDiningTables, ensureRooms } from './seed.js';
import { migrateCatalog } from './migrations.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import tableRoutes from './routes/tables.js';
import orderRoutes from './routes/orders.js';
import billRoutes from './routes/bills.js';
import reportRoutes from './routes/reports.js';
import syncRoutes from './routes/sync.js';
import adminRoutes from './routes/admin.js';
import lodgingRoutes from './routes/lodging.js';
import dashboardRoutes from './routes/dashboard.js';
import dayRoutes from './routes/day.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

seedIfEmpty();
// Guarantee the corrected inventory/table/room setup on every boot.
ensureDiningTables();
ensureRooms();

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'BarFlow POS', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api/tables', tableRoutes);
  app.use('/api/rooms', lodgingRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/bills', billRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/day', dayRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown API route ${req.method} ${req.originalUrl}` });
  });

  // PWA assets. The service worker must not be cached long (updates), and
  // Express does not expose dot-directories such as /.well-known from static
  // middleware, so Digital Asset Links is served explicitly for the TWA.
  const PWA_FILES = new Map([
    ['/sw.js', { file: 'sw.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' }],
    [
      '/.well-known/assetlinks.json',
      { file: '.well-known/assetlinks.json', type: 'application/json; charset=utf-8', cache: 'no-store' },
    ],
  ]);
  for (const [route, meta] of PWA_FILES) {
    app.get(route, (req, res, next) => {
      // Read and send directly: res.sendFile applies Express's dotfile rules to
      // the /.well-known path segment and rejects the file with an error.
      let body;
      try {
        body = fs.readFileSync(path.join(DIST_DIR, meta.file));
      } catch {
        return next();
      }
      res.setHeader('Content-Type', meta.type);
      res.setHeader('Cache-Control', meta.cache);
      res.send(body);
    });
  }

  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.status(503).send('BarFlow client is not built yet. Run "npm run build".');
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    console.error('[barflow]', err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}

export default createApp;

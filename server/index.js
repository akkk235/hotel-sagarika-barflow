import { createApp } from './app.js';
import { DB_PATH } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const app = createApp();

const server = app.listen(PORT, HOST, () => {
  console.log(`BarFlow POS listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

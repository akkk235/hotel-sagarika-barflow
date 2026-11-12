import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'client', 'public');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = buf.subarray(0, 8).toString('hex');
  assert.equal(signature, '89504e470d0a1a0a', `${file} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${file} has no IHDR chunk`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('PWA: manifest.json exists and carries the required install fields', () => {
  const manifest = readJson(path.join(PUBLIC, 'manifest.json'));
  assert.equal(manifest.name, 'Hotel Sagarika BarFlow');
  assert.equal(manifest.short_name, 'BarFlow');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.equal(manifest.theme_color.toLowerCase(), '#12100e');
  assert.equal(manifest.background_color.toLowerCase(), '#0f0d0b');
  assert.equal(manifest.prefer_related_applications, false);
});

test('PWA: manifest declares 192 and 512 PNG icons plus maskable icons', () => {
  const manifest = readJson(path.join(PUBLIC, 'manifest.json'));
  const icons = manifest.icons || [];
  const anyIcon = (size) =>
    icons.find((icon) => icon.sizes === size && icon.type === 'image/png' && (icon.purpose || 'any') === 'any');
  const maskable = (size) =>
    icons.find((icon) => icon.sizes === size && icon.type === 'image/png' && icon.purpose === 'maskable');

  for (const size of ['192x192', '512x512']) {
    const icon = anyIcon(size);
    assert.ok(icon, `missing ${size} any-purpose PNG icon`);
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${icon.src} does not exist`);
    const actual = pngSize(file);
    assert.deepEqual(actual, {
      width: Number(size.split('x')[0]),
      height: Number(size.split('x')[1]),
    });
  }

  for (const size of ['192x192', '512x512']) {
    const icon = maskable(size);
    assert.ok(icon, `missing ${size} maskable icon`);
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${icon.src} does not exist`);
    const actual = pngSize(file);
    assert.equal(actual.width, Number(size.split('x')[0]));
    assert.equal(actual.height, Number(size.split('x')[1]));
  }
});

test('PWA: the HTML shell links the manifest and install metadata', () => {
  const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.json" \/>/);
  assert.match(html, /name="theme-color" content="#12100e"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /<div id="root"><\/div>/);
});

test('PWA: the service worker caches the shell but never intercepts the API', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'barflow-shell-v1'/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\) return;/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /caches\.delete/);
  // Only GET requests are handled, so POST/PATCH billing calls always reach the server.
  assert.match(sw, /request\.method !== 'GET'\) return;/);
});

test('PWA: the service worker is registered from the client entry point', () => {
  const main = fs.readFileSync(path.join(ROOT, 'client', 'src', 'main.jsx'), 'utf8');
  assert.match(main, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
});

test('PWA: Digital Asset Links file is valid and targets the Android package', () => {
  const links = readJson(path.join(PUBLIC, '.well-known', 'assetlinks.json'));
  assert.ok(Array.isArray(links) && links.length === 1);
  assert.deepEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(links[0].target.namespace, 'android_app');
  assert.equal(links[0].target.package_name, 'com.hotelsagarika.barflow');
  assert.ok(Array.isArray(links[0].target.sha256_cert_fingerprints));
  assert.ok(links[0].target.sha256_cert_fingerprints.length >= 1);
});

test('PWA: the server serves the service worker and asset links explicitly', () => {
  const app = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
  assert.match(app, /'\/sw\.js'/);
  assert.match(app, /'\/\.well-known\/assetlinks\.json'/);
  assert.match(app, /application\/json; charset=utf-8/);
  assert.match(app, /Cache-Control', meta\.cache/);
});

test('PWA: Android packaging documentation lists the asset links requirements', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'android-twa.md'), 'utf8');
  assert.match(doc, /\.well-known\/assetlinks\.json/);
  assert.match(doc, /sha256_cert_fingerprints/);
  assert.match(doc, /com\.hotelsagarika\.barflow/);
  assert.match(doc, /Replace the placeholder values/);
});

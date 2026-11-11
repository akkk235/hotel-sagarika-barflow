const TOKEN_KEY = 'barflow.token';
const USER_KEY = 'barflow.user';
const CACHE_KEY = 'barflow.cache.v1';
const QUEUE_KEY = 'barflow.queue.v1';
const DEVICE_KEY = 'barflow.device.v1';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.network = status === 0;
  }
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full - ignore */
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  return read(USER_KEY, null);
}

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  write(USER_KEY, user);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function api(path, opts = {}) {
  const { method = 'GET', body, timeout = 20000 } = opts;
  const headers = { 'Content-Type': 'application/json', 'X-Device-ID': deviceId() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new ApiError('No connection to the BarFlow server', 0, null);
  }
  clearTimeout(timer);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

// ---------- offline cache ----------
export function saveCache(state) {
  write(CACHE_KEY, { ...state, saved_at: new Date().toISOString() });
}

export function loadCache() {
  return read(CACHE_KEY, null);
}

export function clearCache() {
  localStorage.removeItem(CACHE_KEY);
}

// ---------- offline queue ----------
export function getQueue() {
  return read(QUEUE_KEY, []);
}

export function queueWrite(queue) {
  write(QUEUE_KEY, queue);
  window.dispatchEvent(new Event('barflow:queue'));
}

export function enqueue(type, payload) {
  const queue = getQueue();
  queue.push({ type, payload, queued_at: new Date().toISOString(), error: null });
  queueWrite(queue);
  return queue;
}

export function removeQueued(indexes) {
  const drop = new Set(indexes);
  queueWrite(getQueue().filter((_, i) => !drop.has(i)));
}

export function markQueueError(index, message) {
  const queue = getQueue();
  if (!queue[index]) return;
  queue[index].error = message;
  queueWrite(queue);
}

/** Push everything queued on this device to the cloud. Safe to call repeatedly. */
export async function flushQueue() {
  const queue = getQueue();
  if (queue.length === 0) return { synced: 0, failed: 0 };
  const bills = queue.filter((q) => q.type === 'bill').map((q) => q.payload);
  const expenses = queue.filter((q) => q.type === 'expense').map((q) => q.payload);
  const res = await api('/sync/push', {
    method: 'POST',
    body: { device_id: deviceId(), bills, expenses },
  });
  const syncedUuids = new Set(
    res.results.filter((r) => r.status === 'synced' || r.status === 'duplicate').map((r) => r.client_uuid),
  );
  const failedByUuid = new Map(
    res.results.filter((r) => r.status === 'failed' || r.status === 'rejected').map((r) => [r.client_uuid, r.message]),
  );
  const remaining = [];
  for (const item of getQueue()) {
    const id = item.payload?.client_uuid;
    if (syncedUuids.has(id)) continue;
    if (failedByUuid.has(id)) remaining.push({ ...item, error: failedByUuid.get(id) });
    else remaining.push(item);
  }
  queueWrite(remaining);
  return { synced: syncedUuids.size, failed: failedByUuid.size };
}

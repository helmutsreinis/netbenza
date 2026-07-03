import { getStore } from '@netlify/blobs';

export const ACTIVE_WINDOW_MS = 25_000;

const ALLOWED_ACTIVITIES = new Set([
  'online',
  'searching',
  'filtering',
  'selecting',
  'voting',
  'done',
  'idle',
]);

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function normalizeClientId(value) {
  const normalized = clip(value, 80)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('clientId is required');
  return normalized;
}

export function normalizePresenceBody(body = {}) {
  const activity = ALLOWED_ACTIVITIES.has(body.activity) ? body.activity : 'online';
  const avatar = clip(body.avatar, 240);
  const detail = typeof body.detail === 'string' ? body.detail : '';

  return {
    clientId: normalizeClientId(body.clientId),
    handle: clip(body.handle, 32) || 'Anonymous',
    avatar: avatar.startsWith('/avatars/') || avatar.startsWith('/static/avatars/') ? avatar : '',
    activity,
    detail: clip(detail, 80),
  };
}

export function createPresenceRecord(normalized, now = Date.now()) {
  return {
    clientId: normalized.clientId,
    handle: normalized.handle,
    avatar: normalized.avatar,
    activity: normalized.activity,
    detail: normalized.detail,
    lastSeen: now,
  };
}

export class MemoryPresenceStore {
  constructor() {
    this.records = new Map();
  }

  async setJSON(key, value) {
    this.records.set(key, structuredClone(value));
    return { modified: true, etag: `"${key}"` };
  }

  async get(key, options = {}) {
    const value = this.records.get(key);
    if (value === undefined) return null;
    if (options.type === 'json') return structuredClone(value);
    return JSON.stringify(value);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    return {
      blobs: [...this.records.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, etag: `"${key}"` })),
    };
  }

  async delete(key) {
    this.records.delete(key);
  }
}

export function presenceKey(clientId) {
  return `users/${clientId}`;
}

function publicUser(record) {
  return {
    clientId: record.clientId,
    handle: record.handle,
    avatar: record.avatar,
    activity: record.activity,
    detail: record.detail,
    lastSeen: record.lastSeen,
  };
}

export async function presenceSnapshot(store, now = Date.now()) {
  const { blobs = [] } = await store.list({ prefix: 'users/' });
  const users = [];

  await Promise.all(blobs.map(async (blob) => {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record?.clientId || !record.lastSeen) return;
    if (now - Number(record.lastSeen) > ACTIVE_WINDOW_MS) {
      await store.delete(blob.key).catch(() => {});
      return;
    }
    users.push(publicUser(record));
  }));

  users.sort((a, b) => a.handle.localeCompare(b.handle) || a.clientId.localeCompare(b.clientId));
  return {
    users,
    activeWindowMs: ACTIVE_WINDOW_MS,
    serverTime: now,
  };
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function getPresenceStore() {
  return getStore({ name: 'gdebenz-presence', consistency: 'strong' });
}

export async function handlePresenceRequest(req, store = getPresenceStore(), nowFn = Date.now) {
  const now = nowFn();

  if (req.method === 'GET') {
    return json(await presenceSnapshot(store, now));
  }

  if (req.method === 'POST') {
    try {
      const normalized = normalizePresenceBody(await readJson(req));
      await store.setJSON(presenceKey(normalized.clientId), createPresenceRecord(normalized, now));
      return json(await presenceSnapshot(store, now));
    } catch (error) {
      return json({ detail: error.message || 'Invalid presence payload' }, { status: 400 });
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const clientId = url.searchParams.get('clientId');
    if (clientId) await store.delete(presenceKey(normalizeClientId(clientId))).catch(() => {});
    return json(await presenceSnapshot(store, now));
  }

  return json({ detail: 'Method not allowed. Use GET, POST, DELETE' }, {
    status: 405,
    headers: { allow: 'GET, POST, DELETE' },
  });
}

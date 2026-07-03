import { getStore } from '@netlify/blobs';
import { requestIpKey } from './request-context.mjs';

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

export function normalizeSessionId(value) {
  const normalized = clip(value, 120)
    .replace(/[^a-zA-Z0-9:._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('sessionId is required');
  return normalized;
}

export function normalizePresenceBody(body = {}) {
  const activity = ALLOWED_ACTIVITIES.has(body.activity) ? body.activity : 'online';
  const avatar = clip(body.avatar, 240);
  const detail = typeof body.detail === 'string' ? body.detail : '';
  const clientId = normalizeClientId(body.clientId);

  return {
    clientId,
    sessionId: normalizeSessionId(body.sessionId || clientId),
    handle: clip(body.handle, 32) || 'Anonymous',
    avatar: avatar.startsWith('/avatars/') || avatar.startsWith('/static/avatars/') ? avatar : '',
    activity,
    detail: clip(detail, 80),
  };
}

export function createPresenceRecord(normalized, now = Date.now()) {
  return {
    clientId: normalized.clientId,
    sessionId: normalizeSessionId(normalized.sessionId || normalized.clientId),
    handle: normalized.handle,
    avatar: normalized.avatar,
    activity: normalized.activity,
    detail: normalized.detail,
    ipKey: normalized.ipKey || '',
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

function isActiveRecord(record, now) {
  if (!record?.clientId) return false;
  const lastSeen = Number(record.lastSeen);
  return Number.isFinite(lastSeen) && now - lastSeen <= ACTIVE_WINDOW_MS;
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

async function activePresenceEntries(store, now = Date.now()) {
  const { blobs = [] } = await store.list({ prefix: 'users/' });
  const entries = [];

  await Promise.all(blobs.map(async (blob) => {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record?.clientId) return;
    if (!isActiveRecord(record, now)) {
      await store.delete(blob.key).catch(() => {});
      return;
    }
    entries.push({ key: blob.key, record });
  }));

  return entries;
}

function normalizeViewer(viewer) {
  if (!viewer?.clientId || !viewer?.sessionId) return null;
  try {
    return {
      clientId: normalizeClientId(viewer.clientId),
      sessionId: normalizeSessionId(viewer.sessionId),
      ipKey: typeof viewer.ipKey === 'string' ? viewer.ipKey : '',
    };
  } catch {
    return null;
  }
}

function sessionStatusFromEntries(entries, viewer) {
  const identity = normalizeViewer(viewer);
  if (!identity) return null;

  const ownEntry = entries.find(({ record }) => record.clientId === identity.clientId);
  if (ownEntry) {
    return ownEntry.record.sessionId === identity.sessionId
      ? { active: true }
      : { active: false, reason: 'client_replaced' };
  }

  if (identity.ipKey) {
    const ipReplacement = entries.find(({ record }) => (
      record.ipKey === identity.ipKey && record.clientId !== identity.clientId
    ));
    if (ipReplacement) return { active: false, reason: 'ip_replaced' };
  }

  return { active: false, reason: 'not_found' };
}

export async function activeSessionStatus(store, viewer, now = Date.now()) {
  const entries = await activePresenceEntries(store, now);
  return sessionStatusFromEntries(entries, viewer) || { active: true };
}

export async function assertActiveSession(store, identity, now = Date.now()) {
  const status = await activeSessionStatus(store, identity, now);
  if (status.active) return status;

  const error = new Error(status.reason || 'inactive_session');
  error.status = 409;
  error.code = status.reason || 'inactive_session';
  throw error;
}

export async function presenceSnapshot(store, now = Date.now(), viewer = null) {
  const entries = await activePresenceEntries(store, now);
  const users = entries.map(({ record }) => publicUser(record));

  users.sort((a, b) => a.handle.localeCompare(b.handle) || a.clientId.localeCompare(b.clientId));
  const snapshot = {
    users,
    activeWindowMs: ACTIVE_WINDOW_MS,
    serverTime: now,
  };
  const session = sessionStatusFromEntries(entries, viewer);
  if (session) snapshot.session = session;
  return snapshot;
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

function viewerFromRequest(req) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const sessionId = url.searchParams.get('sessionId');
  if (!clientId && !sessionId) return null;
  return { clientId, sessionId, ipKey: requestIpKey(req) };
}

async function replaceSameIpProfiles(store, identity, now) {
  if (!identity.ipKey) return;
  const entries = await activePresenceEntries(store, now);
  await Promise.all(entries
    .filter(({ record }) => record.ipKey === identity.ipKey && record.clientId !== identity.clientId)
    .map(({ key }) => store.delete(key).catch(() => {})));
}

export async function handlePresenceRequest(req, store = getPresenceStore(), nowFn = Date.now) {
  const now = nowFn();

  if (req.method === 'GET') {
    return json(await presenceSnapshot(store, now, viewerFromRequest(req)));
  }

  if (req.method === 'POST') {
    try {
      const normalized = normalizePresenceBody(await readJson(req));
      const identity = { ...normalized, ipKey: requestIpKey(req) };
      await replaceSameIpProfiles(store, identity, now);
      await store.setJSON(presenceKey(identity.clientId), createPresenceRecord(identity, now));
      return json(await presenceSnapshot(store, now));
    } catch (error) {
      return json({ detail: error.message || 'Invalid presence payload' }, { status: 400 });
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const clientId = url.searchParams.get('clientId');
    const sessionId = url.searchParams.get('sessionId');
    const viewer = viewerFromRequest(req);
    if (clientId) {
      if (sessionId) {
        const status = await activeSessionStatus(store, viewer, now);
        if (status.active) await store.delete(presenceKey(normalizeClientId(clientId))).catch(() => {});
      } else {
        await store.delete(presenceKey(normalizeClientId(clientId))).catch(() => {});
      }
    }
    return json(await presenceSnapshot(store, now, viewer));
  }

  return json({ detail: 'Method not allowed. Use GET, POST, DELETE' }, {
    status: 405,
    headers: { allow: 'GET, POST, DELETE' },
  });
}

import { getStore } from '@netlify/blobs';
import { requestIpKey } from './request-context.mjs';

export const ACTIVE_WINDOW_MS = 25_000;
const HISTORY_LIMIT = 24;

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
    sessionId: normalizeSessionId(body.sessionId),
    handle: clip(body.handle, 32) || 'Anonymous',
    avatar: avatar.startsWith('/avatars/') || avatar.startsWith('/static/avatars/') ? avatar : '',
    activity,
    detail: clip(detail, 80),
  };
}

export function createPresenceRecord(normalized, now = Date.now()) {
  return {
    clientId: normalized.clientId,
    sessionId: normalizeSessionId(normalized.sessionId),
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

export function clientSessionKey(clientId) {
  return `clients/${clientId}`;
}

export function ipSessionKey(ipKey) {
  return `ips/${ipKey}`;
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

function rememberValue(values = [], value = '') {
  const current = Array.isArray(values) ? values.filter(Boolean) : [];
  const next = value ? [value, ...current.filter((item) => item !== value)] : current;
  return next.slice(0, HISTORY_LIMIT);
}

function identityToken(identity) {
  return `${identity.clientId}\n${identity.sessionId}`;
}

function sameIdentity(left, right) {
  return Boolean(
    left?.clientId &&
    left?.sessionId &&
    right?.clientId &&
    right?.sessionId &&
    left.clientId === right.clientId &&
    left.sessionId === right.sessionId,
  );
}

function activeIdentityFromIpState(state) {
  if (!state?.activeClientId || !state?.activeSessionId) return null;
  return {
    clientId: state.activeClientId,
    sessionId: state.activeSessionId,
  };
}

function hasRememberedSession(state, sessionId) {
  return Array.isArray(state?.replacedSessionIds) && state.replacedSessionIds.includes(sessionId);
}

function hasRememberedIdentity(state, identity) {
  return Array.isArray(state?.replacedIdentities) && state.replacedIdentities.includes(identityToken(identity));
}

async function readStoreJson(store, key) {
  return store.get(key, { type: 'json' }).catch(() => null);
}

async function readClientState(store, clientId) {
  return readStoreJson(store, clientSessionKey(clientId));
}

async function readIpState(store, ipKey) {
  if (!ipKey) return null;
  return readStoreJson(store, ipSessionKey(ipKey));
}

function normalizeRecordIdentity(record) {
  try {
    const clientId = normalizeClientId(record.clientId);
    const sessionId = normalizeSessionId(record.sessionId);
    const ipKey = typeof record.ipKey === 'string' ? record.ipKey : '';
    if (!ipKey) return null;
    return { clientId, sessionId, ipKey };
  } catch {
    return null;
  }
}

function normalizeViewer(viewer) {
  try {
    const clientId = normalizeClientId(viewer?.clientId);
    const sessionId = normalizeSessionId(viewer?.sessionId);
    const ipKey = typeof viewer?.ipKey === 'string' ? viewer.ipKey : '';
    if (!ipKey) return null;
    return { clientId, sessionId, ipKey };
  } catch {
    return null;
  }
}

async function isCurrentActiveRecord(store, record, now) {
  if (!isActiveRecord(record, now)) return false;
  const identity = normalizeRecordIdentity(record);
  if (!identity) return false;

  const [clientState, ipState] = await Promise.all([
    readClientState(store, identity.clientId),
    readIpState(store, identity.ipKey),
  ]);

  return (
    clientState?.activeSessionId === identity.sessionId &&
    sameIdentity(activeIdentityFromIpState(ipState), identity)
  );
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
    if (await isCurrentActiveRecord(store, record, now)) {
      entries.push({ key: blob.key, record });
    }
  }));

  return entries;
}

async function sessionStatusFromStore(store, viewer, now) {
  const identity = normalizeViewer(viewer);
  if (!identity) return { active: false, reason: 'invalid_session' };

  const [clientState, ipState, record] = await Promise.all([
    readClientState(store, identity.clientId),
    readIpState(store, identity.ipKey),
    readStoreJson(store, presenceKey(identity.clientId)),
  ]);
  const ipActive = activeIdentityFromIpState(ipState);

  if (clientState?.activeSessionId && clientState.activeSessionId !== identity.sessionId) {
    return { active: false, reason: 'client_replaced' };
  }

  if (!clientState?.activeSessionId) {
    if (ipActive && !sameIdentity(ipActive, identity)) return { active: false, reason: 'ip_replaced' };
    return { active: false, reason: 'not_found' };
  }

  if (ipActive && !sameIdentity(ipActive, identity)) {
    return { active: false, reason: 'ip_replaced' };
  }

  if (!ipActive) return { active: false, reason: 'not_found' };

  const recordIdentity = normalizeRecordIdentity(record || {});
  if (
    !recordIdentity ||
    !sameIdentity(recordIdentity, identity) ||
    recordIdentity.ipKey !== identity.ipKey ||
    !isActiveRecord(record, now)
  ) {
    return { active: false, reason: 'not_found' };
  }

  return { active: true };
}

export async function activeSessionStatus(store, viewer, now = Date.now()) {
  return sessionStatusFromStore(store, viewer, now);
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
  if (viewer) snapshot.session = await sessionStatusFromStore(store, viewer, now);
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

async function applyPresencePost(store, identity, now) {
  const [clientState, ipState] = await Promise.all([
    readClientState(store, identity.clientId),
    readIpState(store, identity.ipKey),
  ]);
  const ipActive = activeIdentityFromIpState(ipState);

  if (clientState?.activeSessionId && clientState.activeSessionId !== identity.sessionId) {
    if (hasRememberedSession(clientState, identity.sessionId)) {
      return { active: false, reason: 'client_replaced' };
    }
  } else if (!clientState?.activeSessionId && hasRememberedSession(clientState, identity.sessionId)) {
    return { active: false, reason: 'client_replaced' };
  }

  if (hasRememberedIdentity(ipState, identity)) {
    return { active: false, reason: 'ip_replaced' };
  }

  if (clientState?.activeSessionId === identity.sessionId && ipActive && !sameIdentity(ipActive, identity)) {
    return { active: false, reason: 'ip_replaced' };
  }

  const previousClientSession = (
    clientState?.activeSessionId &&
    clientState.activeSessionId !== identity.sessionId
  ) ? clientState.activeSessionId : '';
  const previousIpIdentity = ipActive && !sameIdentity(ipActive, identity) ? ipActive : null;

  await store.setJSON(clientSessionKey(identity.clientId), {
    clientId: identity.clientId,
    activeSessionId: identity.sessionId,
    replacedSessionIds: rememberValue(clientState?.replacedSessionIds, previousClientSession),
    updatedAt: now,
  });
  await store.setJSON(ipSessionKey(identity.ipKey), {
    ipKey: identity.ipKey,
    activeClientId: identity.clientId,
    activeSessionId: identity.sessionId,
    replacedIdentities: rememberValue(
      ipState?.replacedIdentities,
      previousIpIdentity ? identityToken(previousIpIdentity) : '',
    ),
    updatedAt: now,
  });
  await store.setJSON(presenceKey(identity.clientId), createPresenceRecord(identity, now));

  if (previousIpIdentity && previousIpIdentity.clientId !== identity.clientId) {
    await store.delete(presenceKey(previousIpIdentity.clientId)).catch(() => {});
  }

  return { active: true };
}

async function deleteActivePresence(store, viewer, now) {
  const identity = normalizeViewer(viewer);
  if (!identity) return { active: false, reason: 'invalid_session' };

  const status = await activeSessionStatus(store, identity, now);
  if (!status.active) return status;

  const [clientState, ipState] = await Promise.all([
    readClientState(store, identity.clientId),
    readIpState(store, identity.ipKey),
  ]);

  await store.delete(presenceKey(identity.clientId)).catch(() => {});
  await store.setJSON(clientSessionKey(identity.clientId), {
    clientId: identity.clientId,
    activeSessionId: '',
    replacedSessionIds: rememberValue(clientState?.replacedSessionIds, identity.sessionId),
    updatedAt: now,
  });

  if (sameIdentity(activeIdentityFromIpState(ipState), identity)) {
    await store.setJSON(ipSessionKey(identity.ipKey), {
      ipKey: identity.ipKey,
      activeClientId: '',
      activeSessionId: '',
      replacedIdentities: rememberValue(ipState?.replacedIdentities, identityToken(identity)),
      updatedAt: now,
    });
  }

  return { active: false, reason: 'not_found' };
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
      await applyPresencePost(store, identity, now);
      return json(await presenceSnapshot(store, now, identity));
    } catch (error) {
      return json({ detail: error.message || 'Invalid presence payload' }, { status: 400 });
    }
  }

  if (req.method === 'DELETE') {
    const viewer = viewerFromRequest(req);
    await deleteActivePresence(store, viewer, now);
    return json(await presenceSnapshot(store, now, viewer));
  }

  return json({ detail: 'Method not allowed. Use GET, POST, DELETE' }, {
    status: 405,
    headers: { allow: 'GET, POST, DELETE' },
  });
}

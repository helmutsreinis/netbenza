import { getStore } from '@netlify/blobs';
import { requestIpKey } from './request-context.mjs';

export const ACTIVE_WINDOW_MS = 25_000;
export const SESSION_STARTED_AT_FUTURE_TOLERANCE_MS = 120_000;

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

export function normalizeSessionStartedAt(value, now = Date.now()) {
  const normalized = Math.trunc(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error('sessionStartedAt is required');
  }
  if (normalized > now + SESSION_STARTED_AT_FUTURE_TOLERANCE_MS) {
    throw new Error('sessionStartedAt is too far in the future');
  }
  return normalized;
}

export function normalizePresenceBody(body = {}, now = Date.now()) {
  const activity = ALLOWED_ACTIVITIES.has(body.activity) ? body.activity : 'online';
  const avatar = clip(body.avatar, 240);
  const detail = typeof body.detail === 'string' ? body.detail : '';

  return {
    clientId: normalizeClientId(body.clientId),
    sessionId: normalizeSessionId(body.sessionId),
    sessionStartedAt: normalizeSessionStartedAt(body.sessionStartedAt, now),
    handle: clip(body.handle, 32) || 'Anonymous',
    avatar: avatar.startsWith('/avatars/') || avatar.startsWith('/static/avatars/') ? avatar : '',
    activity,
    detail: clip(detail, 80),
  };
}

export function createPresenceRecord(normalized, now = Date.now()) {
  return {
    clientId: normalizeClientId(normalized.clientId),
    sessionId: normalizeSessionId(normalized.sessionId),
    sessionStartedAt: normalizeSessionStartedAt(normalized.sessionStartedAt, now),
    handle: normalized.handle,
    avatar: normalized.avatar,
    activity: normalized.activity,
    detail: normalized.detail,
    ipKey: normalized.ipKey || '',
    acceptedAt: Math.max(0, Math.trunc(Number(normalized.acceptedAt || now)) || now),
    lastSeen: now,
    endedAt: Math.max(0, Math.trunc(Number(normalized.endedAt || 0)) || 0),
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

export function presenceKey(clientId, sessionId) {
  return `users/${normalizeClientId(clientId)}/${normalizeSessionId(sessionId)}`;
}

export function clientSessionKey(clientId) {
  return `clients/${normalizeClientId(clientId)}`;
}

export function ipSessionKey(ipKey) {
  return `ips/${ipKey}`;
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

function isRecordRecent(record, now) {
  const lastSeen = Number(record?.lastSeen);
  return Number.isFinite(lastSeen) && now - lastSeen <= ACTIVE_WINDOW_MS;
}

function isRecordActive(record, now) {
  return !record?.endedAt && isRecordRecent(record, now);
}

function normalizeRecordIdentity(record, now = Date.now()) {
  try {
    const clientId = normalizeClientId(record?.clientId);
    const sessionId = normalizeSessionId(record?.sessionId);
    const sessionStartedAt = normalizeSessionStartedAt(record?.sessionStartedAt, now);
    const ipKey = typeof record?.ipKey === 'string' ? record.ipKey : '';
    if (!ipKey) return null;
    return {
      clientId,
      sessionId,
      sessionStartedAt,
      ipKey,
      acceptedAt: Math.trunc(Number(record.acceptedAt || 0)) || 0,
      endedAt: Math.trunc(Number(record.endedAt || 0)) || 0,
    };
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

function compareGeneration(left, right) {
  if (!right) return 1;
  if (!left) return -1;
  if (left.sessionStartedAt !== right.sessionStartedAt) {
    return left.sessionStartedAt - right.sessionStartedAt;
  }
  if ((left.acceptedAt || 0) !== (right.acceptedAt || 0)) {
    return (left.acceptedAt || 0) - (right.acceptedAt || 0);
  }
  const sessionCompare = String(left.sessionId).localeCompare(String(right.sessionId));
  if (sessionCompare) return sessionCompare;
  return String(left.clientId || '').localeCompare(String(right.clientId || ''));
}

function sameGeneration(left, right) {
  return Boolean(
    left?.clientId &&
    left?.sessionId &&
    right?.clientId &&
    right?.sessionId &&
    left.clientId === right.clientId &&
    left.sessionId === right.sessionId &&
    Number(left.sessionStartedAt) === Number(right.sessionStartedAt) &&
    Number(left.acceptedAt || 0) === Number(right.acceptedAt || 0),
  );
}

function newerGeneration(current, candidate) {
  return compareGeneration(candidate, current) > 0 ? candidate : current;
}

function normalizedStartedAt(value, now) {
  try {
    return normalizeSessionStartedAt(value, now);
  } catch {
    return null;
  }
}

function clientStateGeneration(state, now = Date.now()) {
  if (!state?.latestSessionId || !state?.latestStartedAt) return null;
  const sessionStartedAt = normalizedStartedAt(state.latestStartedAt, now);
  if (!sessionStartedAt) return null;
  return {
    clientId: state.clientId,
    sessionId: state.latestSessionId,
    sessionStartedAt,
    acceptedAt: Math.trunc(Number(state.latestAcceptedAt || 0)) || 0,
    endedAt: Math.trunc(Number(state.endedAt || 0)) || 0,
  };
}

function ipStateGeneration(state, now = Date.now()) {
  if (!state?.latestClientId || !state?.latestSessionId || !state?.latestStartedAt) return null;
  const sessionStartedAt = normalizedStartedAt(state.latestStartedAt, now);
  if (!sessionStartedAt) return null;
  return {
    clientId: state.latestClientId,
    sessionId: state.latestSessionId,
    sessionStartedAt,
    acceptedAt: Math.trunc(Number(state.latestAcceptedAt || 0)) || 0,
    endedAt: Math.trunc(Number(state.endedAt || 0)) || 0,
  };
}

function endedStateMatchesRecord(state, recordIdentity, now) {
  const stateIdentity = state?.latestClientId
    ? ipStateGeneration(state, now)
    : clientStateGeneration(state, now);
  return Boolean(stateIdentity?.endedAt && sameGeneration(stateIdentity, recordIdentity));
}

async function readStoreJson(store, key) {
  return store.get(key, { type: 'json' }).catch(() => null);
}

async function listJsonRecords(store, prefix) {
  const { blobs = [] } = await store.list({ prefix });
  const records = await Promise.all(blobs.map(async (blob) => ({
    key: blob.key,
    record: await readStoreJson(store, blob.key),
  })));
  return records.filter((entry) => entry.record);
}

async function readSessionEntries(store, now) {
  const entries = [];
  const records = await listJsonRecords(store, 'users/');

  await Promise.all(records.map(async ({ key, record }) => {
    const identity = normalizeRecordIdentity(record, now);
    if (!identity) return;
    if (!record.endedAt && !isRecordRecent(record, now)) {
      await store.delete(key).catch(() => {});
      return;
    }
    entries.push({ key, record, identity });
  }));

  return entries;
}

async function readStateMaps(store) {
  const [clientEntries, ipEntries] = await Promise.all([
    listJsonRecords(store, 'clients/'),
    listJsonRecords(store, 'ips/'),
  ]);
  return {
    clientStates: new Map(clientEntries.map(({ record }) => [record.clientId, record])),
    ipStates: new Map(ipEntries.map(({ record }) => [record.ipKey, record])),
  };
}

function chooseWinner(map, key, identity) {
  map.set(key, newerGeneration(map.get(key), identity));
}

async function derivePresenceState(store, now) {
  const [sessionEntries, { clientStates, ipStates }] = await Promise.all([
    readSessionEntries(store, now),
    readStateMaps(store),
  ]);
  const clientWinners = new Map();
  const ipWinners = new Map();

  for (const state of clientStates.values()) {
    const identity = clientStateGeneration(state, now);
    if (identity) chooseWinner(clientWinners, identity.clientId, identity);
  }

  for (const state of ipStates.values()) {
    const identity = ipStateGeneration(state, now);
    if (identity) chooseWinner(ipWinners, state.ipKey, identity);
  }

  for (const { identity } of sessionEntries) {
    chooseWinner(clientWinners, identity.clientId, identity);
    chooseWinner(ipWinners, identity.ipKey, identity);
  }

  const activeEntries = sessionEntries.filter(({ record, identity }) => {
    if (!isRecordActive(record, now)) return false;
    if (!sameGeneration(clientWinners.get(identity.clientId), identity)) return false;
    if (!sameGeneration(ipWinners.get(identity.ipKey), identity)) return false;
    if (endedStateMatchesRecord(clientStates.get(identity.clientId), identity, now)) return false;
    if (endedStateMatchesRecord(ipStates.get(identity.ipKey), identity, now)) return false;
    return true;
  });

  return {
    activeEntries,
    clientStates,
    ipStates,
    clientWinners,
    ipWinners,
  };
}

function sessionStatusFromDerived(derived, viewer) {
  const identity = normalizeViewer(viewer);
  if (!identity) return { active: false, reason: 'invalid_session' };

  const activeEntry = derived.activeEntries.find(({ record }) => (
    record.clientId === identity.clientId &&
    record.sessionId === identity.sessionId &&
    record.ipKey === identity.ipKey
  ));
  if (activeEntry) return { active: true };

  const clientWinner = derived.clientWinners.get(identity.clientId);
  if (clientWinner && clientWinner.sessionId !== identity.sessionId) {
    return { active: false, reason: 'client_replaced' };
  }

  const ipWinner = derived.ipWinners.get(identity.ipKey);
  if (ipWinner && (ipWinner.clientId !== identity.clientId || ipWinner.sessionId !== identity.sessionId)) {
    return { active: false, reason: 'ip_replaced' };
  }

  return { active: false, reason: 'not_found' };
}

export async function activeSessionStatus(store, viewer, now = Date.now()) {
  return sessionStatusFromDerived(await derivePresenceState(store, now), viewer);
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
  const derived = await derivePresenceState(store, now);
  const users = derived.activeEntries.map(({ record }) => publicUser(record));

  users.sort((a, b) => a.handle.localeCompare(b.handle) || a.clientId.localeCompare(b.clientId));
  const snapshot = {
    users,
    activeWindowMs: ACTIVE_WINDOW_MS,
    serverTime: now,
  };
  if (viewer) snapshot.session = sessionStatusFromDerived(derived, viewer);
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

function identityFromRecord(record) {
  return {
    clientId: record.clientId,
    sessionId: record.sessionId,
    sessionStartedAt: record.sessionStartedAt,
    ipKey: record.ipKey,
    acceptedAt: record.acceptedAt,
  };
}

function shouldWriteClientState(state, record, keepEnded) {
  const incoming = identityFromRecord(record);
  const current = clientStateGeneration(state, record.lastSeen);
  if (!current) return true;
  if (state.endedAt && sameGeneration(current, incoming)) return false;
  if (keepEnded) return false;
  return compareGeneration(incoming, current) >= 0;
}

function shouldWriteIpState(state, record, keepEnded) {
  const incoming = identityFromRecord(record);
  const current = ipStateGeneration(state, record.lastSeen);
  if (!current) return true;
  if (state.endedAt && sameGeneration(current, incoming)) return false;
  if (keepEnded) return false;
  return compareGeneration(incoming, current) >= 0;
}

async function writeHighWatermarks(store, record, keepEnded) {
  const [clientState, ipState] = await Promise.all([
    readStoreJson(store, clientSessionKey(record.clientId)),
    readStoreJson(store, ipSessionKey(record.ipKey)),
  ]);

  const writes = [];
  if (shouldWriteClientState(clientState, record, keepEnded)) {
    writes.push(store.setJSON(clientSessionKey(record.clientId), {
      clientId: record.clientId,
      latestSessionId: record.sessionId,
      latestStartedAt: record.sessionStartedAt,
      latestAcceptedAt: record.acceptedAt,
      updatedAt: record.lastSeen,
      endedAt: 0,
    }));
  }

  if (shouldWriteIpState(ipState, record, keepEnded)) {
    writes.push(store.setJSON(ipSessionKey(record.ipKey), {
      ipKey: record.ipKey,
      latestClientId: record.clientId,
      latestSessionId: record.sessionId,
      latestStartedAt: record.sessionStartedAt,
      latestAcceptedAt: record.acceptedAt,
      updatedAt: record.lastSeen,
      endedAt: 0,
    }));
  }

  await Promise.all(writes);
}

async function applyPresencePost(store, identity, now) {
  const key = presenceKey(identity.clientId, identity.sessionId);
  const existing = await readStoreJson(store, key);
  const existingStartedAt = Math.trunc(Number(existing?.sessionStartedAt || 0)) || 0;
  const existingAcceptedAt = Math.trunc(Number(existing?.acceptedAt || 0)) || 0;
  const keepEnded = Boolean(existing?.endedAt && existingStartedAt >= identity.sessionStartedAt);
  const record = createPresenceRecord({
    ...identity,
    acceptedAt: existingAcceptedAt || now,
    endedAt: keepEnded ? existing.endedAt : 0,
  }, now);

  await store.setJSON(key, record);
  await writeHighWatermarks(store, record, keepEnded);
  return activeSessionStatus(store, identity, now);
}

async function markActiveSessionEnded(store, identity, now) {
  const key = presenceKey(identity.clientId, identity.sessionId);
  const record = await readStoreJson(store, key);
  if (!record) return { active: false, reason: 'not_found' };

  const endedRecord = { ...record, endedAt: now, lastSeen: now };
  await store.setJSON(key, endedRecord);
  await Promise.all([
    store.setJSON(clientSessionKey(identity.clientId), {
      clientId: identity.clientId,
      latestSessionId: record.sessionId,
      latestStartedAt: record.sessionStartedAt,
      latestAcceptedAt: record.acceptedAt,
      updatedAt: now,
      endedAt: now,
    }),
    store.setJSON(ipSessionKey(record.ipKey), {
      ipKey: record.ipKey,
      latestClientId: record.clientId,
      latestSessionId: record.sessionId,
      latestStartedAt: record.sessionStartedAt,
      latestAcceptedAt: record.acceptedAt,
      updatedAt: now,
      endedAt: now,
    }),
  ]);

  return { active: false, reason: 'not_found' };
}

async function deleteActivePresence(store, viewer, now) {
  const identity = normalizeViewer(viewer);
  if (!identity) return { active: false, reason: 'invalid_session' };

  const status = await activeSessionStatus(store, identity, now);
  if (!status.active) return status;
  return markActiveSessionEnded(store, identity, now);
}

export async function handlePresenceRequest(req, store = getPresenceStore(), nowFn = Date.now) {
  const now = nowFn();

  if (req.method === 'GET') {
    return json(await presenceSnapshot(store, now, viewerFromRequest(req)));
  }

  if (req.method === 'POST') {
    try {
      const normalized = normalizePresenceBody(await readJson(req), now);
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

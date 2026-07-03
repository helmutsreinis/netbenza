import { randomUUID } from 'node:crypto';

import { getStore } from '@netlify/blobs';

export const VOTE_INTERVAL_MS = 2000;

const QUEUE_STATE_KEY = 'queue/state';
const ACTIVE_STATES = new Set(['queued', 'processing']);

export function getVoteQueueStore() {
  return getStore({ name: 'gdebenz-vote-queue', consistency: 'strong' });
}

function defaultQueueState() {
  return {
    entries: [],
    lastSubmissionAt: 0,
    lastClientId: '',
    processingId: '',
  };
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function clippedString(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function requiredString(value, field) {
  const normalized = clippedString(value, 240);
  if (!normalized) {
    const error = new Error(`${field}_required`);
    error.code = `${field}_required`;
    error.status = 400;
    throw error;
  }
  return normalized;
}

function queueError(code, status = 409) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeTimestamp(value) {
  const timestamp = Math.trunc(Number(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizeEntry(entry) {
  if (!entry?.id || !entry?.clientId || !entry?.ipKey) return null;
  const state = ACTIVE_STATES.has(entry.state) ? entry.state : 'queued';
  return {
    ...entry,
    id: clippedString(entry.id, 120),
    clientId: clippedString(entry.clientId, 120),
    sessionId: clippedString(entry.sessionId, 160),
    ipKey: clippedString(entry.ipKey, 180),
    handle: clippedString(entry.handle, 32) || 'Anonymous',
    avatar: clippedString(entry.avatar, 240),
    source: clippedString(entry.source, 40) || 'gdebenz',
    stationId: clippedString(entry.stationId, 80),
    status: clippedString(entry.status, 40),
    queuedAt: normalizeTimestamp(entry.queuedAt),
    processingAt: normalizeTimestamp(entry.processingAt),
    state,
    privateVote: clone(entry.privateVote || {}),
  };
}

function normalizeState(state) {
  const entries = Array.isArray(state?.entries)
    ? state.entries.map(normalizeEntry).filter(Boolean)
    : [];
  return {
    entries,
    lastSubmissionAt: normalizeTimestamp(state?.lastSubmissionAt),
    lastClientId: clippedString(state?.lastClientId, 120),
    processingId: clippedString(state?.processingId, 120),
  };
}

async function writeQueueState(store, state) {
  const normalized = normalizeState(state);
  await store.setJSON(QUEUE_STATE_KEY, normalized);
  return normalized;
}

export async function readQueueState(store = getVoteQueueStore()) {
  const state = await store.get(QUEUE_STATE_KEY, { type: 'json' }).catch(() => null);
  if (!state) return defaultQueueState();
  return normalizeState(state);
}

export function createVoteQueueEntry({
  identity = {},
  vote = {},
  now = Date.now(),
  id = randomUUID(),
} = {}) {
  const stationId = vote.stationId ?? vote.osmId ?? vote.osm_id ?? vote.station_id ?? '';
  const status = vote.status ?? vote.vote_status ?? '';
  const source = vote.source || 'gdebenz';

  return {
    id: requiredString(id, 'id'),
    clientId: requiredString(identity.clientId, 'clientId'),
    sessionId: clippedString(identity.sessionId, 160),
    ipKey: requiredString(identity.ipKey, 'ipKey'),
    handle: clippedString(identity.handle, 32) || 'Anonymous',
    avatar: clippedString(identity.avatar, 240),
    source: clippedString(source, 40) || 'gdebenz',
    stationId: requiredString(stationId, 'stationId'),
    status: requiredString(status, 'status'),
    queuedAt: normalizeTimestamp(now) || Date.now(),
    processingAt: 0,
    state: 'queued',
    privateVote: clone(vote),
  };
}

function activeEntries(entries = []) {
  return entries.filter((entry) => ACTIVE_STATES.has(entry.state));
}

function findActiveConflict(entries, entry) {
  const active = activeEntries(entries);
  if (active.some((candidate) => candidate.clientId === entry.clientId)) return 'client_active';
  if (active.some((candidate) => candidate.ipKey === entry.ipKey)) return 'ip_active';
  return '';
}

export async function enqueueVoteEntry(store = getVoteQueueStore(), entry) {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry) throw queueError('queue_entry_invalid', 400);

  const state = await readQueueState(store);
  const conflict = findActiveConflict(state.entries, normalizedEntry);
  if (conflict) throw queueError(conflict);

  state.entries.push(normalizedEntry);
  await writeQueueState(store, state);
  return normalizedEntry;
}

function compareQueuedEntries(left, right) {
  const queuedAtCompare = Number(left.queuedAt || 0) - Number(right.queuedAt || 0);
  if (queuedAtCompare) return queuedAtCompare;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

export function selectNextVoteEntry(entries = [], lastClientId = '') {
  const queued = entries
    .filter((entry) => entry?.state === 'queued')
    .sort(compareQueuedEntries);
  if (!queued.length) return null;

  const clientOrder = [];
  for (const entry of queued) {
    if (!clientOrder.includes(entry.clientId)) clientOrder.push(entry.clientId);
  }

  if (!lastClientId || !clientOrder.includes(lastClientId)) return queued[0];

  const startIndex = (clientOrder.indexOf(lastClientId) + 1) % clientOrder.length;
  for (let offset = 0; offset < clientOrder.length; offset += 1) {
    const clientId = clientOrder[(startIndex + offset) % clientOrder.length];
    const entry = queued.find((candidate) => candidate.clientId === clientId);
    if (entry) return entry;
  }

  return queued[0];
}

export function millisecondsUntilVoteAllowed(state = {}, now = Date.now()) {
  const lastSubmissionAt = normalizeTimestamp(state.lastSubmissionAt);
  if (!lastSubmissionAt) return 0;
  return Math.max(0, VOTE_INTERVAL_MS - (Math.trunc(Number(now)) - lastSubmissionAt));
}

export async function markVoteEntryProcessing(store = getVoteQueueStore(), entryId, now = Date.now()) {
  const state = await readQueueState(store);
  if (state.processingId && state.processingId !== entryId) return null;

  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  if (entry.state === 'processing') return entry;
  if (entry.state !== 'queued') return null;

  entry.state = 'processing';
  entry.processingAt = normalizeTimestamp(now) || Date.now();
  state.processingId = entry.id;
  await writeQueueState(store, state);
  return clone(entry);
}

export async function removeVoteEntry(store = getVoteQueueStore(), entryId, completion = {}) {
  const state = await readQueueState(store);
  const removed = state.entries.find((entry) => entry.id === entryId) || null;
  state.entries = state.entries.filter((entry) => entry.id !== entryId);

  if (state.processingId === entryId) state.processingId = '';
  if (Object.hasOwn(completion, 'lastSubmissionAt')) {
    state.lastSubmissionAt = normalizeTimestamp(completion.lastSubmissionAt);
  }
  if (Object.hasOwn(completion, 'lastClientId')) {
    state.lastClientId = clippedString(completion.lastClientId, 120);
  }

  await writeQueueState(store, state);
  return removed;
}

function publicEntry(entry, now, position) {
  const queuedAt = normalizeTimestamp(entry.queuedAt);
  return {
    id: entry.id,
    clientId: entry.clientId,
    handle: entry.handle,
    avatar: entry.avatar,
    source: entry.source,
    stationId: entry.stationId,
    status: entry.status,
    queuedAt,
    queuedAgeMs: Math.max(0, Math.trunc(Number(now)) - queuedAt),
    state: entry.state,
    position,
  };
}

export function publicQueueSnapshot(state = defaultQueueState(), now = Date.now()) {
  const normalized = normalizeState(state);
  const entries = activeEntries(normalized.entries)
    .sort(compareQueuedEntries)
    .map((entry, index) => publicEntry(entry, now, index + 1));

  return {
    entries,
    serverTime: Math.trunc(Number(now)) || Date.now(),
    voteIntervalMs: VOTE_INTERVAL_MS,
    nextAllowedAt: normalized.lastSubmissionAt
      ? normalized.lastSubmissionAt + VOTE_INTERVAL_MS
      : Math.trunc(Number(now)) || Date.now(),
    nextAllowedInMs: millisecondsUntilVoteAllowed(normalized, now),
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRunArguments(storeOrOptions, maybeOptions) {
  if (storeOrOptions && typeof storeOrOptions.get === 'function') {
    return { store: storeOrOptions, ...(maybeOptions || {}) };
  }
  return { store: getVoteQueueStore(), ...(storeOrOptions || {}) };
}

export async function runQueuedVote(storeOrOptions = getVoteQueueStore(), maybeOptions = {}) {
  const {
    store,
    nowFn = Date.now,
    sleepFn = delay,
    submitVote,
  } = normalizeRunArguments(storeOrOptions, maybeOptions);

  if (typeof submitVote !== 'function') throw queueError('submitVote_required', 500);

  let state = await readQueueState(store);
  const waitMs = millisecondsUntilVoteAllowed(state, nowFn());
  if (waitMs > 0) await sleepFn(waitMs);

  state = await readQueueState(store);
  if (state.processingId) return null;

  const next = selectNextVoteEntry(state.entries, state.lastClientId);
  if (!next) return null;

  const processing = await markVoteEntryProcessing(store, next.id, nowFn());
  if (!processing) return null;

  const submissionAt = normalizeTimestamp(nowFn()) || Date.now();
  try {
    return await submitVote(clone(processing.privateVote), clone(processing));
  } finally {
    await removeVoteEntry(store, processing.id, {
      lastSubmissionAt: submissionAt,
      lastClientId: processing.clientId,
    });
  }
}

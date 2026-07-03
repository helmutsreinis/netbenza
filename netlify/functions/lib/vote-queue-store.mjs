import { randomUUID } from 'node:crypto';

import { getStore } from '@netlify/blobs';

export const VOTE_INTERVAL_MS = 2000;
export const PROCESSING_LEASE_MS = 30_000;

const QUEUE_META_KEY = 'queue/meta';
const QUEUE_ENTRY_PREFIX = 'queue/entries/';
const LEGACY_QUEUE_STATE_KEY = 'queue/state';
const LEGACY_MIGRATED_KEY = 'queue/legacy-migrated';
const ACTIVE_STATES = new Set(['queued', 'processing']);
const QUEUE_POLL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 60_000;
let processingClaimCounter = 0;

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

function queueEntryKey(entryId) {
  return `${QUEUE_ENTRY_PREFIX}${clippedString(entryId, 120)}`;
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
    processingClaimedAt: normalizeTimestamp(entry.processingClaimedAt),
    processingToken: clippedString(entry.processingToken, 120),
    processingLeaseUntil: normalizeTimestamp(entry.processingLeaseUntil),
    state,
    privateVote: clone(entry.privateVote || {}),
  };
}

function normalizeMeta(state) {
  return {
    lastSubmissionAt: normalizeTimestamp(state?.lastSubmissionAt),
    lastClientId: clippedString(state?.lastClientId, 120),
    processingId: clippedString(state?.processingId, 120),
  };
}

function normalizeState(state) {
  const entries = Array.isArray(state?.entries)
    ? state.entries.map(normalizeEntry).filter(Boolean)
    : [];
  return {
    entries,
    ...normalizeMeta(state),
  };
}

function processingLeaseUntil(entry) {
  return normalizeTimestamp(entry.processingLeaseUntil)
    || (normalizeTimestamp(entry.processingAt) ? normalizeTimestamp(entry.processingAt) + PROCESSING_LEASE_MS : 0);
}

function cleanupStaleProcessing(state, now = Date.now()) {
  const normalizedNow = normalizeTimestamp(now) || Date.now();
  let changed = false;
  let lastSubmissionAt = state.lastSubmissionAt;
  let lastClientId = state.lastClientId;
  const entries = [];

  for (const entry of state.entries) {
    if (entry.state !== 'processing') {
      entries.push(entry);
      continue;
    }

    const leaseUntil = processingLeaseUntil(entry);
    if (leaseUntil && leaseUntil <= normalizedNow) {
      changed = true;
      const attemptedAt = normalizeTimestamp(entry.processingAt) || normalizedNow;
      if (attemptedAt >= lastSubmissionAt) {
        lastSubmissionAt = attemptedAt;
        lastClientId = entry.clientId;
      }
      if (state.processingId === entry.id) state.processingId = '';
      continue;
    }

    entries.push(entry);
  }

  const processingEntries = entries.filter((entry) => entry.state === 'processing');
  let processingId = state.processingId;
  if (processingId && !processingEntries.some((entry) => entry.id === processingId)) {
    processingId = '';
    changed = true;
  }
  if (!processingId && processingEntries.length) {
    processingId = processingEntries[0].id;
    changed = true;
  }

  return {
    state: {
      entries,
      lastSubmissionAt,
      lastClientId,
      processingId,
    },
    changed,
  };
}

async function readQueueMeta(store) {
  return normalizeMeta(await store.get(QUEUE_META_KEY, { type: 'json' }));
}

async function readLegacyQueueState(store) {
  const state = await store.get(LEGACY_QUEUE_STATE_KEY, { type: 'json' });
  return state ? normalizeState(state) : null;
}

async function readLegacyMigrationMarker(store) {
  return Boolean(await store.get(LEGACY_MIGRATED_KEY, { type: 'json' }));
}

async function readQueueEntries(store) {
  const { blobs = [] } = await store.list({ prefix: QUEUE_ENTRY_PREFIX });
  const entries = await Promise.all(blobs.map(async (blob) => (
    normalizeEntry(await store.get(blob.key, { type: 'json' }))
  )));
  return entries.filter(Boolean);
}

async function writeQueueMeta(store, state) {
  const normalized = normalizeMeta(state);
  await store.setJSON(QUEUE_META_KEY, normalized);
  return normalized;
}

async function writeQueueEntry(store, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw queueError('queue_entry_invalid', 400);
  await store.setJSON(queueEntryKey(normalized.id), normalized);
  return normalized;
}

async function deleteQueueEntry(store, entryId) {
  await store.delete(queueEntryKey(entryId));
}

async function deleteLegacyQueueState(store) {
  await store.delete(LEGACY_QUEUE_STATE_KEY);
}

async function writeLegacyMigrationMarker(store, now) {
  await store.setJSON(LEGACY_MIGRATED_KEY, {
    migratedAt: normalizeTimestamp(now) || Date.now(),
  });
}

function hasQueueStateData(state) {
  const normalized = normalizeState(state);
  return Boolean(
    normalized.entries.length
    || normalized.lastSubmissionAt
    || normalized.lastClientId
    || normalized.processingId,
  );
}

function mergeLegacyQueueState(legacyState, currentState) {
  const legacy = normalizeState(legacyState);
  const current = normalizeState(currentState);
  const entries = new Map();
  for (const entry of legacy.entries) entries.set(entry.id, entry);
  for (const entry of current.entries) entries.set(entry.id, entry);
  return normalizeState({
    ...legacy,
    entries: [...entries.values()],
  });
}

export async function readQueueState(store = getVoteQueueStore(), now = Date.now()) {
  const [meta, entries, legacyState, legacyMigrated] = await Promise.all([
    readQueueMeta(store),
    readQueueEntries(store),
    readLegacyQueueState(store),
    readLegacyMigrationMarker(store),
  ]);
  let normalized = normalizeState({ ...meta, entries });
  const useLegacyState = !legacyMigrated && hasQueueStateData(legacyState);
  if (useLegacyState) normalized = mergeLegacyQueueState(legacyState, normalized);

  const cleaned = cleanupStaleProcessing(normalized, now);
  if (useLegacyState) {
    const activeIds = new Set(cleaned.state.entries.map((entry) => entry.id));
    await Promise.all([
      ...cleaned.state.entries.map((entry) => writeQueueEntry(store, entry)),
      ...normalized.entries
        .filter((entry) => !activeIds.has(entry.id))
        .map((entry) => deleteQueueEntry(store, entry.id)),
    ]);
    await writeQueueMeta(store, cleaned.state);
    await writeLegacyMigrationMarker(store, now);
    await deleteLegacyQueueState(store);
  } else if (cleaned.changed) {
    const activeIds = new Set(cleaned.state.entries.map((entry) => entry.id));
    await Promise.all([
      writeQueueMeta(store, cleaned.state),
      ...normalized.entries
        .filter((entry) => !activeIds.has(entry.id))
        .map((entry) => deleteQueueEntry(store, entry.id)),
    ]);
  }
  return cleaned.state;
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
    processingLeaseUntil: 0,
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

export async function enqueueVoteEntry(store = getVoteQueueStore(), entry, now = Date.now()) {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry) throw queueError('queue_entry_invalid', 400);

  const state = await readQueueState(store, now);
  const conflict = findActiveConflict(state.entries, normalizedEntry);
  if (conflict) throw queueError(conflict);

  await writeQueueEntry(store, normalizedEntry);
  await reconcileActiveEntry(store, normalizedEntry, now);
  return normalizedEntry;
}

function entryOrder(left, right) {
  const queuedAtCompare = Number(left.queuedAt || 0) - Number(right.queuedAt || 0);
  if (queuedAtCompare) return queuedAtCompare;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

async function reconcileActiveEntry(store, entry, now) {
  const state = await readQueueState(store, now);
  const active = activeEntries(state.entries);
  const sameClient = active
    .filter((candidate) => candidate.clientId === entry.clientId)
    .sort(entryOrder);
  const sameIp = active
    .filter((candidate) => candidate.ipKey === entry.ipKey)
    .sort(entryOrder);

  const clientWinner = sameClient[0];
  if (clientWinner && clientWinner.id !== entry.id) {
    await deleteQueueEntry(store, entry.id);
    throw queueError('client_active');
  }

  const ipWinner = sameIp[0];
  if (ipWinner && ipWinner.id !== entry.id) {
    await deleteQueueEntry(store, entry.id);
    throw queueError('ip_active');
  }

  const losers = [...sameClient, ...sameIp]
    .filter((candidate) => candidate.id !== entry.id);
  await Promise.all([...new Set(losers.map((candidate) => candidate.id))]
    .map((entryId) => deleteQueueEntry(store, entryId)));
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

function processingClaimStamp() {
  processingClaimCounter = (processingClaimCounter + 1) % 1000;
  return (Date.now() * 1000) + processingClaimCounter;
}

function queuedEntry(entry) {
  return {
    ...entry,
    state: 'queued',
    processingAt: 0,
    processingClaimedAt: 0,
    processingToken: '',
    processingLeaseUntil: 0,
  };
}

function compareProcessingEntries(left, right) {
  const claimCompare = Number(left.processingClaimedAt || 0) - Number(right.processingClaimedAt || 0);
  if (claimCompare) return claimCompare;
  const processingCompare = Number(left.processingAt || 0) - Number(right.processingAt || 0);
  if (processingCompare) return processingCompare;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function processingClaimHasTie(processingEntries, entry) {
  if (!entry) return false;
  const claim = normalizeTimestamp(entry?.processingClaimedAt);
  return processingEntries.some((candidate) => (
    candidate.id !== entry.id
    && normalizeTimestamp(candidate.processingClaimedAt) === claim
  ));
}

function fairQueuedEntries(entries = [], lastClientId = '') {
  const queued = entries
    .filter((entry) => entry?.state === 'queued')
    .sort(compareQueuedEntries);
  const ordered = [];
  let virtualLastClientId = lastClientId;

  while (queued.length) {
    const next = selectNextVoteEntry(queued, virtualLastClientId);
    if (!next) break;
    ordered.push(next);
    virtualLastClientId = next.clientId;
    const selectedIndex = queued.findIndex((entry) => entry.id === next.id);
    queued.splice(selectedIndex >= 0 ? selectedIndex : 0, 1);
  }

  return ordered;
}

export function millisecondsUntilVoteAllowed(state = {}, now = Date.now()) {
  const lastSubmissionAt = normalizeTimestamp(state.lastSubmissionAt);
  if (!lastSubmissionAt) return 0;
  return Math.max(0, VOTE_INTERVAL_MS - (Math.trunc(Number(now)) - lastSubmissionAt));
}

export async function markVoteEntryProcessing(
  store = getVoteQueueStore(),
  entryId,
  now = Date.now(),
  leaseMs = PROCESSING_LEASE_MS,
) {
  const state = await readQueueState(store, now);
  if (state.processingId && state.processingId !== entryId) return null;

  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  if (entry.state === 'processing') return entry;
  if (state.entries.some((candidate) => candidate.state === 'processing')) return null;
  if (millisecondsUntilVoteAllowed(state, now) > 0) return null;
  if (entry.state !== 'queued') return null;
  if (selectNextVoteEntry(state.entries, state.lastClientId)?.id !== entry.id) return null;

  const processingAt = normalizeTimestamp(now) || Date.now();
  entry.state = 'processing';
  entry.processingAt = processingAt;
  entry.processingClaimedAt = processingClaimStamp();
  entry.processingToken = randomUUID();
  entry.processingLeaseUntil = processingAt + Math.max(1, Math.trunc(Number(leaseMs)) || PROCESSING_LEASE_MS);
  state.processingId = entry.id;
  await Promise.all([
    writeQueueEntry(store, entry),
    writeQueueMeta(store, state),
  ]);

  const validationState = await readQueueState(store, now);
  const validationEntry = validationState.entries.find((candidate) => candidate.id === entry.id);
  const processingEntries = validationState.entries
    .filter((candidate) => candidate.state === 'processing')
    .sort(compareProcessingEntries);
  const processingOwner = processingEntries[0] || null;
  const claimTied = processingClaimHasTie(processingEntries, validationEntry);
  const ownsStoredClaim = validationEntry?.processingToken === entry.processingToken;
  const intervalBlocked = millisecondsUntilVoteAllowed(validationState, now) > 0;

  if (
    !validationEntry
    || validationEntry.state !== 'processing'
    || !ownsStoredClaim
    || processingOwner?.id !== entry.id
    || claimTied
    || intervalBlocked
  ) {
    if (validationEntry?.state === 'processing' && ownsStoredClaim) {
      await writeQueueEntry(store, queuedEntry(validationEntry));
    }
    return null;
  }

  const staleProcessing = processingEntries.filter((candidate) => candidate.id !== entry.id);
  await Promise.all([
    ...staleProcessing.map((candidate) => writeQueueEntry(store, queuedEntry(candidate))),
    writeQueueMeta(store, { ...validationState, processingId: entry.id }),
  ]);
  return clone(validationEntry);
}

export async function removeVoteEntry(store = getVoteQueueStore(), entryId, completion = {}, now = Date.now()) {
  const state = await readQueueState(store, now);
  const removed = state.entries.find((entry) => entry.id === entryId) || null;
  state.entries = state.entries.filter((entry) => entry.id !== entryId);

  if (state.processingId === entryId) state.processingId = '';
  if (removed) {
    if (Object.hasOwn(completion, 'lastSubmissionAt')) {
      const completedAt = normalizeTimestamp(completion.lastSubmissionAt);
      if (completedAt >= state.lastSubmissionAt) {
        state.lastSubmissionAt = completedAt;
        if (Object.hasOwn(completion, 'lastClientId')) {
          state.lastClientId = clippedString(completion.lastClientId, 120);
        }
      }
    } else if (Object.hasOwn(completion, 'lastClientId')) {
      state.lastClientId = clippedString(completion.lastClientId, 120);
    }
  }

  await Promise.all([
    deleteQueueEntry(store, entryId),
    writeQueueMeta(store, state),
  ]);
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
  const normalized = cleanupStaleProcessing(normalizeState(state), now).state;
  const processingEntry = normalized.entries.find((entry) => (
    entry.state === 'processing' && entry.id === normalized.processingId
  )) || normalized.entries.find((entry) => entry.state === 'processing') || null;
  const entries = fairQueuedEntries(normalized.entries, normalized.lastClientId)
    .map((entry, index) => publicEntry(entry, now, index + 1));

  return {
    entries,
    processing: processingEntry ? publicEntry(processingEntry, now, 0) : null,
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

function normalizeRunArguments(storeOrOptions, maybeOptions = {}) {
  if (storeOrOptions && typeof storeOrOptions.get === 'function') {
    return { queueStore: storeOrOptions, ...maybeOptions };
  }
  return { ...(storeOrOptions || {}) };
}

function currentTime(nowFn) {
  return normalizeTimestamp(nowFn()) || Date.now();
}

function waitTimeoutError() {
  return queueError('queue_wait_timeout', 504);
}

async function waitWithinBudget({ startedAt, maxWaitMs, nowFn, sleep, waitMs }) {
  const now = currentTime(nowFn);
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed >= maxWaitMs) throw waitTimeoutError();

  const remaining = maxWaitMs - elapsed;
  const duration = Math.max(1, Math.min(waitMs || QUEUE_POLL_MS, remaining));
  await sleep(duration);
}

function isActiveConflictError(error) {
  return error?.code === 'client_active'
    || error?.code === 'ip_active'
    || /client_active|ip_active/.test(String(error?.message || ''));
}

export async function runQueuedVote(storeOrOptions = {}, maybeOptions = {}) {
  const options = normalizeRunArguments(storeOrOptions, maybeOptions);
  const queueStore = options.queueStore || options.store || getVoteQueueStore();
  const nowFn = options.nowFn || Date.now;
  const sleep = options.sleep || options.sleepFn || delay;
  const submit = options.submit || options.submitVote;
  const maxWaitMs = Math.max(0, Math.trunc(Number(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)));

  if (typeof submit !== 'function') throw queueError('submit_required', 500);

  const startedAt = currentTime(nowFn);
  const entry = createVoteQueueEntry({
    identity: options.identity,
    vote: options.vote,
    now: startedAt,
    id: options.id || randomUUID(),
  });

  let enqueued = false;
  let processing = null;

  try {
    while (!enqueued) {
      try {
        await enqueueVoteEntry(queueStore, entry, currentTime(nowFn));
        enqueued = true;
      } catch (error) {
        if (!isActiveConflictError(error)) throw error;
        await waitWithinBudget({
          startedAt,
          maxWaitMs,
          nowFn,
          sleep,
          waitMs: QUEUE_POLL_MS,
        });
      }
    }

    while (!processing) {
      const now = currentTime(nowFn);
      const state = await readQueueState(queueStore, now);
      const currentEntry = state.entries.find((candidate) => candidate.id === entry.id);
      if (!currentEntry) throw queueError('queue_entry_missing', 409);

      if (currentEntry.state === 'processing') {
        processing = clone(currentEntry);
        break;
      }

      if (state.processingId) {
        await waitWithinBudget({
          startedAt,
          maxWaitMs,
          nowFn,
          sleep,
          waitMs: QUEUE_POLL_MS,
        });
        continue;
      }

      const next = selectNextVoteEntry(state.entries, state.lastClientId);
      if (next?.id !== entry.id) {
        await waitWithinBudget({
          startedAt,
          maxWaitMs,
          nowFn,
          sleep,
          waitMs: QUEUE_POLL_MS,
        });
        continue;
      }

      const intervalMs = millisecondsUntilVoteAllowed(state, now);
      if (intervalMs > 0) {
        await waitWithinBudget({
          startedAt,
          maxWaitMs,
          nowFn,
          sleep,
          waitMs: intervalMs,
        });
        continue;
      }

      processing = await markVoteEntryProcessing(queueStore, entry.id, now);
      if (!processing) {
        await waitWithinBudget({
          startedAt,
          maxWaitMs,
          nowFn,
          sleep,
          waitMs: QUEUE_POLL_MS,
        });
      }
    }

    const submissionAt = currentTime(nowFn);
    try {
      return await submit(clone(processing.privateVote));
    } finally {
      await removeVoteEntry(queueStore, processing.id, {
        lastSubmissionAt: submissionAt,
        lastClientId: processing.clientId,
      }, submissionAt);
    }
  } catch (error) {
    if (enqueued && !processing) {
      await removeVoteEntry(queueStore, entry.id, {}, currentTime(nowFn)).catch(() => {});
    }
    throw error;
  }
}

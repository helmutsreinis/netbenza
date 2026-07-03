# Global Vote Queue And Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strict one-session-per-`clientId`, one-profile-per-IP collaboration layer with public fair vote queueing, a 2 second global vote rate limit, and compact connected-user chat.

**Architecture:** Extend the existing Netlify Blob-backed presence system with `sessionId` and server-derived `ipKey` validation. Add focused stores for vote queueing and chat, then wire the existing `/api/vote` route through the queue. The frontend keeps the current sequential vote loop, but shuffles bulk ids, includes active identity/session metadata, polls public queue/chat snapshots, and blocks replaced sessions.

**Tech Stack:** Vanilla HTML/CSS/JS, Netlify Functions in ESM JavaScript, Netlify Blobs, Node built-in test runner, jsdom.

---

## File Structure

- Modify `netlify/functions/lib/presence-store.mjs`: add `sessionId`, `ipKey`, request IP normalization, stale-session detection, per-IP profile replacement, and active-session assertions.
- Create `netlify/functions/lib/vote-queue-store.mjs`: manage public/private queue entries, one active entry per `clientId`/`ipKey`, round-robin selection, and 2 second scheduling.
- Create `netlify/functions/vote-queue.mjs`: expose `GET /api/vote/queue` for public queue snapshots.
- Modify `netlify/functions/vote.mjs`: export an injectable `handleVoteRequest` and run each vote through `vote-queue-store`.
- Create `netlify/functions/lib/chat-store.mjs`: normalize and persist rolling chat messages with active-session validation.
- Create `netlify/functions/chat.mjs`: expose `GET/POST /api/chat`.
- Modify `gdebenz_ui/static/index.html`: add replaced-session modal, queue panel, and chat panel.
- Modify `gdebenz_ui/static/style.css`: style compact queue/chat/session states and keep header roster from overflowing.
- Modify `gdebenz_ui/static/app.js`: generate per-load `sessionId`, include session metadata in presence/vote/chat, shuffle vote ids, poll queue/chat, render queue/chat, and block stale sessions.
- Modify `tests/presence.test.mjs`: cover session/IP replacement and public snapshot privacy.
- Create `tests/vote-queue.test.mjs`: cover queue public fields, per-user/per-IP bounds, fair selection, and rate timing.
- Create `tests/netlify-vote-queue-route.test.mjs`: cover `/api/vote` queue integration and stale-session rejection.
- Create `tests/chat.test.mjs`: cover chat normalization, rolling history, and stale-session rejection.
- Modify `tests/frontend-dom.test.mjs`: cover queue/chat rendering, shuffled vote ids, session metadata, and replaced-session blocking.

---

### Task 1: Presence Session And IP Enforcement

**Files:**
- Modify: `netlify/functions/lib/presence-store.mjs`
- Modify: `tests/presence.test.mjs`

- [ ] **Step 1: Write failing tests for `sessionId` and IP replacement**

Append these tests to `tests/presence.test.mjs`:

```javascript
it('keeps only the newest session for a clientId', async () => {
  const store = new MemoryPresenceStore();
  const now = 3_000_000;

  await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({
      clientId: 'same-client',
      sessionId: 'old-session',
      handle: 'Old Tab',
      avatar: '/avatars/a.png',
      activity: 'online',
    }),
  }), store, () => now);

  await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({
      clientId: 'same-client',
      sessionId: 'new-session',
      handle: 'New Tab',
      avatar: '/avatars/b.png',
      activity: 'searching',
    }),
  }), store, () => now + 1000);

  const staleResponse = await handlePresenceRequest(new Request(
    'https://site.test/api/presence?clientId=same-client&sessionId=old-session',
    { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.10' } },
  ), store, () => now + 1500);
  const staleJson = await staleResponse.json();

  assert.equal(staleJson.session.active, false);
  assert.equal(staleJson.session.reason, 'client_replaced');
  assert.deepEqual(staleJson.users.map((user) => user.handle), ['New Tab']);
});

it('keeps only the newest profile for an IP address without exposing the IP', async () => {
  const store = new MemoryPresenceStore();
  const now = 4_000_000;

  await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '198.51.100.77' },
    body: JSON.stringify({
      clientId: 'first-client',
      sessionId: 'first-session',
      handle: 'First',
      avatar: '/avatars/first.png',
      activity: 'online',
    }),
  }), store, () => now);

  const replacementResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '198.51.100.77' },
    body: JSON.stringify({
      clientId: 'second-client',
      sessionId: 'second-session',
      handle: 'Second',
      avatar: '/avatars/second.png',
      activity: 'online',
    }),
  }), store, () => now + 1000);
  const replacementJson = await replacementResponse.json();

  assert.deepEqual(replacementJson.users.map((user) => user.clientId), ['second-client']);
  assert.equal(Object.hasOwn(replacementJson.users[0], 'ipKey'), false);

  const staleResponse = await handlePresenceRequest(new Request(
    'https://site.test/api/presence?clientId=first-client&sessionId=first-session',
    { method: 'GET', headers: { 'x-forwarded-for': '198.51.100.77, 10.0.0.1' } },
  ), store, () => now + 1500);
  const staleJson = await staleResponse.json();

  assert.equal(staleJson.session.active, false);
  assert.equal(staleJson.session.reason, 'ip_replaced');
});

it('ignores stale DELETE calls so old tabs cannot remove the active session', async () => {
  const store = new MemoryPresenceStore();
  const now = 5_000_000;

  await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.22' },
    body: JSON.stringify({
      clientId: 'client-one',
      sessionId: 'session-current',
      handle: 'Current',
      avatar: '/avatars/current.png',
      activity: 'online',
    }),
  }), store, () => now);

  const deleteResponse = await handlePresenceRequest(new Request(
    'https://site.test/api/presence?clientId=client-one&sessionId=session-old',
    { method: 'DELETE', headers: { 'x-forwarded-for': '203.0.113.22' } },
  ), store, () => now + 500);
  const deleteJson = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteJson.users.map((user) => user.sessionId), ['session-current']);
});
```

- [ ] **Step 2: Run the presence tests and verify RED**

Run:

```bash
npm test -- tests/presence.test.mjs
```

Expected: FAIL because `sessionId`, `session`, `ipKey`, and stale-delete behavior do not exist yet.

- [ ] **Step 3: Implement request IP and session normalization**

In `netlify/functions/lib/presence-store.mjs`, add these helpers near the existing normalization helpers:

```javascript
function normalizeSessionId(value) {
  const normalized = clip(value, 120)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('sessionId is required');
  return normalized;
}

export function requestIpKey(req) {
  const headers = req?.headers;
  const raw = headers?.get('x-nf-client-connection-ip')
    || headers?.get('client-ip')
    || headers?.get('cf-connecting-ip')
    || headers?.get('x-real-ip')
    || headers?.get('x-forwarded-for')
    || 'local';
  const first = String(raw).split(',')[0].trim().toLowerCase();
  const safe = first.replace(/[^a-z0-9:._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `ip:${safe || 'local'}`;
}
```

Update `normalizePresenceBody` so it returns `sessionId`:

```javascript
export function normalizePresenceBody(body = {}) {
  const activity = ALLOWED_ACTIVITIES.has(body.activity) ? body.activity : 'online';
  const avatar = clip(body.avatar, 240);
  const detail = typeof body.detail === 'string' ? body.detail : '';

  return {
    clientId: normalizeClientId(body.clientId),
    sessionId: normalizeSessionId(body.sessionId),
    handle: clip(body.handle, 32) || 'Anonymous',
    avatar: avatar.startsWith('/avatars/') || avatar.startsWith('/static/avatars/') ? avatar : '',
    activity,
    detail: clip(detail, 80),
  };
}
```

- [ ] **Step 4: Implement active-session records and public snapshots**

Replace `createPresenceRecord`, `publicUser`, and add session helpers:

```javascript
export function createPresenceRecord(normalized, now = Date.now(), ipKey = 'ip:local') {
  return {
    clientId: normalized.clientId,
    sessionId: normalized.sessionId,
    ipKey,
    handle: normalized.handle,
    avatar: normalized.avatar,
    activity: normalized.activity,
    detail: normalized.detail,
    lastSeen: now,
  };
}

function publicUser(record) {
  return {
    clientId: record.clientId,
    sessionId: record.sessionId,
    handle: record.handle,
    avatar: record.avatar,
    activity: record.activity,
    detail: record.detail,
    lastSeen: record.lastSeen,
  };
}

function viewerFromRequest(req) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') || '';
  const sessionId = url.searchParams.get('sessionId') || '';
  if (!clientId || !sessionId) return null;
  return {
    clientId: normalizeClientId(clientId),
    sessionId: normalizeSessionId(sessionId),
    ipKey: requestIpKey(req),
  };
}

export async function activeSessionStatus(store, viewer, now = Date.now()) {
  if (!viewer?.clientId || !viewer?.sessionId) return { active: true, reason: '' };
  const current = await store.get(presenceKey(viewer.clientId), { type: 'json' }).catch(() => null);
  if (current?.clientId === viewer.clientId) {
    if (now - Number(current.lastSeen || 0) > ACTIVE_WINDOW_MS) {
      return { active: false, reason: 'expired' };
    }
    if (current.sessionId !== viewer.sessionId) {
      return { active: false, reason: 'client_replaced' };
    }
    if (current.ipKey !== viewer.ipKey) {
      return { active: false, reason: 'ip_changed' };
    }
    return { active: true, reason: '' };
  }

  const { blobs = [] } = await store.list({ prefix: 'users/' });
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record?.lastSeen || now - Number(record.lastSeen) > ACTIVE_WINDOW_MS) continue;
    if (record.ipKey === viewer.ipKey) return { active: false, reason: 'ip_replaced' };
  }
  return { active: false, reason: 'missing' };
}

export async function assertActiveSession(store, viewer, now = Date.now()) {
  const status = await activeSessionStatus(store, viewer, now);
  if (status.active) return status;
  const error = new Error(status.reason || 'session_replaced');
  error.status = 409;
  error.code = status.reason || 'session_replaced';
  throw error;
}
```

Update `presenceSnapshot` to accept an optional viewer and include `session`:

```javascript
export async function presenceSnapshot(store, now = Date.now(), viewer = null) {
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
    session: viewer ? await activeSessionStatus(store, viewer, now) : { active: true, reason: '' },
    activeWindowMs: ACTIVE_WINDOW_MS,
    serverTime: now,
  };
}
```

- [ ] **Step 5: Implement per-IP replacement on presence POST and safe DELETE**

In `handlePresenceRequest`, derive `ipKey`, delete any active records from the same IP but a different `clientId`, and only allow DELETE to remove the matching `sessionId`:

```javascript
async function removeProfilesForIp(store, ipKey, keepClientId, now) {
  const { blobs = [] } = await store.list({ prefix: 'users/' });
  await Promise.all(blobs.map(async (blob) => {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record?.clientId) return;
    if (now - Number(record.lastSeen || 0) > ACTIVE_WINDOW_MS) {
      await store.delete(blob.key).catch(() => {});
      return;
    }
    if (record.ipKey === ipKey && record.clientId !== keepClientId) {
      await store.delete(blob.key).catch(() => {});
    }
  }));
}
```

Update the handler branches:

```javascript
export async function handlePresenceRequest(req, store = getPresenceStore(), nowFn = Date.now) {
  const now = nowFn();

  if (req.method === 'GET') {
    return json(await presenceSnapshot(store, now, viewerFromRequest(req)));
  }

  if (req.method === 'POST') {
    try {
      const normalized = normalizePresenceBody(await readJson(req));
      const ipKey = requestIpKey(req);
      await removeProfilesForIp(store, ipKey, normalized.clientId, now);
      await store.setJSON(presenceKey(normalized.clientId), createPresenceRecord(normalized, now, ipKey));
      return json(await presenceSnapshot(store, now, {
        clientId: normalized.clientId,
        sessionId: normalized.sessionId,
        ipKey,
      }));
    } catch (error) {
      return json({ detail: error.message || 'Invalid presence payload' }, { status: 400 });
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const clientId = url.searchParams.get('clientId');
    const sessionId = url.searchParams.get('sessionId');
    if (clientId && sessionId) {
      const normalizedClientId = normalizeClientId(clientId);
      const normalizedSessionId = normalizeSessionId(sessionId);
      const record = await store.get(presenceKey(normalizedClientId), { type: 'json' }).catch(() => null);
      if (record?.sessionId === normalizedSessionId) {
        await store.delete(presenceKey(normalizedClientId)).catch(() => {});
      }
    }
    return json(await presenceSnapshot(store, now, viewerFromRequest(req)));
  }

  return json({ detail: 'Method not allowed. Use GET, POST, DELETE' }, {
    status: 405,
    headers: { allow: 'GET, POST, DELETE' },
  });
}
```

- [ ] **Step 6: Run presence tests and verify GREEN**

Run:

```bash
npm test -- tests/presence.test.mjs
```

Expected: PASS for all presence tests.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add netlify/functions/lib/presence-store.mjs tests/presence.test.mjs
git commit -m "Add session and IP presence enforcement"
```

---

### Task 2: Fair Vote Queue Store

**Files:**
- Create: `netlify/functions/lib/vote-queue-store.mjs`
- Create: `tests/vote-queue.test.mjs`

- [ ] **Step 1: Write failing queue store tests**

Create `tests/vote-queue.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryPresenceStore,
} from '../netlify/functions/lib/presence-store.mjs';

import {
  VOTE_INTERVAL_MS,
  createVoteQueueEntry,
  enqueueVoteEntry,
  millisecondsUntilVoteAllowed,
  publicQueueSnapshot,
  readQueueState,
  removeVoteEntry,
  selectNextVoteEntry,
} from '../netlify/functions/lib/vote-queue-store.mjs';

const alice = {
  clientId: 'alice',
  sessionId: 'alice-session',
  ipKey: 'ip:203.0.113.1',
  handle: 'Alice',
  avatar: '/avatars/a.png',
};

const bob = {
  clientId: 'bob',
  sessionId: 'bob-session',
  ipKey: 'ip:203.0.113.2',
  handle: 'Bob',
  avatar: '/avatars/b.png',
};

describe('vote queue store', () => {
  it('exposes only public queue fields', () => {
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: {
        source: 'gdebenz',
        osmId: '101',
        status: 'yes',
        text: 'secret comment',
        fingerprint: 'secret-fp',
        lat: 55.7,
        lon: 37.6,
      },
      now: 10_000,
      id: 'queue-1',
    });

    const snapshot = publicQueueSnapshot({
      entries: [entry],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: '',
    }, 12_000);

    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].clientId, 'alice');
    assert.equal(snapshot.entries[0].handle, 'Alice');
    assert.equal(snapshot.entries[0].stationId, '101');
    assert.equal(snapshot.entries[0].queuedAgeMs, 2000);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'ipKey'), false);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'sessionId'), false);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'text'), false);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'fingerprint'), false);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'lat'), false);
    assert.equal(Object.hasOwn(snapshot.entries[0], 'lon'), false);
  });

  it('allows one active queued or processing vote per clientId and per ipKey', async () => {
    const store = new MemoryPresenceStore();
    const first = createVoteQueueEntry({
      identity: alice,
      vote: { source: 'gdebenz', osmId: '101', status: 'yes' },
      now: 100,
      id: 'first',
    });
    const secondSameClient = createVoteQueueEntry({
      identity: alice,
      vote: { source: 'gdebenz', osmId: '102', status: 'no' },
      now: 101,
      id: 'second',
    });
    const thirdSameIp = createVoteQueueEntry({
      identity: { ...bob, ipKey: alice.ipKey },
      vote: { source: 'gdebenz', osmId: '103', status: 'queue' },
      now: 102,
      id: 'third',
    });

    await enqueueVoteEntry(store, first);
    await assert.rejects(() => enqueueVoteEntry(store, secondSameClient), /client_active/);
    await assert.rejects(() => enqueueVoteEntry(store, thirdSameIp), /ip_active/);
  });

  it('rotates selection across clientIds after the last submitted client', () => {
    const entries = [
      createVoteQueueEntry({
        identity: alice,
        vote: { source: 'gdebenz', osmId: '101', status: 'yes' },
        now: 100,
        id: 'a1',
      }),
      createVoteQueueEntry({
        identity: bob,
        vote: { source: 'gdebenz', osmId: '201', status: 'no' },
        now: 110,
        id: 'b1',
      }),
    ];

    assert.equal(selectNextVoteEntry(entries, '').id, 'a1');
    assert.equal(selectNextVoteEntry(entries, 'alice').id, 'b1');
    assert.equal(selectNextVoteEntry(entries, 'bob').id, 'a1');
  });

  it('enforces the global two second interval', () => {
    assert.equal(millisecondsUntilVoteAllowed({ lastSubmissionAt: 0 }, 1000), 0);
    assert.equal(millisecondsUntilVoteAllowed({ lastSubmissionAt: 10_000 }, 10_500), 1500);
    assert.equal(millisecondsUntilVoteAllowed({ lastSubmissionAt: 10_000 }, 12_000), 0);
    assert.equal(VOTE_INTERVAL_MS, 2000);
  });

  it('removes completed entries from the queue state', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: { source: 'gdebenz', osmId: '101', status: 'yes' },
      now: 100,
      id: 'done-entry',
    });

    await enqueueVoteEntry(store, entry);
    await removeVoteEntry(store, entry.id, { lastSubmissionAt: 3000, lastClientId: 'alice' });
    const state = await readQueueState(store);

    assert.deepEqual(state.entries, []);
    assert.equal(state.lastSubmissionAt, 3000);
    assert.equal(state.lastClientId, 'alice');
  });
});
```

- [ ] **Step 2: Run queue tests and verify RED**

Run:

```bash
npm test -- tests/vote-queue.test.mjs
```

Expected: FAIL because `vote-queue-store.mjs` does not exist.

- [ ] **Step 3: Implement the queue store**

Create `netlify/functions/lib/vote-queue-store.mjs`:

```javascript
import { getStore } from '@netlify/blobs';

export const VOTE_INTERVAL_MS = 2000;
const QUEUE_STATE_KEY = 'vote-queue/state';

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
  return structuredClone(value);
}

export async function readQueueState(store = getVoteQueueStore()) {
  const state = await store.get(QUEUE_STATE_KEY, { type: 'json' }).catch(() => null);
  if (!state || !Array.isArray(state.entries)) return defaultQueueState();
  return {
    entries: state.entries,
    lastSubmissionAt: Number(state.lastSubmissionAt || 0),
    lastClientId: String(state.lastClientId || ''),
    processingId: String(state.processingId || ''),
  };
}

async function writeQueueState(store, state) {
  await store.setJSON(QUEUE_STATE_KEY, {
    entries: state.entries,
    lastSubmissionAt: Number(state.lastSubmissionAt || 0),
    lastClientId: String(state.lastClientId || ''),
    processingId: String(state.processingId || ''),
  });
}

export function createVoteQueueEntry({ identity, vote, now = Date.now(), id = crypto.randomUUID() }) {
  return {
    id,
    clientId: identity.clientId,
    sessionId: identity.sessionId,
    ipKey: identity.ipKey,
    handle: identity.handle || 'Anonymous',
    avatar: identity.avatar || '',
    source: vote.source || 'gdebenz',
    stationId: String(vote.osmId || vote.osm_id || ''),
    status: vote.status || vote.vote_status || '',
    queuedAt: now,
    state: 'queued',
    privateVote: clone(vote),
  };
}

function activeEntries(entries) {
  return entries.filter((entry) => entry.state === 'queued' || entry.state === 'processing');
}

function activeConflict(entries, entry) {
  const active = activeEntries(entries);
  if (active.some((candidate) => candidate.clientId === entry.clientId)) return 'client_active';
  if (active.some((candidate) => candidate.ipKey === entry.ipKey)) return 'ip_active';
  return '';
}

export async function enqueueVoteEntry(store, entry) {
  const state = await readQueueState(store);
  const conflict = activeConflict(state.entries, entry);
  if (conflict) {
    const error = new Error(conflict);
    error.code = conflict;
    throw error;
  }
  state.entries.push(entry);
  await writeQueueState(store, state);
  return entry;
}

export function selectNextVoteEntry(entries, lastClientId = '') {
  const queued = entries
    .filter((entry) => entry.state === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
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

export function millisecondsUntilVoteAllowed(state, now = Date.now()) {
  if (!state.lastSubmissionAt) return 0;
  return Math.max(0, VOTE_INTERVAL_MS - (now - Number(state.lastSubmissionAt)));
}

export async function markVoteEntryProcessing(store, entryId) {
  const state = await readQueueState(store);
  if (state.processingId && state.processingId !== entryId) return false;
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.state !== 'queued') return false;
  entry.state = 'processing';
  state.processingId = entryId;
  await writeQueueState(store, state);
  return true;
}

export async function removeVoteEntry(store, entryId, completion = {}) {
  const state = await readQueueState(store);
  state.entries = state.entries.filter((entry) => entry.id !== entryId);
  if (state.processingId === entryId) state.processingId = '';
  if (completion.lastSubmissionAt !== undefined) {
    state.lastSubmissionAt = Number(completion.lastSubmissionAt || 0);
  }
  if (completion.lastClientId !== undefined) {
    state.lastClientId = String(completion.lastClientId || '');
  }
  await writeQueueState(store, state);
}

function publicEntry(entry, now) {
  return {
    id: entry.id,
    clientId: entry.clientId,
    handle: entry.handle,
    avatar: entry.avatar,
    source: entry.source,
    stationId: entry.stationId,
    status: entry.status,
    queuedAt: entry.queuedAt,
    queuedAgeMs: Math.max(0, now - Number(entry.queuedAt || now)),
    state: entry.state,
  };
}

export function publicQueueSnapshot(state, now = Date.now()) {
  const entries = [...state.entries]
    .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id))
    .map((entry, index) => ({
      ...publicEntry(entry, now),
      position: index + 1,
    }));
  return {
    entries,
    processing: entries.find((entry) => entry.state === 'processing') || null,
    nextAllowedAt: state.lastSubmissionAt ? Number(state.lastSubmissionAt) + VOTE_INTERVAL_MS : now,
    serverTime: now,
  };
}
```

- [ ] **Step 4: Run queue tests and verify GREEN**

Run:

```bash
npm test -- tests/vote-queue.test.mjs
```

Expected: PASS for all queue store tests.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add netlify/functions/lib/vote-queue-store.mjs tests/vote-queue.test.mjs
git commit -m "Add fair vote queue store"
```

---

### Task 3: Vote Queue API And Vote Route Integration

**Files:**
- Modify: `netlify/functions/vote.mjs`
- Create: `netlify/functions/vote-queue.mjs`
- Create: `tests/netlify-vote-queue-route.test.mjs`
- Modify: `scripts/check-functions.mjs` only if it enumerates functions manually and omits dynamic discovery

- [ ] **Step 1: Write failing route tests**

Create `tests/netlify-vote-queue-route.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryPresenceStore,
  createPresenceRecord,
  presenceKey,
} from '../netlify/functions/lib/presence-store.mjs';
import { readQueueState } from '../netlify/functions/lib/vote-queue-store.mjs';
import { handleVoteRequest } from '../netlify/functions/vote.mjs';
import voteQueueHandler from '../netlify/functions/vote-queue.mjs';

function activeRecord(overrides = {}) {
  return createPresenceRecord({
    clientId: overrides.clientId || 'client-one',
    sessionId: overrides.sessionId || 'session-one',
    handle: overrides.handle || 'Operator',
    avatar: overrides.avatar || '/avatars/a.png',
    activity: 'online',
    detail: '',
  }, overrides.now || 1_000_000, overrides.ipKey || 'ip:203.0.113.44');
}

describe('Netlify queued vote route', () => {
  it('submits an active Benzin vote through the queue', async () => {
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    await presenceStore.setJSON(presenceKey('client-one'), activeRecord());

    const postedBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://map.benzin-status.tech/api/reports');
      postedBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      let now = 1_000_100;
      const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.44' },
        body: JSON.stringify({
          clientId: 'client-one',
          sessionId: 'session-one',
          source: 'benzin',
          osm_ids: ['123'],
          vote_status: 'available',
        }),
      }), {
        presenceStore,
        queueStore,
        nowFn: () => now += 2100,
        sleep: async () => {},
      });
      const body = await response.json();
      const state = await readQueueState(queueStore);

      assert.equal(response.status, 200);
      assert.deepEqual(postedBodies, [{
        station_id: 123,
        status: 'available',
        fuel_types: [],
        prices: {},
      }]);
      assert.equal(body[0].success, true);
      assert.deepEqual(state.entries, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects stale sessions before enqueueing a vote', async () => {
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    await presenceStore.setJSON(presenceKey('client-one'), activeRecord({
      sessionId: 'new-session',
      now: 2_000_000,
    }));

    const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.44' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'old-session',
        source: 'benzin',
        osm_ids: ['123'],
        vote_status: 'available',
      }),
    }), {
      presenceStore,
      queueStore,
      nowFn: () => 2_000_500,
      sleep: async () => {},
    });
    const body = await response.json();
    const state = await readQueueState(queueStore);

    assert.equal(response.status, 409);
    assert.match(body.detail, /client_replaced/);
    assert.deepEqual(state.entries, []);
  });

  it('returns a public queue snapshot without private fields', async () => {
    const queueStore = new MemoryPresenceStore();
    const response = await voteQueueHandler(new Request('http://localhost/api/vote/queue'), {
      queueStore,
      nowFn: () => 10_000,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.entries, []);
    assert.equal(Object.hasOwn(body, 'ipKey'), false);
  });
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run:

```bash
npm test -- tests/netlify-vote-queue-route.test.mjs
```

Expected: FAIL because `handleVoteRequest`, `vote-queue.mjs`, and route queueing do not exist yet.

- [ ] **Step 3: Add queue processing helper to `vote-queue-store.mjs`**

Append this processing function:

```javascript
export async function runQueuedVote({
  queueStore = getVoteQueueStore(),
  identity,
  vote,
  submit,
  nowFn = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  id = crypto.randomUUID(),
  maxWaitMs = 60_000,
}) {
  const startedAt = nowFn();
  const entry = createVoteQueueEntry({ identity, vote, now: startedAt, id });

  while (true) {
    try {
      await enqueueVoteEntry(queueStore, entry);
      break;
    } catch (error) {
      if (error.code !== 'client_active' && error.code !== 'ip_active') throw error;
      if (nowFn() - startedAt > maxWaitMs) throw new Error('queue_wait_timeout');
      await sleep(250);
    }
  }

  try {
    while (true) {
      const state = await readQueueState(queueStore);
      const next = state.processingId ? null : selectNextVoteEntry(state.entries, state.lastClientId);
      const waitMs = millisecondsUntilVoteAllowed(state, nowFn());
      if (next?.id === entry.id && waitMs === 0) {
        const marked = await markVoteEntryProcessing(queueStore, entry.id);
        if (marked) break;
      }
      if (nowFn() - startedAt > maxWaitMs) throw new Error('queue_wait_timeout');
      await sleep(Math.max(100, Math.min(waitMs || 250, 500)));
    }

    const result = await submit(entry.privateVote);
    await removeVoteEntry(queueStore, entry.id, {
      lastSubmissionAt: nowFn(),
      lastClientId: entry.clientId,
    });
    return result;
  } catch (error) {
    await removeVoteEntry(queueStore, entry.id).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 4: Create the public queue endpoint**

Create `netlify/functions/vote-queue.mjs`:

```javascript
import {
  getVoteQueueStore,
  publicQueueSnapshot,
  readQueueState,
} from './lib/vote-queue-store.mjs';
import { jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const queueStore = options.queueStore || getVoteQueueStore();
  const nowFn = options.nowFn || Date.now;
  const state = await readQueueState(queueStore);
  return jsonResponse(publicQueueSnapshot(state, nowFn()));
}

export const config = { path: '/api/vote/queue' };
```

- [ ] **Step 5: Integrate queueing into `vote.mjs`**

Restructure `netlify/functions/vote.mjs` so it exports `handleVoteRequest` and queues each single-station vote:

```javascript
import { STATUSES, resolveCoords, submitVote } from './lib/gdebenz-client.mjs';
import { BENZIN_STATUSES, submitBenzinReport } from './lib/benzin-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';
import {
  assertActiveSession,
  getPresenceStore,
  requestIpKey,
} from './lib/presence-store.mjs';
import {
  getVoteQueueStore,
  runQueuedVote,
} from './lib/vote-queue-store.mjs';

function identityFromBodyAndRequest(body, req) {
  return {
    clientId: body.clientId || '',
    sessionId: body.sessionId || '',
    ipKey: requestIpKey(req),
    handle: body.handle || 'Anonymous',
    avatar: body.avatar || '',
  };
}

function staleSessionResponse(error) {
  return error?.status === 409
    ? errorResponse(409, error.code || error.message || 'session_replaced')
    : null;
}

export async function handleVoteRequest(req, options = {}) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const body = await readJson(req);
  const source = body.source || 'gdebenz';
  const presenceStore = options.presenceStore || getPresenceStore();
  const queueStore = options.queueStore || getVoteQueueStore();
  const nowFn = options.nowFn || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const identity = identityFromBodyAndRequest(body, req);

  try {
    await assertActiveSession(presenceStore, identity, nowFn());
  } catch (error) {
    const response = staleSessionResponse(error);
    if (response) return response;
    throw error;
  }

  if (source === 'benzin') {
    if (!BENZIN_STATUSES.includes(body.vote_status)) {
      return errorResponse(400, `Invalid status: ${body.vote_status}`);
    }
    if (!Array.isArray(body.osm_ids)) {
      return errorResponse(400, 'osm_ids must be an array');
    }
    const results = [];
    for (const osmId of body.osm_ids) {
      try {
        results.push(await runQueuedVote({
          queueStore,
          identity,
          vote: {
            source,
            osmId: String(osmId),
            status: body.vote_status,
          },
          submit: (vote) => submitBenzinReport({
            stationId: vote.osmId,
            status: vote.status,
          }),
          nowFn,
          sleep,
        }));
      } catch (error) {
        results.push({
          osm_id: String(osmId),
          name: `Station #${osmId}`,
          success: false,
          reason: error.message || 'Vote failed',
        });
      }
    }
    return jsonResponse(results);
  }

  if (!STATUSES.includes(body.vote_status)) {
    return errorResponse(400, `Invalid status: ${body.vote_status}`);
  }
  if (!Array.isArray(body.osm_ids)) {
    return errorResponse(400, 'osm_ids must be an array');
  }

  let voterCoords = { lat: 0, lon: 0 };
  if (body.city || (body.lat && body.lon)) {
    voterCoords = await resolveCoords({
      city: body.city,
      lat: Number(body.lat),
      lon: Number(body.lon),
    }).catch(() => ({ lat: 0, lon: 0 }));
  }

  const results = [];
  for (const osmId of body.osm_ids) {
    try {
      results.push(await runQueuedVote({
        queueStore,
        identity,
        vote: {
          source,
          osmId: String(osmId),
          status: body.vote_status,
          text: body.text || '',
          vlat: voterCoords.lat,
          vlon: voterCoords.lon,
          fingerprint: body.fingerprint || '',
        },
        submit: (vote) => submitVote({
          osm_id: vote.osmId,
          status: vote.status,
          text: vote.text,
          vlat: vote.vlat,
          vlon: vote.vlon,
          fingerprint: vote.fingerprint,
        }),
        nowFn,
        sleep,
      }));
    } catch (error) {
      results.push({
        osm_id: String(osmId),
        name: '',
        success: false,
        reason: error.message || 'Vote failed',
      });
    }
  }

  return jsonResponse(results);
}

export default async function handler(req) {
  return handleVoteRequest(req);
}

export const config = { path: '/api/vote' };
```

- [ ] **Step 6: Run route tests and existing Benzin tests**

Run:

```bash
npm test -- tests/netlify-vote-queue-route.test.mjs tests/netlify-benzin.test.mjs
```

Expected: the new route tests PASS. If `tests/netlify-benzin.test.mjs` fails because it posts without active identity, update that test to create an active presence record and call `handleVoteRequest` with injected stores; then re-run until both files pass.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add netlify/functions/vote.mjs netlify/functions/vote-queue.mjs netlify/functions/lib/vote-queue-store.mjs tests/netlify-vote-queue-route.test.mjs tests/netlify-benzin.test.mjs scripts/check-functions.mjs
git commit -m "Route votes through the global queue"
```

---

### Task 4: Connected User Chat

**Files:**
- Create: `netlify/functions/lib/chat-store.mjs`
- Create: `netlify/functions/chat.mjs`
- Create: `tests/chat.test.mjs`

- [ ] **Step 1: Write failing chat tests**

Create `tests/chat.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryPresenceStore,
  createPresenceRecord,
  presenceKey,
} from '../netlify/functions/lib/presence-store.mjs';
import {
  appendChatMessage,
  chatSnapshot,
  normalizeChatText,
} from '../netlify/functions/lib/chat-store.mjs';
import { handleChatRequest } from '../netlify/functions/chat.mjs';

function identity() {
  return {
    clientId: 'client-one',
    sessionId: 'session-one',
    ipKey: 'ip:203.0.113.55',
    handle: 'Operator',
    avatar: '/avatars/a.png',
  };
}

describe('chat store', () => {
  it('normalizes and clips chat text', () => {
    assert.equal(normalizeChatText('  hello  '), 'hello');
    assert.equal(normalizeChatText('x'.repeat(600)).length, 240);
  });

  it('stores a rolling public message history', async () => {
    const store = new MemoryPresenceStore();
    const base = identity();
    for (let index = 0; index < 55; index += 1) {
      await appendChatMessage(store, {
        identity: base,
        text: `message ${index}`,
        now: 1_000 + index,
        id: `msg-${index}`,
      });
    }

    const snapshot = await chatSnapshot(store, 2_000);

    assert.equal(snapshot.messages.length, 50);
    assert.equal(snapshot.messages[0].text, 'message 5');
    assert.equal(snapshot.messages[49].text, 'message 54');
    assert.equal(Object.hasOwn(snapshot.messages[0], 'ipKey'), false);
    assert.equal(Object.hasOwn(snapshot.messages[0], 'sessionId'), false);
  });

  it('rejects stale chat posts', async () => {
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();
    await presenceStore.setJSON(presenceKey('client-one'), createPresenceRecord({
      clientId: 'client-one',
      sessionId: 'fresh-session',
      handle: 'Operator',
      avatar: '/avatars/a.png',
      activity: 'online',
      detail: '',
    }, 5_000, 'ip:203.0.113.55'));

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'stale-session',
        text: 'should not send',
      }),
    }), {
      presenceStore,
      chatStore,
      nowFn: () => 5_500,
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.detail, /client_replaced/);
  });
});
```

- [ ] **Step 2: Run chat tests and verify RED**

Run:

```bash
npm test -- tests/chat.test.mjs
```

Expected: FAIL because chat store and route files do not exist.

- [ ] **Step 3: Implement `chat-store.mjs`**

Create `netlify/functions/lib/chat-store.mjs`:

```javascript
import { getStore } from '@netlify/blobs';

const CHAT_STATE_KEY = 'chat/messages';
export const CHAT_MAX_MESSAGES = 50;
export const CHAT_MAX_TEXT_LENGTH = 240;

export function getChatStore() {
  return getStore({ name: 'gdebenz-chat', consistency: 'strong' });
}

export function normalizeChatText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, CHAT_MAX_TEXT_LENGTH);
}

async function readChatState(store = getChatStore()) {
  const state = await store.get(CHAT_STATE_KEY, { type: 'json' }).catch(() => null);
  return { messages: Array.isArray(state?.messages) ? state.messages : [] };
}

async function writeChatState(store, state) {
  await store.setJSON(CHAT_STATE_KEY, {
    messages: state.messages.slice(-CHAT_MAX_MESSAGES),
  });
}

function publicMessage(message) {
  return {
    id: message.id,
    clientId: message.clientId,
    handle: message.handle,
    avatar: message.avatar,
    text: message.text,
    createdAt: message.createdAt,
  };
}

export async function appendChatMessage(store, { identity, text, now = Date.now(), id = crypto.randomUUID() }) {
  const normalizedText = normalizeChatText(text);
  if (!normalizedText) {
    const error = new Error('message_required');
    error.status = 400;
    throw error;
  }
  const state = await readChatState(store);
  state.messages.push({
    id,
    clientId: identity.clientId,
    sessionId: identity.sessionId,
    ipKey: identity.ipKey,
    handle: identity.handle || 'Anonymous',
    avatar: identity.avatar || '',
    text: normalizedText,
    createdAt: now,
  });
  await writeChatState(store, state);
  return publicMessage(state.messages[state.messages.length - 1]);
}

export async function chatSnapshot(store = getChatStore(), now = Date.now()) {
  const state = await readChatState(store);
  return {
    messages: state.messages.slice(-CHAT_MAX_MESSAGES).map(publicMessage),
    serverTime: now,
  };
}
```

- [ ] **Step 4: Implement `chat.mjs` route**

Create `netlify/functions/chat.mjs`:

```javascript
import {
  assertActiveSession,
  getPresenceStore,
  requestIpKey,
} from './lib/presence-store.mjs';
import {
  appendChatMessage,
  chatSnapshot,
  getChatStore,
} from './lib/chat-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';

function identityFromBodyAndRequest(body, req) {
  return {
    clientId: body.clientId || '',
    sessionId: body.sessionId || '',
    ipKey: requestIpKey(req),
    handle: body.handle || 'Anonymous',
    avatar: body.avatar || '',
  };
}

export async function handleChatRequest(req, options = {}) {
  const presenceStore = options.presenceStore || getPresenceStore();
  const chatStore = options.chatStore || getChatStore();
  const nowFn = options.nowFn || Date.now;

  if (req.method === 'GET') {
    return jsonResponse(await chatSnapshot(chatStore, nowFn()));
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const identity = identityFromBodyAndRequest(body, req);
    try {
      await assertActiveSession(presenceStore, identity, nowFn());
      await appendChatMessage(chatStore, {
        identity,
        text: body.text,
        now: nowFn(),
      });
      return jsonResponse(await chatSnapshot(chatStore, nowFn()));
    } catch (error) {
      return errorResponse(error.status || 400, error.code || error.message || 'chat_failed');
    }
  }

  return methodNotAllowed(['GET', 'POST']);
}

export default async function handler(req) {
  return handleChatRequest(req);
}

export const config = { path: '/api/chat' };
```

- [ ] **Step 5: Run chat tests and function import check**

Run:

```bash
npm test -- tests/chat.test.mjs
npm run check:functions
```

Expected: both commands exit 0. If `check:functions` does not discover the new route automatically, add `netlify/functions/chat.mjs` and `netlify/functions/vote-queue.mjs` to its function list, then re-run.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add netlify/functions/lib/chat-store.mjs netlify/functions/chat.mjs tests/chat.test.mjs scripts/check-functions.mjs
git commit -m "Add connected user chat API"
```

---

### Task 5: Frontend Collaboration UI And Client Behavior

**Files:**
- Modify: `gdebenz_ui/static/index.html`
- Modify: `gdebenz_ui/static/style.css`
- Modify: `gdebenz_ui/static/app.js`
- Modify: `tests/frontend-dom.test.mjs`

- [ ] **Step 1: Write failing frontend DOM tests**

Extend the jsdom harness in `tests/frontend-dom.test.mjs` with these elements:

```html
<div id="vote-queue-list"></div>
<div id="chat-messages"></div>
<form id="chat-form"><input id="chat-input"></form>
<div id="session-replaced-modal" hidden><span id="session-replaced-reason"></span></div>
<div id="progress-bar"></div>
<div id="progress-fill"></div>
<div id="progress-text"></div>
<div id="progress-pct"></div>
<div id="progress-current"></div>
<div id="progress-badge"></div>
<select id="comment-mode"><option value="custom">Custom</option></select>
<input id="vote-text">
<input id="vote-onsite" type="checkbox">
<input id="city-input">
<input id="lat-input">
<input id="lon-input">
```

Append these tests:

```javascript
it('renders public vote queue entries without private fields', () => {
  const { context, dom } = loadFrontendHarness();

  vm.runInContext(`
    renderVoteQueue({
      entries: [{
        id: 'q1',
        clientId: 'alice',
        handle: 'Alice',
        avatar: '/avatars/a.png',
        source: 'gdebenz',
        stationId: '101',
        status: 'yes',
        state: 'queued',
        position: 1,
        queuedAgeMs: 2500
      }]
    });
  `, context);

  const text = dom.window.document.getElementById('vote-queue-list')?.textContent || '';
  assert.match(text, /Alice/);
  assert.match(text, /101/);
  assert.doesNotMatch(text, /session|ip:/i);
});

it('renders chat messages and escapes message text', () => {
  const { context, dom } = loadFrontendHarness();

  vm.runInContext(`
    renderChatMessages([
      {
        id: 'm1',
        clientId: 'alice',
        handle: 'Alice',
        avatar: '/avatars/a.png',
        text: '<b>hello</b>',
        createdAt: 1000
      }
    ]);
  `, context);

  const messages = dom.window.document.getElementById('chat-messages');
  assert.match(messages?.textContent || '', /<b>hello<\/b>/);
  assert.equal(messages?.querySelector('b'), null);
});

it('marks a replaced session as blocked', () => {
  const { context, dom } = loadFrontendHarness();

  vm.runInContext(`
    state.identity = { clientId: 'c1', sessionId: 's1', handle: 'Operator', avatar: '/avatars/a.png' };
    handlePresencePayload({ users: [], session: { active: false, reason: 'ip_replaced' } });
  `, context);

  assert.equal(vm.runInContext('state.sessionBlocked', context), true);
  assert.equal(dom.window.document.getElementById('session-replaced-modal')?.hidden, false);
  assert.match(dom.window.document.getElementById('session-replaced-reason')?.textContent || '', /IP/);
});

it('shuffles bulk vote ids with an injectable random source', () => {
  const { context } = loadFrontendHarness();

  const shuffled = vm.runInContext(`
    shuffleIds(['1', '2', '3', '4'], () => 0)
  `, context);

  assert.deepEqual(shuffled, ['2', '3', '4', '1']);
});

it('builds vote payloads with identity and session metadata', () => {
  const { context } = loadFrontendHarness();

  const payload = vm.runInContext(`
    state.identity = {
      clientId: 'client-one',
      sessionId: 'session-one',
      handle: 'Operator',
      avatar: '/avatars/a.png',
      fingerprint: 'fp-one'
    };
    buildVotePayload({ osmId: '101', voteStatus: 'yes', baseText: 'ok', city: 'Kazan', lat: 55.7, lon: 49.1 })
  `, context);

  assert.equal(payload.clientId, 'client-one');
  assert.equal(payload.sessionId, 'session-one');
  assert.equal(payload.handle, 'Operator');
  assert.equal(payload.avatar, '/avatars/a.png');
  assert.deepEqual(payload.osm_ids, ['101']);
});
```

- [ ] **Step 2: Run frontend tests and verify RED**

Run:

```bash
npm test -- tests/frontend-dom.test.mjs
```

Expected: FAIL because `renderVoteQueue`, `renderChatMessages`, `handlePresencePayload`, `shuffleIds`, `buildVotePayload`, and new DOM elements do not exist yet.

- [ ] **Step 3: Add HTML for session replacement, queue, and chat**

In `gdebenz_ui/static/index.html`, add a compact collaboration panel after the stats bar and before pagination:

```html
  <section class="collab-panel" id="collab-panel">
    <div class="collab-section">
      <div class="collab-head">
        <span>Vote queue</span>
        <small id="vote-queue-count">0 waiting</small>
      </div>
      <div id="vote-queue-list" class="vote-queue-list" aria-live="polite">
        <span class="collab-empty">Queue is empty</span>
      </div>
    </div>
    <div class="collab-section chat-section">
      <div class="collab-head">
        <span>Chat</span>
        <small id="chat-count">0 messages</small>
      </div>
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div>
      <form id="chat-form" class="chat-form">
        <input id="chat-input" type="text" maxlength="240" autocomplete="off" placeholder="Message connected users">
        <button class="btn btn-sm btn-primary" type="submit">Send</button>
      </form>
    </div>
  </section>
```

Add a blocking modal after the identity modal:

```html
<div id="session-replaced-modal" class="identity-modal" hidden>
  <div class="identity-card">
    <div class="identity-title">Session replaced</div>
    <p id="session-replaced-reason" class="session-replaced-copy">
      This profile is active somewhere else.
    </p>
    <button class="btn btn-primary" type="button" onclick="location.reload()">Reload</button>
  </div>
</div>
```

- [ ] **Step 4: Add frontend state, helpers, and polling**

In `gdebenz_ui/static/app.js`, add constants and state fields:

```javascript
const QUEUE_POLL_MS = 2000;
const CHAT_POLL_MS = 2500;
```

```javascript
  voteQueue: [],
  queuePoll: null,
  chatMessages: [],
  chatPoll: null,
  sessionBlocked: false,
```

In `saveIdentity`, always create a fresh per-load session:

```javascript
  state.identity = {
    clientId: previous.clientId || randomId(),
    sessionId: randomId(),
    fingerprint: previous.fingerprint || randomHex(16),
    handle: handle.slice(0, 32),
    avatar: state.pendingAvatar,
  };
```

In `readIdentity`, hydrate a fresh `sessionId`:

```javascript
function readIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
    if (!saved?.clientId || !saved?.handle || !saved?.avatar) return null;
    return { ...saved, sessionId: randomId() };
  } catch {
    return null;
  }
}
```

In `startPresence`, also start queue/chat polling:

```javascript
  pollQueue();
  pollChat();
  state.queuePoll = setInterval(pollQueue, QUEUE_POLL_MS);
  state.chatPoll = setInterval(pollChat, CHAT_POLL_MS);
```

In `stopPresenceTimers`, clear the new intervals:

```javascript
  clearInterval(state.queuePoll);
  clearInterval(state.chatPoll);
  state.queuePoll = null;
  state.chatPoll = null;
```

Add these helper functions:

```javascript
function identityPayload() {
  return {
    clientId: state.identity?.clientId || '',
    sessionId: state.identity?.sessionId || '',
    handle: state.identity?.handle || '',
    avatar: state.identity?.avatar || '',
  };
}

function handlePresencePayload(data) {
  if (data?.session && data.session.active === false) {
    blockReplacedSession(data.session.reason);
    return;
  }
  renderOnlineUsers(data.users || []);
}

function blockReplacedSession(reason = 'session_replaced') {
  state.sessionBlocked = true;
  stopPresenceTimers();
  const modal = $('#session-replaced-modal');
  const copy = $('#session-replaced-reason');
  if (copy) {
    copy.textContent = reason === 'ip_replaced'
      ? 'Another profile is now active from this IP address.'
      : 'This profile is now active in another session.';
  }
  if (modal) modal.hidden = false;
}

function shuffleIds(ids, rng = Math.random) {
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildVotePayload({ osmId, voteStatus, baseText, city, lat, lon }) {
  return {
    osm_ids: [osmId],
    vote_status: voteStatus,
    text: baseText,
    on_site: $('#vote-onsite').checked,
    city,
    lat,
    lon,
    source: state.source || 'gdebenz',
    fingerprint: state.identity?.fingerprint || state.identity?.clientId || '',
    ...identityPayload(),
  };
}
```

- [ ] **Step 5: Wire presence, queue, and chat calls**

Update `postPresence` body to include `sessionId`, then call `handlePresencePayload`:

```javascript
body: JSON.stringify({
  ...identityPayload(),
  activity: state.activity,
  detail: state.activityDetail,
}),
```

Update `pollPresence`:

```javascript
const params = new URLSearchParams(identityPayload());
const data = await api(`/api/presence?${params}`);
handlePresencePayload(data);
```

Update `leavePresence`:

```javascript
const params = new URLSearchParams(identityPayload());
fetch(`/api/presence?${params}`, {
  method: 'DELETE',
  keepalive: true,
}).catch(() => {});
```

Add queue functions:

```javascript
async function pollQueue() {
  if (!state.identity || state.sessionBlocked) return;
  try {
    const data = await api('/api/vote/queue');
    renderVoteQueue(data);
  } catch {
    renderVoteQueue({ entries: state.voteQueue });
  }
}

function renderVoteQueue(data = {}) {
  const list = $('#vote-queue-list');
  const count = $('#vote-queue-count');
  if (!list) return;
  state.voteQueue = Array.isArray(data.entries) ? data.entries : [];
  if (count) count.textContent = `${state.voteQueue.length} waiting`;
  if (!state.voteQueue.length) {
    list.innerHTML = '<span class="collab-empty">Queue is empty</span>';
    return;
  }
  list.innerHTML = state.voteQueue.map((entry) => `
    <div class="queue-entry queue-entry-${esc(entry.state || 'queued')}">
      ${entry.avatar ? `<img src="${esc(entry.avatar)}" alt="">` : ''}
      <span class="queue-copy">
        <span class="queue-title">${esc(entry.handle || 'Anonymous')} · ${esc(entry.status || '')}</span>
        <span class="queue-meta">${esc(entry.source || 'gdebenz')} station ${esc(entry.stationId || '')}</span>
      </span>
      <span class="queue-position">#${entry.position || ''}</span>
    </div>
  `).join('');
}
```

Add chat functions and call `initChat()` from `init()` after identity setup wiring:

```javascript
function initChat() {
  const form = $('#chat-form');
  if (!form || form.dataset.boundChat === 'true') return;
  form.dataset.boundChat = 'true';
  form.addEventListener('submit', sendChatMessage);
}

async function pollChat() {
  if (!state.identity || state.sessionBlocked) return;
  try {
    const data = await api('/api/chat');
    renderChatMessages(data.messages || []);
  } catch {
    renderChatMessages(state.chatMessages);
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!state.identity || state.sessionBlocked) return;
  const input = $('#chat-input');
  const text = input?.value.trim() || '';
  if (!text) return;
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...identityPayload(), text }),
    });
    input.value = '';
    renderChatMessages(data.messages || []);
  } catch (error) {
    if (/replaced/.test(error.message)) blockReplacedSession(error.message);
    else toast('Chat failed: ' + error.message);
  }
}

function renderChatMessages(messages = []) {
  const list = $('#chat-messages');
  const count = $('#chat-count');
  if (!list) return;
  state.chatMessages = messages;
  if (count) count.textContent = `${messages.length} messages`;
  if (!messages.length) {
    list.innerHTML = '<span class="collab-empty">No messages yet</span>';
    return;
  }
  list.innerHTML = messages.map((message) => `
    <div class="chat-message">
      ${message.avatar ? `<img src="${esc(message.avatar)}" alt="">` : ''}
      <span class="chat-copy">
        <span class="chat-author">${esc(message.handle || 'Anonymous')}</span>
        <span class="chat-text">${esc(message.text || '')}</span>
      </span>
    </div>
  `).join('');
  list.scrollTop = list.scrollHeight;
}
```

- [ ] **Step 6: Update vote loops to shuffle ids and include session metadata**

In `doVote`, replace:

```javascript
ids = data.ids;
```

with:

```javascript
ids = shuffleIds(data.ids);
```

In both `doVote` and `doVoteSelected`, replace inline vote request bodies with:

```javascript
body: JSON.stringify(buildVotePayload({
  osmId,
  voteStatus,
  baseText,
  city,
  lat,
  lon,
})),
```

In `doVoteSelected`, shuffle the selected ids:

```javascript
const ids = shuffleIds([...state.allSelected]);
```

- [ ] **Step 7: Add CSS for queue, chat, roster cap, and session modal**

In `gdebenz_ui/static/style.css`, add:

```css
.online-users {
  flex-wrap: nowrap;
}
.online-user:nth-of-type(n+9) {
  display: none;
}
.collab-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 12px;
  margin-bottom: 12px;
}
.collab-section {
  min-width: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.collab-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.collab-head small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
}
.vote-queue-list,
.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-messages {
  max-height: 180px;
  overflow-y: auto;
}
.queue-entry,
.chat-message {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid rgba(75, 93, 121, .35);
  border-radius: 6px;
  background: rgba(26, 31, 46, .62);
}
.queue-entry img,
.chat-message img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.queue-copy,
.chat-copy {
  min-width: 0;
  flex: 1;
}
.queue-title,
.queue-meta,
.chat-author,
.chat-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-title,
.chat-author {
  color: var(--text);
  font-size: 12px;
  font-weight: 800;
}
.queue-meta,
.chat-text {
  color: var(--text-dim);
  font-size: 11px;
}
.queue-position {
  color: var(--accent);
  font-size: 12px;
  font-weight: 800;
}
.chat-form {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.chat-form input {
  min-width: 0;
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 7px 9px;
}
.collab-empty,
.session-replaced-copy {
  color: var(--text-dim);
  font-size: 13px;
}
@media (max-width: 860px) {
  .collab-panel {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 8: Run frontend tests and verify GREEN**

Run:

```bash
npm test -- tests/frontend-dom.test.mjs
```

Expected: PASS for all frontend DOM tests.

- [ ] **Step 9: Commit Task 5**

Run:

```bash
git add gdebenz_ui/static/index.html gdebenz_ui/static/style.css gdebenz_ui/static/app.js tests/frontend-dom.test.mjs
git commit -m "Add frontend queue chat and session blocking"
```

---

### Task 6: Full Verification And Integration Fixes

**Files:**
- Modify only files required by failing verification.

- [ ] **Step 1: Run the full Node test suite**

Run:

```bash
npm test
```

Expected: all Node tests pass.

- [ ] **Step 2: Run function import verification**

Run:

```bash
npm run check:functions
```

Expected: all Netlify function modules import successfully.

- [ ] **Step 3: Run the Python upstream error test**

Run:

```bash
python -m unittest tests.test_server_upstream_errors
```

Expected: the FastAPI upstream error test passes. If Python dependencies are missing, record the exact import error in the final report and do not claim Python verification passed.

- [ ] **Step 4: Inspect git diff for privacy regressions**

Run:

```bash
git diff --stat HEAD
git diff HEAD -- netlify/functions/lib/vote-queue-store.mjs netlify/functions/lib/chat-store.mjs netlify/functions/lib/presence-store.mjs gdebenz_ui/static/app.js
```

Expected: public queue/chat render paths do not expose `ipKey`, raw IPs, vote text, coordinates, or fingerprints.

- [ ] **Step 5: Commit verification fixes**

If any fixes were needed, run:

```bash
git add netlify/functions/lib/presence-store.mjs netlify/functions/lib/vote-queue-store.mjs netlify/functions/lib/chat-store.mjs netlify/functions/vote.mjs netlify/functions/vote-queue.mjs netlify/functions/chat.mjs gdebenz_ui/static/index.html gdebenz_ui/static/style.css gdebenz_ui/static/app.js tests/presence.test.mjs tests/vote-queue.test.mjs tests/netlify-vote-queue-route.test.mjs tests/chat.test.mjs tests/frontend-dom.test.mjs tests/netlify-benzin.test.mjs scripts/check-functions.mjs
git commit -m "Fix queue chat integration verification"
```

If no fixes were needed, do not create an empty commit.

---

### Task 7: Optional Local Browser Smoke Test

**Files:**
- No planned source edits.

- [ ] **Step 1: Start a local static/function-compatible dev server**

If Netlify CLI is available, run:

```bash
npx netlify dev
```

Expected: a local URL is printed. If Netlify CLI is unavailable, use the existing local server path that supports `/api/*` only for UI smoke checks and record that Netlify function behavior was verified by tests.

- [ ] **Step 2: Manually smoke test the collaboration UI**

Open two browser sessions:

1. In the first session, choose a profile and confirm presence appears.
2. In the second session with the same saved profile, load the app and confirm the first session shows the replaced-session modal.
3. In a second profile from the same IP, confirm only the newest profile remains in the roster.
4. Send a chat message and confirm it appears in the chat panel.
5. Start a small vote run and confirm the vote queue panel shows the avatar, handle, station id, status, and no private fields.

- [ ] **Step 3: Stop the dev server**

Stop the process with `Ctrl+C` and ensure no needed terminal session remains running.

---

## Self-Review Checklist

- Spec coverage: Tasks 1 and 5 cover `clientId`/IP session replacement and blocking UI; Tasks 2 and 3 cover fair public queueing, one active vote per `clientId`/IP, shuffling, and 2 second global rate limiting; Task 4 covers chat; Task 6 covers privacy and verification.
- Placeholder scan: The plan contains concrete file paths, test code, implementation snippets, commands, and expected results.
- Type consistency: Identity fields are `clientId`, `sessionId`, `ipKey`, `handle`, and `avatar` throughout backend stores and frontend payloads. Vote queue public fields are `id`, `clientId`, `handle`, `avatar`, `source`, `stationId`, `status`, `queuedAt`, `queuedAgeMs`, `state`, and `position`.

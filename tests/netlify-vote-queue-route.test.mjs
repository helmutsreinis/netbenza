import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryAccessGateStore,
  createAccessChallenge,
  issueAccessToken,
} from '../netlify/functions/lib/access-gate-store.mjs';
import {
  MemoryPresenceStore,
  handlePresenceRequest,
} from '../netlify/functions/lib/presence-store.mjs';
import {
  createVoteQueueEntry,
  enqueueVoteEntry,
  markVoteEntryProcessing,
  readQueueState,
  removeVoteEntry,
} from '../netlify/functions/lib/vote-queue-store.mjs';
import { handleVoteRequest } from '../netlify/functions/vote.mjs';
import voteQueueHandler, { handleVoteQueueRequest } from '../netlify/functions/vote-queue.mjs';

function correctAnswers(challenge) {
  return Object.fromEntries(challenge.questions.map((question) => [question.id, question.correct]));
}

async function accessContext({ ip = '198.51.100.42', now = 1_000_000 } = {}) {
  const store = new MemoryAccessGateStore();
  const challenge = await createAccessChallenge(store, { now });
  const accessSessionId = `access-${crypto.randomUUID()}`;
  const { accessToken } = await issueAccessToken(store, {
    challengeId: challenge.challengeId,
    answers: correctAnswers(challenge),
    accessSessionId,
    ipKey: `ip:${ip}`,
    now: now + 1,
  });

  return {
    store,
    headers: {
      'x-access-token': accessToken,
      'x-access-session': accessSessionId,
      'x-nf-client-connection-ip': ip,
    },
  };
}

async function activatePresence({
  store,
  headers,
  now,
  clientId = 'client-one',
  sessionId = 'session-one',
  sessionStartedAt = now,
  handle = 'Nina',
  avatar = '/avatars/nina.png',
}) {
  const response = await handlePresenceRequest(new Request('https://site.test/api/presence', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId,
      sessionId,
      sessionStartedAt,
      handle,
      avatar,
      activity: 'voting',
    }),
  }), store, () => now);

  assert.equal(response.status, 200);
  return response.json();
}

function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

describe('Netlify vote queue routes', () => {
  it('routes an active Benzin station vote through the queue and exposes an empty public snapshot', async () => {
    let now = 1_000_000;
    const access = await accessContext({ now });
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    const postedBodies = [];

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      handle: 'Queue Tester',
      avatar: '/avatars/queue.png',
    });

    await withMockFetch(async (url, options = {}) => {
      assert.equal(String(url), 'https://map.benzin-status.tech/api/reports');
      postedBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
        method: 'POST',
        headers: { ...access.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'benzin',
          osm_ids: ['123'],
          vote_status: 'available',
          clientId: 'client-one',
          sessionId: 'session-one',
          handle: 'Queue Tester',
          avatar: '/avatars/queue.png',
          ipKey: 'ip:client-supplied-value',
        }),
      }), {
        accessStore: access.store,
        presenceStore,
        queueStore,
        nowFn: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        maxWaitMs: 5_000,
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, [{
        osm_id: '123',
        name: 'Station #123',
        success: true,
        reason: '',
      }]);
    });

    assert.deepEqual(postedBodies, [{
      station_id: 123,
      status: 'available',
      fuel_types: [],
      prices: {},
    }]);

    const state = await readQueueState(queueStore, now);
    assert.deepEqual(state.entries, []);
    assert.equal(state.lastClientId, 'client-one');
    assert.equal(state.processingId, '');

    const queueResponse = await handleVoteQueueRequest(new Request('http://localhost/api/vote/queue', {
      method: 'GET',
      headers: access.headers,
    }), {
      accessStore: access.store,
      queueStore,
      nowFn: () => now,
    });
    const queue = await queueResponse.json();

    assert.equal(queueResponse.status, 200);
    assert.deepEqual(queue.entries, []);
    assert.equal(queue.processing, null);
    assert.equal(queue.voteIntervalMs, 2000);
    assert.equal(JSON.stringify(queue).includes('ip:'), false);
    assert.equal(JSON.stringify(queue).includes('session-one'), false);
  });

  it('uses active presence display identity instead of vote body identity in public queue', async () => {
    let now = 1_500_000;
    const access = await accessContext({ now, ip: '198.51.100.52' });
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    const blocker = createVoteQueueEntry({
      identity: {
        clientId: 'blocker',
        sessionId: 'blocker-session',
        ipKey: 'ip:203.0.113.200',
        handle: 'Blocker',
        avatar: '/avatars/blocker.png',
      },
      vote: { source: 'benzin', stationId: '900', status: 'available' },
      now,
      id: 'processing-blocker',
    });
    let inspectedSnapshot = null;

    await enqueueVoteEntry(queueStore, blocker, now);
    await markVoteEntryProcessing(queueStore, blocker.id, now);
    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
      handle: 'Presence Operator',
      avatar: '/avatars/presence.png',
    });

    await withMockFetch(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), async () => {
      const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
        method: 'POST',
        headers: { ...access.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'benzin',
          osm_ids: ['123'],
          vote_status: 'available',
          clientId: 'client-one',
          sessionId: 'session-one',
          handle: 'Spoofed Operator',
          avatar: '/avatars/spoofed.png',
        }),
      }), {
        accessStore: access.store,
        presenceStore,
        queueStore,
        nowFn: () => now,
        sleep: async (ms) => {
          if (!inspectedSnapshot) {
            const queueResponse = await handleVoteQueueRequest(new Request('http://localhost/api/vote/queue', {
              method: 'GET',
              headers: access.headers,
            }), {
              accessStore: access.store,
              queueStore,
              nowFn: () => now,
            });
            inspectedSnapshot = await queueResponse.json();
            await removeVoteEntry(queueStore, blocker.id, {}, now);
          }
          now += ms;
        },
        maxWaitMs: 5_000,
      });

      assert.equal(response.status, 200);
      await response.json();
    });

    assert.equal(inspectedSnapshot.entries[0].clientId, 'client-one');
    assert.equal(inspectedSnapshot.entries[0].handle, 'Presence Operator');
    assert.equal(inspectedSnapshot.entries[0].avatar, '/avatars/presence.png');
    assert.equal(JSON.stringify(inspectedSnapshot).includes('Spoofed Operator'), false);
    assert.equal(JSON.stringify(inspectedSnapshot).includes('/avatars/spoofed.png'), false);
  });

  it('rejects stale sessions before enqueueing a vote', async () => {
    let now = 2_000_000;
    const access = await accessContext({ now });
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    const postedBodies = [];

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'old-session',
      sessionStartedAt: now,
      handle: 'Old tab',
    });
    now += 1;
    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'new-session',
      sessionStartedAt: now,
      handle: 'New tab',
    });

    await withMockFetch(async (url, options = {}) => {
      postedBodies.push({ url: String(url), body: options.body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
        method: 'POST',
        headers: { ...access.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'benzin',
          osm_ids: ['123'],
          vote_status: 'available',
          clientId: 'client-one',
          sessionId: 'old-session',
          handle: 'Old tab',
        }),
      }), {
        accessStore: access.store,
        presenceStore,
        queueStore,
        nowFn: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        maxWaitMs: 5_000,
      });
      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.detail, 'client_replaced');
    });

    const state = await readQueueState(queueStore, now);
    assert.deepEqual(state.entries, []);
    assert.deepEqual(postedBodies, []);
  });

  it('returns a non-200 response when the queue runner times out before submission', async () => {
    const now = 2_500_000;
    const access = await accessContext({ now, ip: '198.51.100.60' });
    const presenceStore = new MemoryPresenceStore();
    const queueStore = new MemoryPresenceStore();
    const blocker = createVoteQueueEntry({
      identity: {
        clientId: 'blocking-client',
        sessionId: 'blocking-session',
        ipKey: 'ip:198.51.100.60',
        handle: 'Blocking Client',
        avatar: '/avatars/blocking.png',
      },
      vote: { source: 'benzin', stationId: '321', status: 'available' },
      now,
      id: 'queued-blocker',
    });

    await enqueueVoteEntry(queueStore, blocker, now);
    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
    });

    const response = await handleVoteRequest(new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'benzin',
        osm_ids: ['123'],
        vote_status: 'available',
        clientId: 'client-one',
        sessionId: 'session-one',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      queueStore,
      nowFn: () => now,
      sleep: async () => {},
      maxWaitMs: 0,
    });
    const body = await response.json();
    const state = await readQueueState(queueStore, now);

    assert.equal(response.status, 504);
    assert.equal(body.detail, 'queue_wait_timeout');
    assert.deepEqual(state.entries.map((entry) => entry.id), ['queued-blocker']);
  });

  it('protects the public queue snapshot with the access gate', async () => {
    const response = await voteQueueHandler(new Request('http://localhost/api/vote/queue', {
      method: 'GET',
    }));
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.detail, 'access_token_missing');
  });

  it('does not expose private queue fields from the snapshot route', async () => {
    const now = 3_000_000;
    const access = await accessContext({ now, ip: '198.51.100.77' });
    const queueStore = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: {
        clientId: 'client-private',
        sessionId: 'private-session',
        ipKey: 'ip:198.51.100.77',
        handle: 'Private Tester',
        avatar: '/avatars/private.png',
      },
      vote: {
        source: 'gdebenz',
        osm_id: '999',
        status: 'yes',
        text: 'private comment',
        fingerprint: 'private-fingerprint',
      },
      now,
      id: 'queued-private',
    });
    await enqueueVoteEntry(queueStore, entry, now);

    const response = await handleVoteQueueRequest(new Request('http://localhost/api/vote/queue', {
      method: 'GET',
      headers: access.headers,
    }), {
      accessStore: access.store,
      queueStore,
      nowFn: () => now + 500,
    });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body.entries[0]).sort(), [
      'avatar',
      'clientId',
      'handle',
      'id',
      'position',
      'queuedAgeMs',
      'queuedAt',
      'source',
      'state',
      'stationId',
      'status',
    ]);
    assert.equal(serialized.includes('ip:'), false);
    assert.equal(serialized.includes('private-session'), false);
    assert.equal(serialized.includes('private comment'), false);
    assert.equal(serialized.includes('private-fingerprint'), false);
  });
});

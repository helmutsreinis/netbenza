import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryPresenceStore } from '../netlify/functions/lib/presence-store.mjs';

import {
  VOTE_INTERVAL_MS,
  createVoteQueueEntry,
  enqueueVoteEntry,
  markVoteEntryProcessing,
  millisecondsUntilVoteAllowed,
  publicQueueSnapshot,
  readQueueState,
  removeVoteEntry,
  runQueuedVote,
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

function vote(overrides = {}) {
  return {
    source: 'gdebenz',
    osmId: '101',
    status: 'yes',
    text: 'private comment',
    fingerprint: 'private-fingerprint',
    lat: 55.7,
    lon: 37.6,
    ...overrides,
  };
}

describe('vote queue store', () => {
  it('exposes only public queue fields', () => {
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote(),
      now: 10_000,
      id: 'queue-1',
    });

    const snapshot = publicQueueSnapshot({
      entries: [entry],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: '',
    }, 12_000);

    assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), [
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
    assert.equal(snapshot.entries[0].clientId, 'alice');
    assert.equal(snapshot.entries[0].handle, 'Alice');
    assert.equal(snapshot.entries[0].stationId, '101');
    assert.equal(snapshot.entries[0].queuedAgeMs, 2000);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('ip:'), false);
    assert.equal(serialized.includes('alice-session'), false);
    assert.equal(serialized.includes('private comment'), false);
    assert.equal(serialized.includes('private-fingerprint'), false);
    assert.equal(serialized.includes('55.7'), false);
    assert.equal(serialized.includes('37.6'), false);
  });

  it('allows one active queued or processing vote per clientId and per ipKey', async () => {
    const store = new MemoryPresenceStore();
    const first = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 100,
      id: 'first',
    });
    const secondSameClient = createVoteQueueEntry({
      identity: { ...alice, ipKey: 'ip:203.0.113.9' },
      vote: vote({ osmId: '102', status: 'no' }),
      now: 101,
      id: 'second',
    });
    const thirdSameIp = createVoteQueueEntry({
      identity: { ...bob, ipKey: alice.ipKey },
      vote: vote({ osmId: '103', status: 'queue' }),
      now: 102,
      id: 'third',
    });

    await enqueueVoteEntry(store, first);
    await assert.rejects(() => enqueueVoteEntry(store, secondSameClient), /client_active/);
    await assert.rejects(() => enqueueVoteEntry(store, thirdSameIp), /ip_active/);

    await markVoteEntryProcessing(store, first.id, 200);
    await assert.rejects(() => enqueueVoteEntry(store, secondSameClient), /client_active/);
    await assert.rejects(() => enqueueVoteEntry(store, thirdSameIp), /ip_active/);
  });

  it('rotates selection across clientIds after the last submitted client', () => {
    const entries = [
      createVoteQueueEntry({
        identity: alice,
        vote: vote({ osmId: '101' }),
        now: 100,
        id: 'a1',
      }),
      createVoteQueueEntry({
        identity: alice,
        vote: vote({ osmId: '102', status: 'queue' }),
        now: 105,
        id: 'a2',
      }),
      createVoteQueueEntry({
        identity: bob,
        vote: vote({ osmId: '201', status: 'no' }),
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

  it('removes completed entries and updates submission state', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 100,
      id: 'done-entry',
    });

    await enqueueVoteEntry(store, entry);
    await markVoteEntryProcessing(store, entry.id, 200);
    await removeVoteEntry(store, entry.id, { lastSubmissionAt: 3000, lastClientId: 'alice' });
    const state = await readQueueState(store);

    assert.deepEqual(state.entries, []);
    assert.equal(state.processingId, '');
    assert.equal(state.lastSubmissionAt, 3000);
    assert.equal(state.lastClientId, 'alice');
  });

  it('runner marks selected votes processing and cleans up on success', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 100,
      id: 'runner-success',
    });
    const submitted = [];

    await enqueueVoteEntry(store, entry);
    const result = await runQueuedVote(store, {
      nowFn: () => 5_000,
      submitVote: async (privateVote, processingEntry) => {
        submitted.push({ privateVote, processingEntry });
        assert.equal((await readQueueState(store)).processingId, entry.id);
        return { ok: true, stationId: privateVote.osmId };
      },
    });
    const state = await readQueueState(store);

    assert.deepEqual(result, { ok: true, stationId: '101' });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].privateVote.text, 'private comment');
    assert.equal(submitted[0].processingEntry.id, entry.id);
    assert.deepEqual(state.entries, []);
    assert.equal(state.lastClientId, 'alice');
    assert.equal(state.lastSubmissionAt, 5_000);
    assert.equal(state.processingId, '');
  });

  it('runner cleans up and records submission timing on failure', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      now: 100,
      id: 'runner-failure',
    });

    await enqueueVoteEntry(store, entry);
    await assert.rejects(() => runQueuedVote(store, {
      nowFn: () => 6_000,
      submitVote: async () => {
        throw new Error('upstream failed');
      },
    }), /upstream failed/);
    const state = await readQueueState(store);

    assert.deepEqual(state.entries, []);
    assert.equal(state.lastClientId, 'bob');
    assert.equal(state.lastSubmissionAt, 6_000);
    assert.equal(state.processingId, '');
  });
});

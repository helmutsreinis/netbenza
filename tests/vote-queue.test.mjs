import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryPresenceStore } from '../netlify/functions/lib/presence-store.mjs';

import {
  PROCESSING_LEASE_MS,
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

const cara = {
  clientId: 'cara',
  sessionId: 'cara-session',
  ipKey: 'ip:203.0.113.3',
  handle: 'Cara',
  avatar: '/avatars/c.png',
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

class FailingReadStore extends MemoryPresenceStore {
  async get() {
    throw new Error('blob_read_failed');
  }
}

class FailingDeleteStore extends MemoryPresenceStore {
  async delete() {
    throw new Error('blob_delete_failed');
  }
}

class FailingMigrationEntryWriteStore extends MemoryPresenceStore {
  async setJSON(key, value) {
    if (String(key).startsWith('queue/entries/')) {
      throw new Error('entry_write_failed');
    }
    return super.setJSON(key, value);
  }
}

class BarrierEntryWriteStore extends MemoryPresenceStore {
  constructor(expectedWrites = 2) {
    super();
    this.expectedWrites = expectedWrites;
    this.waiting = [];
  }

  async setJSON(key, value) {
    if (String(key).startsWith('queue/entries/')) {
      await new Promise((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= this.expectedWrites) {
          this.waiting.splice(0).forEach((release) => release());
        }
      });
    }
    return super.setJSON(key, value);
  }
}

class BarrierProcessingWriteStore extends MemoryPresenceStore {
  constructor(expectedWrites = 2) {
    super();
    this.expectedWrites = expectedWrites;
    this.waiting = [];
  }

  async setJSON(key, value) {
    if (String(key).startsWith('queue/entries/') && value?.state === 'processing') {
      await new Promise((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= this.expectedWrites) {
          this.waiting.splice(0).forEach((release) => release());
        }
      });
    }
    return super.setJSON(key, value);
  }
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
    assert.equal(snapshot.processing, null);
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

  it('returns default state only for missing queue state and rejects read failures', async () => {
    const emptyStore = new MemoryPresenceStore();

    assert.deepEqual(await readQueueState(emptyStore, 1000), {
      entries: [],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: '',
    });
    await assert.rejects(() => readQueueState(new FailingReadStore(), 1000), /blob_read_failed/);
  });

  it('migrates legacy single-blob queue state into per-entry storage', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 10_000,
      id: 'legacy-entry',
    });

    await store.setJSON('queue/state', {
      entries: [entry],
      lastSubmissionAt: 9_000,
      lastClientId: 'bob',
      processingId: '',
    });

    const state = await readQueueState(store, 10_500);
    const migratedEntry = await store.get('queue/entries/legacy-entry', { type: 'json' });
    const migratedMeta = await store.get('queue/meta', { type: 'json' });

    assert.deepEqual(state.entries.map((candidate) => candidate.id), ['legacy-entry']);
    assert.equal(state.lastSubmissionAt, 9_000);
    assert.equal(state.lastClientId, 'bob');
    assert.equal(migratedEntry.id, 'legacy-entry');
    assert.equal(migratedMeta.lastSubmissionAt, 9_000);
    assert.equal(migratedMeta.lastClientId, 'bob');
  });

  it('does not resurrect migrated legacy entries after removal', async () => {
    const store = new MemoryPresenceStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 10_000,
      id: 'legacy-remove',
    });

    await store.setJSON('queue/state', {
      entries: [entry],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: '',
    });

    await readQueueState(store, 10_500);
    await removeVoteEntry(store, 'legacy-remove', {}, 10_600);
    const state = await readQueueState(store, 10_700);

    assert.deepEqual(state.entries, []);
    assert.equal(await store.get('queue/state', { type: 'json' }), null);
  });

  it('keeps legacy queue state when migration entry writes fail', async () => {
    const store = new FailingMigrationEntryWriteStore();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 10_000,
      id: 'legacy-write-failure',
    });

    await store.setJSON('queue/state', {
      entries: [entry],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: '',
    });

    await assert.rejects(() => readQueueState(store, 10_500), /entry_write_failed/);

    const legacyState = await store.get('queue/state', { type: 'json' });
    assert.deepEqual(legacyState.entries.map((candidate) => candidate.id), ['legacy-write-failure']);
    assert.equal(await store.get('queue/meta', { type: 'json' }), null);
    assert.equal(await store.get('queue/legacy-migrated', { type: 'json' }), null);
  });

  it('allows one active queued or processing vote per clientId while sharing IPs', async () => {
    const store = new MemoryPresenceStore();
    const now = Date.now();
    const first = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now,
      id: 'first',
    });
    const secondSameClient = createVoteQueueEntry({
      identity: { ...alice, ipKey: 'ip:203.0.113.9' },
      vote: vote({ osmId: '102', status: 'no' }),
      now: now + 1,
      id: 'second',
    });
    const thirdSameIp = createVoteQueueEntry({
      identity: { ...bob, ipKey: alice.ipKey },
      vote: vote({ osmId: '103', status: 'queue' }),
      now: now + 2,
      id: 'third',
    });

    await enqueueVoteEntry(store, first);
    await assert.rejects(() => enqueueVoteEntry(store, secondSameClient), /client_active/);
    await enqueueVoteEntry(store, thirdSameIp);

    await markVoteEntryProcessing(store, first.id, now + 3);
    await assert.rejects(() => enqueueVoteEntry(store, secondSameClient), /client_active/);
    assert.deepEqual((await readQueueState(store, now + 4)).entries.map((entry) => entry.id).sort(), [
      'first',
      'third',
    ]);
  });

  it('allows different clientIds from the same IP to queue votes', async () => {
    const store = new MemoryPresenceStore();
    const now = Date.now();
    const first = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now,
      id: 'same-ip-first',
    });
    const secondSameIp = createVoteQueueEntry({
      identity: { ...bob, ipKey: alice.ipKey },
      vote: vote({ osmId: '201', status: 'no' }),
      now: now + 1,
      id: 'same-ip-second',
    });

    await enqueueVoteEntry(store, first);
    await enqueueVoteEntry(store, secondSameIp);

    const state = await readQueueState(store, now + 2);
    assert.deepEqual(state.entries.map((entry) => entry.id).sort(), [
      'same-ip-first',
      'same-ip-second',
    ]);
  });

  it('keeps concurrent enqueues from different users instead of losing one write', async () => {
    const store = new BarrierEntryWriteStore(2);
    const aliceEntry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 1_000,
      id: 'concurrent-alice',
    });
    const bobEntry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      now: 1_001,
      id: 'concurrent-bob',
    });

    await Promise.all([
      enqueueVoteEntry(store, aliceEntry, 1_000),
      enqueueVoteEntry(store, bobEntry, 1_001),
    ]);

    const state = await readQueueState(store, 1_002);
    assert.deepEqual(
      state.entries.map((entry) => entry.id).sort(),
      ['concurrent-alice', 'concurrent-bob'],
    );
  });

  it('allows only one concurrent processing claim for the same queued entry', async () => {
    const store = new BarrierProcessingWriteStore(2);
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: 1_000,
      id: 'claim-alice',
    });

    await enqueueVoteEntry(store, entry, 1_000);
    const results = await Promise.all([
      markVoteEntryProcessing(store, entry.id, 2_000),
      markVoteEntryProcessing(store, entry.id, 2_000),
    ]);

    const winners = results.filter(Boolean);
    const state = await readQueueState(store, 2_000);
    const processingEntries = state.entries.filter((candidate) => candidate.state === 'processing');

    assert.equal(winners.length, 1);
    assert.equal(processingEntries.length, 1);
    assert.equal(processingEntries[0].id, 'claim-alice');
    assert.equal(state.processingId, 'claim-alice');
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
    const now = Date.now();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now,
      id: 'done-entry',
    });

    await enqueueVoteEntry(store, entry);
    await markVoteEntryProcessing(store, entry.id, now + 100);
    await removeVoteEntry(store, entry.id, { lastSubmissionAt: now + 3000, lastClientId: 'alice' });
    const state = await readQueueState(store);

    assert.deepEqual(state.entries, []);
    assert.equal(state.processingId, '');
    assert.equal(state.lastSubmissionAt, now + 3000);
    assert.equal(state.lastClientId, 'alice');
  });

  it('propagates delete failures when completing entries', async () => {
    const store = new FailingDeleteStore();
    const now = Date.now();
    const entry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now,
      id: 'delete-failure',
    });

    await enqueueVoteEntry(store, entry);
    await markVoteEntryProcessing(store, entry.id, now + 100);
    await assert.rejects(() => removeVoteEntry(store, entry.id, {
      lastSubmissionAt: now + 3000,
      lastClientId: 'alice',
    }), /blob_delete_failed/);
  });

  it('runner enqueues and submits only the caller vote selected by fair order', async () => {
    const store = new MemoryPresenceStore();
    let now = 10_000;
    const priorBob = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '200', status: 'queue' }),
      now: now - 4_000,
      id: 'prior-bob',
    });
    const bobEntry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no', text: 'bob private' }),
      now,
      id: 'bob-ahead',
    });
    const submitted = [];

    await enqueueVoteEntry(store, priorBob, now - 4_000);
    await markVoteEntryProcessing(store, priorBob.id, now - 4_000);
    await removeVoteEntry(store, priorBob.id, {
      lastSubmissionAt: now - VOTE_INTERVAL_MS,
      lastClientId: 'bob',
    }, now - VOTE_INTERVAL_MS);
    await enqueueVoteEntry(store, bobEntry);

    const result = await runQueuedVote({
      queueStore: store,
      identity: alice,
      vote: vote({ osmId: '101', text: 'alice private' }),
      id: 'alice-runner',
      nowFn: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      submit: async (privateVote) => {
        submitted.push(privateVote);
        assert.equal((await readQueueState(store, now)).processingId, 'alice-runner');
        return { ok: true, stationId: privateVote.osmId };
      },
    });
    const state = await readQueueState(store);

    assert.deepEqual(result, { ok: true, stationId: '101' });
    assert.deepEqual(submitted.map((privateVote) => privateVote.osmId), ['101']);
    assert.equal(submitted[0].text, 'alice private');
    assert.deepEqual(state.entries.map((entry) => entry.id), ['bob-ahead']);
    assert.equal(state.lastClientId, 'alice');
    assert.equal(state.lastSubmissionAt, 10_000);
    assert.equal(state.processingId, '');
  });

  it('runner waits while another entry is processing instead of returning null', async () => {
    const store = new MemoryPresenceStore();
    let now = 20_000;
    const bobEntry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      now,
      id: 'bob-processing',
    });
    const sleepDurations = [];

    await enqueueVoteEntry(store, bobEntry);
    await markVoteEntryProcessing(store, bobEntry.id, now);

    const result = await runQueuedVote({
      queueStore: store,
      identity: alice,
      vote: vote({ osmId: '101' }),
      id: 'alice-waits',
      nowFn: () => now,
      maxWaitMs: 10_000,
      sleep: async (ms) => {
        sleepDurations.push(ms);
        now += ms;
        if (sleepDurations.length === 1) {
          await removeVoteEntry(store, bobEntry.id, {
            lastSubmissionAt: now,
            lastClientId: 'bob',
          });
        }
      },
      submit: async (privateVote) => ({ ok: true, stationId: privateVote.osmId }),
    });

    assert.deepEqual(result, { ok: true, stationId: '101' });
    assert.equal(sleepDurations.length >= 2, true);
    assert.equal((await readQueueState(store, now)).lastClientId, 'alice');
  });

  it('runner cleans up and records submission timing on failure', async () => {
    const store = new MemoryPresenceStore();
    let now = 30_000;

    await assert.rejects(() => runQueuedVote({
      queueStore: store,
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      id: 'runner-failure',
      nowFn: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      submit: async () => {
        throw new Error('upstream failed');
      },
    }), /upstream failed/);
    const state = await readQueueState(store);

    assert.deepEqual(state.entries, []);
    assert.equal(state.lastClientId, 'bob');
    assert.equal(state.lastSubmissionAt, 30_000);
    assert.equal(state.processingId, '');
  });

  it('runner removes its queued entry when waiting times out before submission', async () => {
    const store = new MemoryPresenceStore();
    let now = 40_000;
    const priorAlice = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '100', status: 'queue' }),
      now: now - 4_000,
      id: 'prior-alice',
    });
    const bobEntry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      now,
      id: 'bob-blocks-alice',
    });

    await enqueueVoteEntry(store, priorAlice, now - 4_000);
    await markVoteEntryProcessing(store, priorAlice.id, now - 4_000);
    await removeVoteEntry(store, priorAlice.id, {
      lastSubmissionAt: now - VOTE_INTERVAL_MS,
      lastClientId: 'alice',
    }, now - VOTE_INTERVAL_MS);
    await enqueueVoteEntry(store, bobEntry);

    await assert.rejects(() => runQueuedVote({
      queueStore: store,
      identity: alice,
      vote: vote({ osmId: '101' }),
      id: 'alice-timeout',
      nowFn: () => now,
      maxWaitMs: 250,
      sleep: async (ms) => {
        now += ms;
      },
      submit: async () => {
        throw new Error('should not submit');
      },
    }), /queue_wait_timeout/);

    const state = await readQueueState(store, now);
    assert.deepEqual(state.entries.map((entry) => entry.id), ['bob-blocks-alice']);
    assert.equal(state.processingId, '');
  });

  it('stale processing lease does not freeze queue or active client forever', async () => {
    const store = new MemoryPresenceStore();
    const processingAt = 50_000;
    const staleNow = processingAt + PROCESSING_LEASE_MS + 1;
    const staleEntry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: processingAt,
      id: 'stale-processing',
    });
    const replacement = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '102' }),
      now: staleNow,
      id: 'replacement-after-stale',
    });

    await enqueueVoteEntry(store, staleEntry);
    await markVoteEntryProcessing(store, staleEntry.id, processingAt);

    const cleaned = await readQueueState(store, staleNow);
    assert.deepEqual(cleaned.entries, []);
    assert.equal(cleaned.processingId, '');
    assert.equal(cleaned.lastClientId, 'alice');
    assert.equal(cleaned.lastSubmissionAt, processingAt);

    await enqueueVoteEntry(store, replacement, staleNow);
    assert.deepEqual((await readQueueState(store, staleNow)).entries.map((entry) => entry.id), [
      'replacement-after-stale',
    ]);
  });

  it('orders public positions with the next fair entry first', () => {
    const entries = [
      createVoteQueueEntry({
        identity: alice,
        vote: vote({ osmId: '101' }),
        now: 100,
        id: 'alice-first',
      }),
      createVoteQueueEntry({
        identity: bob,
        vote: vote({ osmId: '201', status: 'no' }),
        now: 110,
        id: 'bob-next',
      }),
      createVoteQueueEntry({
        identity: cara,
        vote: vote({ osmId: '301', status: 'queue' }),
        now: 120,
        id: 'cara-after',
      }),
    ];

    const snapshot = publicQueueSnapshot({
      entries,
      lastSubmissionAt: 0,
      lastClientId: 'alice',
      processingId: '',
    }, 200);

    assert.deepEqual(snapshot.entries.map((entry) => [entry.position, entry.id]), [
      [1, 'bob-next'],
      [2, 'alice-first'],
      [3, 'cara-after'],
    ]);
  });

  it('interleaves public positions by repeated fair selection', () => {
    const entries = [
      createVoteQueueEntry({
        identity: alice,
        vote: vote({ osmId: '101' }),
        now: 100,
        id: 'a1',
      }),
      createVoteQueueEntry({
        identity: bob,
        vote: vote({ osmId: '201', status: 'no' }),
        now: 110,
        id: 'b1',
      }),
      createVoteQueueEntry({
        identity: alice,
        vote: vote({ osmId: '102', status: 'queue' }),
        now: 120,
        id: 'a2',
      }),
      createVoteQueueEntry({
        identity: bob,
        vote: vote({ osmId: '202', status: 'yes' }),
        now: 130,
        id: 'b2',
      }),
      createVoteQueueEntry({
        identity: cara,
        vote: vote({ osmId: '301', status: 'queue' }),
        now: 140,
        id: 'c1',
      }),
    ];

    const snapshot = publicQueueSnapshot({
      entries,
      lastSubmissionAt: 0,
      lastClientId: 'alice',
      processingId: '',
    }, 200);

    assert.deepEqual(snapshot.entries.map((entry) => entry.id), ['b1', 'c1', 'a1', 'b2', 'a2']);
    assert.deepEqual(snapshot.entries.map((entry) => entry.position), [1, 2, 3, 4, 5]);
  });

  it('exposes processing item separately without private fields', () => {
    const processing = {
      ...createVoteQueueEntry({
        identity: alice,
        vote: vote({ text: 'processing secret' }),
        now: 60_000,
        id: 'processing-public',
      }),
      state: 'processing',
      processingAt: 60_500,
      processingLeaseUntil: 90_500,
    };
    const queued = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', text: 'queued secret' }),
      now: 61_000,
      id: 'queued-public',
    });

    const snapshot = publicQueueSnapshot({
      entries: [processing, queued],
      lastSubmissionAt: 0,
      lastClientId: '',
      processingId: processing.id,
    }, 62_000);

    assert.equal(snapshot.processing.id, 'processing-public');
    assert.equal(snapshot.processing.state, 'processing');
    assert.deepEqual(snapshot.entries.map((entry) => entry.id), ['queued-public']);
    assert.deepEqual(Object.keys(snapshot.processing).sort(), [
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

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('ip:'), false);
    assert.equal(serialized.includes('alice-session'), false);
    assert.equal(serialized.includes('processing secret'), false);
    assert.equal(serialized.includes('queued secret'), false);
    assert.equal(serialized.includes('private-fingerprint'), false);
  });

  it('ignores stale completion after lease reclamation when a newer submission exists', async () => {
    const store = new MemoryPresenceStore();
    const processingAt = 70_000;
    const staleNow = processingAt + PROCESSING_LEASE_MS + 1;
    const newerSubmissionAt = staleNow + 5_000;
    const staleEntry = createVoteQueueEntry({
      identity: alice,
      vote: vote({ osmId: '101' }),
      now: processingAt,
      id: 'late-stale-processing',
    });
    const newerEntry = createVoteQueueEntry({
      identity: bob,
      vote: vote({ osmId: '201', status: 'no' }),
      now: newerSubmissionAt,
      id: 'newer-submission',
    });

    await enqueueVoteEntry(store, staleEntry, processingAt);
    await markVoteEntryProcessing(store, staleEntry.id, processingAt);
    await readQueueState(store, staleNow);

    await enqueueVoteEntry(store, newerEntry, newerSubmissionAt);
    await markVoteEntryProcessing(store, newerEntry.id, newerSubmissionAt);
    await removeVoteEntry(store, newerEntry.id, {
      lastSubmissionAt: newerSubmissionAt,
      lastClientId: 'bob',
    }, newerSubmissionAt);

    await removeVoteEntry(store, staleEntry.id, {
      lastSubmissionAt: processingAt,
      lastClientId: 'alice',
    }, processingAt);

    const state = await readQueueState(store, newerSubmissionAt);
    assert.equal(state.lastSubmissionAt, newerSubmissionAt);
    assert.equal(state.lastClientId, 'bob');
    assert.deepEqual(state.entries, []);
  });
});

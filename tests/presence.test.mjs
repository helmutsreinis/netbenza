import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_WINDOW_MS,
  MemoryPresenceStore,
  assertActiveSession,
  createPresenceRecord,
  handlePresenceRequest,
  normalizePresenceBody,
  normalizeSessionId,
  presenceKey,
  presenceSnapshot,
} from '../netlify/functions/lib/presence-store.mjs';

describe('presence helpers', () => {
  it('normalizes user-controlled presence fields', () => {
    const normalized = normalizePresenceBody({
      clientId: ' client one ',
      sessionId: ' session one ',
      sessionStartedAt: 123_000,
      handle: '  A very long handle that should be clipped after a reasonable length ',
      avatar: '/avatars/test.png',
      activity: 'voting',
      detail: 'Station 123',
    });

    assert.equal(normalized.clientId, 'client-one');
    assert.equal(normalized.sessionId, 'session-one');
    assert.equal(normalized.sessionStartedAt, 123_000);
    assert.equal(normalized.handle.length <= 32, true);
    assert.equal(normalized.avatar, '/avatars/test.png');
    assert.equal(normalized.activity, 'voting');
    assert.equal(normalized.detail, 'Station 123');
  });

  it('normalizes session ids separately from client ids', () => {
    assert.equal(normalizeSessionId(' tab:one / active '), 'tab:one-active');
  });

  it('falls back to safe defaults for invalid optional fields', () => {
    const normalized = normalizePresenceBody({
      clientId: 'abc',
      sessionId: 'session-abc',
      sessionStartedAt: 2_000_000,
      handle: '',
      avatar: 'https://example.com/avatar.png',
      activity: 'unknown',
      detail: 42,
    });

    assert.equal(normalized.handle, 'Anonymous');
    assert.equal(normalized.avatar, '');
    assert.equal(normalized.activity, 'online');
    assert.equal(normalized.detail, '');
  });

  it('returns only active users and removes expired records', async () => {
    const store = new MemoryPresenceStore();
    const now = 1_000_000;
    await store.setJSON(presenceKey('active', 'active-session'), createPresenceRecord({
      clientId: 'active',
      sessionId: 'active-session',
      sessionStartedAt: now,
      handle: 'Active',
      avatar: '/avatars/a.png',
      activity: 'online',
      detail: '',
      ipKey: 'ip:active',
    }, now));
    await store.setJSON('clients/active', {
      clientId: 'active',
      latestSessionId: 'active-session',
      latestStartedAt: now,
      updatedAt: now,
      endedAt: 0,
    });
    await store.setJSON('ips/ip:active', {
      ipKey: 'ip:active',
      latestClientId: 'active',
      latestSessionId: 'active-session',
      latestStartedAt: now,
      updatedAt: now,
      endedAt: 0,
    });
    await store.setJSON(presenceKey('expired', 'expired-session'), createPresenceRecord({
      clientId: 'expired',
      sessionId: 'expired-session',
      sessionStartedAt: now - ACTIVE_WINDOW_MS - 1,
      handle: 'Expired',
      avatar: '/avatars/b.png',
      activity: 'idle',
      detail: '',
      ipKey: 'ip:expired',
    }, now - ACTIVE_WINDOW_MS - 1));

    const snapshot = await presenceSnapshot(store, now);

    assert.deepEqual(snapshot.users.map((user) => user.clientId), ['active']);
    assert.equal(await store.get(presenceKey('expired', 'expired-session'), { type: 'json' }), null);
  });

  it('handles POST and GET requests with a blob-like store', async () => {
    const store = new MemoryPresenceStore();
    const now = 2_000_000;
    const post = new Request('https://site.test/api/presence', {
      method: 'POST',
      body: JSON.stringify({
        clientId: 'abc',
        sessionId: 'session-abc',
        sessionStartedAt: now,
        handle: 'Nina',
        avatar: '/avatars/nina.png',
        activity: 'searching',
      }),
    });

    const postResponse = await handlePresenceRequest(post, store, () => now);
    const postJson = await postResponse.json();

    assert.equal(postResponse.status, 200);
    assert.equal(postJson.users.length, 1);
    assert.equal(postJson.users[0].handle, 'Nina');

    const getResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence'),
      store,
      () => now + 1000,
    );
    const getJson = await getResponse.json();

    assert.equal(getResponse.status, 200);
    assert.equal(getJson.users[0].activity, 'searching');
  });

  it('rejects POST without sessionId and does not create presence', async () => {
    const store = new MemoryPresenceStore();
    const now = 2_500_000;
    const post = new Request('https://site.test/api/presence', {
      method: 'POST',
      body: JSON.stringify({
        clientId: 'missing-session',
        handle: 'No Session',
        avatar: '/avatars/no-session.png',
        activity: 'online',
      }),
    });

    const response = await handlePresenceRequest(post, store, () => now);
    const body = await response.json();
    const snapshot = await presenceSnapshot(store, now);

    assert.equal(response.status, 400);
    assert.match(body.detail, /sessionId/);
    assert.deepEqual(snapshot.users, []);
  });

  it('keeps only the newest session for a clientId', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.7' };
    const first = new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'tab-one',
        sessionStartedAt: 3_000_000,
        handle: 'First tab',
        avatar: '/avatars/first.png',
        activity: 'online',
      }),
    });
    const second = new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'tab-two',
        sessionStartedAt: 3_000_500,
        handle: 'Second tab',
        avatar: '/avatars/second.png',
        activity: 'filtering',
      }),
    });

    await handlePresenceRequest(first, store, () => 3_000_000);
    await handlePresenceRequest(second, store, () => 3_000_500);
    const stalePostResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'tab-one',
        sessionStartedAt: 3_000_000,
        handle: 'First tab',
        avatar: '/avatars/first.png',
        activity: 'online',
      }),
    }), store, () => 3_001_000);
    const stalePostJson = await stalePostResponse.json();

    const staleResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-one&sessionId=tab-one', { headers: ipHeaders }),
      store,
      () => 3_001_500,
    );
    const staleJson = await staleResponse.json();
    const stored = await store.get(presenceKey('client-one', 'tab-two'), { type: 'json' });

    assert.equal(stalePostResponse.status, 200);
    assert.deepEqual(stalePostJson.users.map((user) => user.handle), ['Second tab']);
    assert.deepEqual(stalePostJson.session, { active: false, reason: 'client_replaced' });
    assert.equal(staleResponse.status, 200);
    assert.deepEqual(staleJson.users.map((user) => user.handle), ['Second tab']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'client_replaced' });
    assert.equal(stored.sessionId, 'tab-two');
    assert.equal(staleJson.users[0].ipKey, undefined);
    assert.equal(staleJson.users[0].sessionId, undefined);
  });

  it('keeps an old same-client session inactive after more than the previous history limit of newer sessions', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.77' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'rollover-client',
        sessionId: 'session-000',
        sessionStartedAt: 10_000,
        handle: 'Old rollover',
        avatar: '/avatars/old-rollover.png',
        activity: 'online',
      }),
    }), store, () => 10_000);

    for (let index = 1; index <= 25; index += 1) {
      await handlePresenceRequest(new Request('https://site.test/api/presence', {
        method: 'POST',
        headers: ipHeaders,
        body: JSON.stringify({
          clientId: 'rollover-client',
          sessionId: `session-${String(index).padStart(3, '0')}`,
          sessionStartedAt: 10_000 + index,
          handle: `New ${index}`,
          avatar: '/avatars/new-rollover.png',
          activity: 'online',
        }),
      }), store, () => 10_000 + index);
    }

    const staleResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'rollover-client',
        sessionId: 'session-000',
        sessionStartedAt: 10_000,
        handle: 'Old rollover',
        avatar: '/avatars/old-rollover.png',
        activity: 'online',
      }),
    }), store, () => 11_000);
    const staleJson = await staleResponse.json();

    assert.deepEqual(staleJson.users.map((user) => user.handle), ['New 25']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'client_replaced' });
  });

  it('ignores a delayed stale POST with an older sessionStartedAt', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.88' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'delayed-client',
        sessionId: 'new-session',
        sessionStartedAt: 20_000,
        handle: 'Fresh tab',
        avatar: '/avatars/fresh.png',
        activity: 'searching',
      }),
    }), store, () => 20_000);

    const delayedResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'delayed-client',
        sessionId: 'old-session',
        sessionStartedAt: 19_000,
        handle: 'Delayed old tab',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => 21_000);
    const delayedJson = await delayedResponse.json();

    assert.deepEqual(delayedJson.users.map((user) => user.handle), ['Fresh tab']);
    assert.deepEqual(delayedJson.session, { active: false, reason: 'client_replaced' });
  });

  it('clamps far-future sessionStartedAt values before they can poison high-watermarks', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.91' };
    const now = 50_000;

    const futureResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'future-client',
        sessionId: 'future-session',
        sessionStartedAt: now + 10 * 60_000,
        handle: 'Future tab',
        avatar: '/avatars/future.png',
        activity: 'online',
      }),
    }), store, () => now);
    const futureJson = await futureResponse.json();
    const futureRecord = await store.get(presenceKey('future-client', 'future-session'), { type: 'json' });

    assert.equal(futureResponse.status, 200);
    assert.deepEqual(futureJson.users.map((user) => user.handle), ['Future tab']);
    assert.equal(futureRecord.sessionStartedAt, now);
    assert.equal(futureRecord.acceptedAt, now);

    const normalResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'future-client',
        sessionId: 'normal-session',
        sessionStartedAt: now + 1000,
        handle: 'Normal tab',
        avatar: '/avatars/normal.png',
        activity: 'online',
      }),
    }), store, () => now + 1000);
    const normalJson = await normalResponse.json();

    assert.equal(normalResponse.status, 200);
    assert.deepEqual(normalJson.users.map((user) => user.handle), ['Normal tab']);
    assert.deepEqual(normalJson.session, { active: true });
  });

  it('clamps near-future same-client sessions so they cannot block normal sessions after expiry', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.94' };
    const now = 52_000;

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'near-future-client',
        sessionId: 'near-future-session',
        sessionStartedAt: now + 60_000,
        handle: 'Near future tab',
        avatar: '/avatars/future.png',
        activity: 'online',
      }),
    }), store, () => now);
    const futureRecord = await store.get(presenceKey('near-future-client', 'near-future-session'), { type: 'json' });

    const later = now + ACTIVE_WINDOW_MS + 1;
    const normalResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'near-future-client',
        sessionId: 'normal-after-near-future',
        sessionStartedAt: later,
        handle: 'Normal after near future',
        avatar: '/avatars/normal.png',
        activity: 'searching',
      }),
    }), store, () => later);
    const normalJson = await normalResponse.json();
    const clientState = await store.get('clients/near-future-client', { type: 'json' });

    assert.equal(futureRecord.sessionStartedAt, now);
    assert.equal(normalResponse.status, 200);
    assert.deepEqual(normalJson.users.map((user) => user.handle), ['Normal after near future']);
    assert.deepEqual(normalJson.session, { active: true });
    assert.equal(clientState.latestStartedAt, later);
  });

  it('ignores previously stored far-future high-watermarks when accepting a normal session', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.93' };
    const ipKey = 'ip:203.0.113.93';
    const now = 55_000;
    const futureStartedAt = now + 10 * 60_000;

    await store.setJSON(presenceKey('poison-client', 'poison-session'), {
      clientId: 'poison-client',
      sessionId: 'poison-session',
      sessionStartedAt: futureStartedAt,
      handle: 'Poisoned future',
      avatar: '/avatars/future.png',
      activity: 'online',
      detail: '',
      ipKey,
      acceptedAt: now - ACTIVE_WINDOW_MS - 1,
      lastSeen: now - ACTIVE_WINDOW_MS - 1,
      endedAt: 0,
    });
    await store.setJSON('clients/poison-client', {
      clientId: 'poison-client',
      latestSessionId: 'poison-session',
      latestStartedAt: futureStartedAt,
      latestAcceptedAt: now - ACTIVE_WINDOW_MS - 1,
      updatedAt: now - ACTIVE_WINDOW_MS - 1,
      endedAt: 0,
    });
    await store.setJSON(`ips/${ipKey}`, {
      ipKey,
      latestClientId: 'poison-client',
      latestSessionId: 'poison-session',
      latestStartedAt: futureStartedAt,
      latestAcceptedAt: now - ACTIVE_WINDOW_MS - 1,
      updatedAt: now - ACTIVE_WINDOW_MS - 1,
      endedAt: 0,
    });

    const normalResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'poison-client',
        sessionId: 'normal-session',
        sessionStartedAt: now,
        handle: 'Normal after poison',
        avatar: '/avatars/normal.png',
        activity: 'online',
      }),
    }), store, () => now);
    const normalJson = await normalResponse.json();

    assert.equal(normalResponse.status, 200);
    assert.deepEqual(normalJson.users.map((user) => user.handle), ['Normal after poison']);
    assert.deepEqual(normalJson.session, { active: true });
  });

  it('keeps the later accepted same-client session active when sessionStartedAt ties', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.92' };
    const sessionStartedAt = 60_000;

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ms-client',
        sessionId: 'same-ms-old',
        sessionStartedAt,
        handle: 'Old same ms',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => sessionStartedAt);
    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ms-client',
        sessionId: 'same-ms-new',
        sessionStartedAt,
        handle: 'New same ms',
        avatar: '/avatars/new.png',
        activity: 'selecting',
      }),
    }), store, () => sessionStartedAt + 1);

    const staleResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ms-client',
        sessionId: 'same-ms-old',
        sessionStartedAt,
        handle: 'Old same ms',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => sessionStartedAt + 2000);
    const staleJson = await staleResponse.json();
    const oldRecord = await store.get(presenceKey('same-ms-client', 'same-ms-old'), { type: 'json' });
    const newRecord = await store.get(presenceKey('same-ms-client', 'same-ms-new'), { type: 'json' });

    assert.deepEqual(staleJson.users.map((user) => user.handle), ['New same ms']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'client_replaced' });
    assert.equal(oldRecord.acceptedAt, sessionStartedAt);
    assert.equal(newRecord.acceptedAt, sessionStartedAt + 1);
  });

  it('keeps only the newest profile for an IP address without exposing the IP', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-forwarded-for': '198.51.100.24, 10.0.0.1' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-old',
        sessionId: 'session-old',
        sessionStartedAt: 4_000_000,
        handle: 'Old profile',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => 4_000_000);
    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-new',
        sessionId: 'session-new',
        sessionStartedAt: 4_001_000,
        handle: 'New profile',
        avatar: '/avatars/new.png',
        activity: 'selecting',
      }),
    }), store, () => 4_001_000);

    const stalePostResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-old',
        sessionId: 'session-old',
        sessionStartedAt: 4_000_000,
        handle: 'Old profile',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => 4_001_250);
    const stalePostJson = await stalePostResponse.json();
    const staleDeleteResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-old&sessionId=session-old', {
        method: 'DELETE',
        headers: ipHeaders,
      }),
      store,
      () => 4_001_350,
    );
    const staleDeleteJson = await staleDeleteResponse.json();
    const staleResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-old&sessionId=session-old', { headers: ipHeaders }),
      store,
      () => 4_001_500,
    );
    const staleJson = await staleResponse.json();
    const serialized = JSON.stringify(staleJson);

    assert.deepEqual(stalePostJson.users.map((user) => user.clientId), ['client-new']);
    assert.deepEqual(stalePostJson.session, { active: false, reason: 'ip_replaced' });
    assert.deepEqual(staleDeleteJson.users.map((user) => user.clientId), ['client-new']);
    assert.deepEqual(staleDeleteJson.session, { active: false, reason: 'ip_replaced' });
    assert.deepEqual(staleJson.users.map((user) => user.clientId), ['client-new']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'ip_replaced' });
    assert.equal(await store.get('users/client-old', { type: 'json' }), null);
    assert.equal(staleJson.users[0].ipKey, undefined);
    assert.equal(serialized.includes('198.51.100.24'), false);
    assert.equal(serialized.includes('ip:'), false);
  });

  it('keeps an IP-replaced old profile inactive when it changes sessionId with an older sessionStartedAt', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-forwarded-for': '198.51.100.99' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'ip-old-client',
        sessionId: 'ip-old-session',
        sessionStartedAt: 30_000,
        handle: 'Old IP profile',
        avatar: '/avatars/old-ip.png',
        activity: 'online',
      }),
    }), store, () => 30_000);
    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'ip-new-client',
        sessionId: 'ip-new-session',
        sessionStartedAt: 31_000,
        handle: 'New IP profile',
        avatar: '/avatars/new-ip.png',
        activity: 'selecting',
      }),
    }), store, () => 31_000);

    const staleResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'ip-old-client',
        sessionId: 'ip-old-session-renamed',
        sessionStartedAt: 30_000,
        handle: 'Old IP profile renamed',
        avatar: '/avatars/old-ip.png',
        activity: 'online',
      }),
    }), store, () => 32_000);
    const staleJson = await staleResponse.json();

    assert.deepEqual(staleJson.users.map((user) => user.clientId), ['ip-new-client']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'ip_replaced' });
  });

  it('keeps the later accepted same-IP profile active when sessionStartedAt ties', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-forwarded-for': '198.51.100.101' };
    const sessionStartedAt = 70_000;

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-old',
        sessionId: 'same-ip-old-session',
        sessionStartedAt,
        handle: 'Old same IP',
        avatar: '/avatars/old-ip.png',
        activity: 'online',
      }),
    }), store, () => sessionStartedAt);
    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-new',
        sessionId: 'same-ip-new-session',
        sessionStartedAt,
        handle: 'New same IP',
        avatar: '/avatars/new-ip.png',
        activity: 'selecting',
      }),
    }), store, () => sessionStartedAt + 1);

    const staleResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-old',
        sessionId: 'same-ip-old-session',
        sessionStartedAt,
        handle: 'Old same IP',
        avatar: '/avatars/old-ip.png',
        activity: 'online',
      }),
    }), store, () => sessionStartedAt + 2000);
    const staleJson = await staleResponse.json();

    assert.deepEqual(staleJson.users.map((user) => user.clientId), ['same-ip-new']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'ip_replaced' });
  });

  it('clamps future-ish same-IP profile times so later normal profiles can replace them', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-forwarded-for': '198.51.100.102' };
    const now = 80_000;

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-current',
        sessionId: 'current-session',
        sessionStartedAt: now,
        handle: 'Current IP',
        avatar: '/avatars/current-ip.png',
        activity: 'selecting',
      }),
    }), store, () => now);

    const futureReceipt = now + 1000;
    const futureResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-future',
        sessionId: 'future-session',
        sessionStartedAt: now + 60_000,
        handle: 'Future IP',
        avatar: '/avatars/future-ip.png',
        activity: 'online',
      }),
    }), store, () => futureReceipt);
    const futureJson = await futureResponse.json();
    const futureRecord = await store.get(presenceKey('same-ip-future', 'future-session'), { type: 'json' });
    const snapshot = await presenceSnapshot(store, futureReceipt, {
      clientId: 'same-ip-future',
      sessionId: 'future-session',
      ipKey: 'ip:198.51.100.102',
    });

    const later = futureReceipt + ACTIVE_WINDOW_MS + 1;
    const normalResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'same-ip-normal',
        sessionId: 'normal-session',
        sessionStartedAt: later,
        handle: 'Normal IP',
        avatar: '/avatars/normal-ip.png',
        activity: 'online',
      }),
    }), store, () => later);
    const normalJson = await normalResponse.json();

    assert.equal(futureResponse.status, 200);
    assert.deepEqual(futureJson.users.map((user) => user.clientId), ['same-ip-future']);
    assert.equal(futureRecord.sessionStartedAt, futureReceipt);
    assert.deepEqual(snapshot.users.map((user) => user.clientId), ['same-ip-future']);
    assert.equal(normalResponse.status, 200);
    assert.deepEqual(normalJson.users.map((user) => user.clientId), ['same-ip-normal']);
    assert.deepEqual(normalJson.session, { active: true });
  });

  it('does not remove an active record when DELETE omits sessionId', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.55' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'delete-client',
        sessionId: 'delete-session',
        sessionStartedAt: 4_500_000,
        handle: 'Still Here',
        avatar: '/avatars/still.png',
        activity: 'online',
      }),
    }), store, () => 4_500_000);

    const response = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=delete-client', {
        method: 'DELETE',
        headers: ipHeaders,
      }),
      store,
      () => 4_500_500,
    );
    const body = await response.json();

    assert.deepEqual(body.session, { active: false, reason: 'invalid_session' });
    assert.deepEqual(body.users.map((user) => user.clientId), ['delete-client']);
    assert.equal(
      (await store.get(presenceKey('delete-client', 'delete-session'), { type: 'json' })).sessionId,
      'delete-session',
    );
  });

  it('ignores stale DELETE calls so old tabs cannot remove the active session', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'client-ip': '192.0.2.44' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-one',
        sessionStartedAt: 5_000_000,
        handle: 'Old tab',
        avatar: '/avatars/old.png',
        activity: 'online',
      }),
    }), store, () => 5_000_000);
    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-two',
        sessionStartedAt: 5_000_500,
        handle: 'Active tab',
        avatar: '/avatars/active.png',
        activity: 'searching',
      }),
    }), store, () => 5_000_500);

    const staleDeleteResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-one&sessionId=session-one', {
        method: 'DELETE',
        headers: ipHeaders,
      }),
      store,
      () => 5_001_000,
    );
    const staleDeleteJson = await staleDeleteResponse.json();

    assert.deepEqual(staleDeleteJson.session, { active: false, reason: 'client_replaced' });
    assert.deepEqual(staleDeleteJson.users.map((user) => user.handle), ['Active tab']);

    const activeDeleteResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-one&sessionId=session-two', {
        method: 'DELETE',
        headers: ipHeaders,
      }),
      store,
      () => 5_001_500,
    );
    const activeDeleteJson = await activeDeleteResponse.json();

    assert.deepEqual(activeDeleteJson.session, { active: false, reason: 'not_found' });
    assert.deepEqual(activeDeleteJson.users, []);
  });

  it('does not let an older session become active after the latest session is deleted', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'client-ip': '192.0.2.99' };

    await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'delete-tombstone-client',
        sessionId: 'latest-session',
        sessionStartedAt: 40_000,
        handle: 'Latest',
        avatar: '/avatars/latest.png',
        activity: 'online',
      }),
    }), store, () => 40_000);
    await handlePresenceRequest(new Request('https://site.test/api/presence?clientId=delete-tombstone-client&sessionId=latest-session', {
      method: 'DELETE',
      headers: ipHeaders,
    }), store, () => 40_500);

    const staleResponse = await handlePresenceRequest(new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'delete-tombstone-client',
        sessionId: 'older-delayed-session',
        sessionStartedAt: 39_000,
        handle: 'Older delayed',
        avatar: '/avatars/older.png',
        activity: 'online',
      }),
    }), store, () => 41_000);
    const staleJson = await staleResponse.json();

    assert.deepEqual(staleJson.users, []);
    assert.deepEqual(staleJson.session, { active: false, reason: 'client_replaced' });
  });

  it('rejects missing or empty session ids in active session assertions', async () => {
    const store = new MemoryPresenceStore();

    await assert.rejects(
      assertActiveSession(store, { clientId: 'assert-client', ipKey: 'ip:assert' }, 6_000_000),
      /invalid_session/,
    );
    await assert.rejects(
      assertActiveSession(store, { clientId: 'assert-client', sessionId: '', ipKey: 'ip:assert' }, 6_000_000),
      /invalid_session/,
    );
  });

  it('arbitrates snapshots through the active IP mapping when stale records remain', async () => {
    const store = new MemoryPresenceStore();
    const now = 7_000_000;
    const ipKey = 'ip:shared-arbitration';

    await store.setJSON(presenceKey('ip-old', 'old-session'), createPresenceRecord({
      clientId: 'ip-old',
      sessionId: 'old-session',
      sessionStartedAt: now,
      handle: 'Old IP',
      avatar: '/avatars/old-ip.png',
      activity: 'online',
      detail: '',
      ipKey,
    }, now));
    await store.setJSON(presenceKey('ip-new', 'new-session'), createPresenceRecord({
      clientId: 'ip-new',
      sessionId: 'new-session',
      sessionStartedAt: now + 1,
      handle: 'New IP',
      avatar: '/avatars/new-ip.png',
      activity: 'online',
      detail: '',
      ipKey,
    }, now + 1));
    await store.setJSON('clients/ip-old', {
      clientId: 'ip-old',
      latestSessionId: 'old-session',
      latestStartedAt: now,
      updatedAt: now,
      endedAt: 0,
    });
    await store.setJSON('clients/ip-new', {
      clientId: 'ip-new',
      latestSessionId: 'new-session',
      latestStartedAt: now + 1,
      updatedAt: now + 1,
      endedAt: 0,
    });
    await store.setJSON(`ips/${ipKey}`, {
      ipKey,
      latestClientId: 'ip-new',
      latestSessionId: 'new-session',
      latestStartedAt: now + 1,
      updatedAt: now + 1,
      endedAt: 0,
    });

    const snapshot = await presenceSnapshot(store, now, {
      clientId: 'ip-old',
      sessionId: 'old-session',
      ipKey,
    });

    assert.deepEqual(snapshot.users.map((user) => user.clientId), ['ip-new']);
    assert.deepEqual(snapshot.session, { active: false, reason: 'ip_replaced' });
    assert.equal(JSON.stringify(snapshot).includes(ipKey), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_WINDOW_MS,
  MemoryPresenceStore,
  createPresenceRecord,
  handlePresenceRequest,
  normalizePresenceBody,
  normalizeSessionId,
  presenceSnapshot,
} from '../netlify/functions/lib/presence-store.mjs';

describe('presence helpers', () => {
  it('normalizes user-controlled presence fields', () => {
    const normalized = normalizePresenceBody({
      clientId: ' client one ',
      sessionId: ' session one ',
      handle: '  A very long handle that should be clipped after a reasonable length ',
      avatar: '/avatars/test.png',
      activity: 'voting',
      detail: 'Station 123',
    });

    assert.equal(normalized.clientId, 'client-one');
    assert.equal(normalized.sessionId, 'session-one');
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
    await store.setJSON('users/active', createPresenceRecord({
      clientId: 'active',
      handle: 'Active',
      avatar: '/avatars/a.png',
      activity: 'online',
      detail: '',
    }, now));
    await store.setJSON('users/expired', createPresenceRecord({
      clientId: 'expired',
      handle: 'Expired',
      avatar: '/avatars/b.png',
      activity: 'idle',
      detail: '',
    }, now - ACTIVE_WINDOW_MS - 1));

    const snapshot = await presenceSnapshot(store, now);

    assert.deepEqual(snapshot.users.map((user) => user.clientId), ['active']);
    assert.equal(await store.get('users/expired', { type: 'json' }), null);
  });

  it('handles POST and GET requests with a blob-like store', async () => {
    const store = new MemoryPresenceStore();
    const now = 2_000_000;
    const post = new Request('https://site.test/api/presence', {
      method: 'POST',
      body: JSON.stringify({
        clientId: 'abc',
        sessionId: 'session-abc',
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

  it('keeps only the newest session for a clientId', async () => {
    const store = new MemoryPresenceStore();
    const ipHeaders = { 'x-real-ip': '203.0.113.7' };
    const first = new Request('https://site.test/api/presence', {
      method: 'POST',
      headers: ipHeaders,
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'tab-one',
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
        handle: 'Second tab',
        avatar: '/avatars/second.png',
        activity: 'filtering',
      }),
    });

    await handlePresenceRequest(first, store, () => 3_000_000);
    await handlePresenceRequest(second, store, () => 3_000_500);

    const staleResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-one&sessionId=tab-one', { headers: ipHeaders }),
      store,
      () => 3_001_000,
    );
    const staleJson = await staleResponse.json();
    const stored = await store.get('users/client-one', { type: 'json' });

    assert.equal(staleResponse.status, 200);
    assert.deepEqual(staleJson.users.map((user) => user.handle), ['Second tab']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'client_replaced' });
    assert.equal(stored.sessionId, 'tab-two');
    assert.equal(staleJson.users[0].ipKey, undefined);
    assert.equal(staleJson.users[0].sessionId, undefined);
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
        handle: 'New profile',
        avatar: '/avatars/new.png',
        activity: 'selecting',
      }),
    }), store, () => 4_001_000);

    const staleResponse = await handlePresenceRequest(
      new Request('https://site.test/api/presence?clientId=client-old&sessionId=session-old', { headers: ipHeaders }),
      store,
      () => 4_001_500,
    );
    const staleJson = await staleResponse.json();
    const serialized = JSON.stringify(staleJson);

    assert.deepEqual(staleJson.users.map((user) => user.clientId), ['client-new']);
    assert.deepEqual(staleJson.session, { active: false, reason: 'ip_replaced' });
    assert.equal(await store.get('users/client-old', { type: 'json' }), null);
    assert.equal(staleJson.users[0].ipKey, undefined);
    assert.equal(serialized.includes('198.51.100.24'), false);
    assert.equal(serialized.includes('ip:'), false);
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
});

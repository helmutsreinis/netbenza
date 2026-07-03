import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_WINDOW_MS,
  MemoryPresenceStore,
  createPresenceRecord,
  handlePresenceRequest,
  normalizePresenceBody,
  presenceSnapshot,
} from '../netlify/functions/lib/presence-store.mjs';

describe('presence helpers', () => {
  it('normalizes user-controlled presence fields', () => {
    const normalized = normalizePresenceBody({
      clientId: ' client one ',
      handle: '  A very long handle that should be clipped after a reasonable length ',
      avatar: '/avatars/test.png',
      activity: 'voting',
      detail: 'Station 123',
    });

    assert.equal(normalized.clientId, 'client-one');
    assert.equal(normalized.handle.length <= 32, true);
    assert.equal(normalized.avatar, '/avatars/test.png');
    assert.equal(normalized.activity, 'voting');
    assert.equal(normalized.detail, 'Station 123');
  });

  it('falls back to safe defaults for invalid optional fields', () => {
    const normalized = normalizePresenceBody({
      clientId: 'abc',
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
});

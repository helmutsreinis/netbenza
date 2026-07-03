import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAccessChallenge,
  issueAccessToken,
} from '../netlify/functions/lib/access-gate-store.mjs';
import {
  MemoryPresenceStore,
  handlePresenceRequest,
} from '../netlify/functions/lib/presence-store.mjs';
import {
  appendChatMessage,
  normalizeChatText,
  publicChatSnapshot,
  readChatState,
} from '../netlify/functions/lib/chat-store.mjs';
import chatHandler, { handleChatRequest } from '../netlify/functions/chat.mjs';

function correctAnswers(challenge) {
  return Object.fromEntries(challenge.questions.map((question) => [question.id, question.correct]));
}

async function accessContext({ ip = '198.51.100.42', now = 1_000_000 } = {}) {
  const store = new MemoryPresenceStore();
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
      activity: 'online',
    }),
  }), store, () => now);

  assert.equal(response.status, 200);
  return response.json();
}

class FailingReadStore extends MemoryPresenceStore {
  async get() {
    throw new Error('blob_read_failed');
  }
}

class FailingWriteStore extends MemoryPresenceStore {
  async setJSON() {
    throw new Error('blob_write_failed');
  }
}

class IpLeakReadStore extends MemoryPresenceStore {
  async get() {
    throw new Error('198.51.100.88');
  }
}

describe('chat store', () => {
  it('normalizeChatText trims, collapses, and clips text', () => {
    assert.equal(normalizeChatText('  hello\n\tthere   friend  '), 'hello there friend');
    assert.equal(normalizeChatText('x'.repeat(300)).length, 240);
    assert.equal(normalizeChatText(` ${'a '.repeat(300)} `).length <= 240, true);
    assert.equal(/\s{2,}/.test(normalizeChatText('a \n\t b')), false);
    assert.equal(normalizeChatText(' \n\t '), '');
  });

  it('appendChatMessage keeps only the latest 50 messages and public snapshot omits private fields', async () => {
    const store = new MemoryPresenceStore();
    const identity = {
      clientId: 'client-one',
      sessionId: 'secret-session',
      ipKey: 'ip:203.0.113.7',
      handle: 'Alice',
      avatar: '/avatars/alice.png',
    };

    for (let index = 1; index <= 55; index += 1) {
      await appendChatMessage(store, identity, ` message ${index} `, 10_000 + index, `message-${index}`);
    }

    const state = await readChatState(store);
    const snapshot = publicChatSnapshot(state, 20_000);
    const serialized = JSON.stringify(snapshot);

    assert.equal(state.messages.length, 50);
    assert.equal(state.messages[0].id, 'message-6');
    assert.equal(state.messages.at(-1).id, 'message-55');
    assert.deepEqual(Object.keys(snapshot.messages[0]).sort(), [
      'avatar',
      'clientId',
      'createdAt',
      'handle',
      'id',
      'text',
    ]);
    assert.equal(snapshot.messages[0].text, 'message 6');
    assert.equal(serialized.includes('secret-session'), false);
    assert.equal(serialized.includes('ip:'), false);
    assert.equal(serialized.includes('accessToken'), false);
    assert.equal(serialized.includes('203.0.113.7'), false);
  });
});

describe('Netlify chat route', () => {
  it('GET requires access and returns messages', async () => {
    const now = 1_500_000;
    const access = await accessContext({ now, ip: '198.51.100.50' });
    const chatStore = new MemoryPresenceStore();
    await appendChatMessage(chatStore, {
      clientId: 'client-one',
      sessionId: 'session-one',
      ipKey: 'ip:198.51.100.50',
      handle: 'Nina',
      avatar: '/avatars/nina.png',
    }, 'Hello from chat', now, 'message-one');

    const denied = await chatHandler(new Request('https://site.test/api/chat'));
    const deniedBody = await denied.json();
    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      chatStore,
      nowFn: () => now + 1000,
    });
    const body = await response.json();

    assert.equal(denied.status, 401);
    assert.equal(deniedBody.detail, 'access_token_missing');
    assert.equal(response.status, 200);
    assert.deepEqual(body.messages, [{
      id: 'message-one',
      clientId: 'client-one',
      handle: 'Nina',
      avatar: '/avatars/nina.png',
      text: 'Hello from chat',
      createdAt: now,
    }]);
    assert.equal(body.serverTime, now + 1000);
  });

  it('POST appends with active presence handle and avatar instead of spoofed body display fields', async () => {
    const now = 2_000_000;
    const access = await accessContext({ now, ip: '198.51.100.51' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
      handle: 'Presence Operator',
      avatar: '/avatars/presence.png',
    });

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-one',
        text: '  Hello\nchat  ',
        handle: 'Spoofed Operator',
        avatar: '/avatars/spoofed.png',
        ipKey: 'ip:client-supplied',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore,
      nowFn: () => now + 500,
      id: 'chat-one',
    });
    const body = await response.json();
    const state = await readChatState(chatStore);
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].clientId, 'client-one');
    assert.equal(body.messages[0].handle, 'Presence Operator');
    assert.equal(body.messages[0].avatar, '/avatars/presence.png');
    assert.equal(body.messages[0].text, 'Hello chat');
    assert.equal(body.messages[0].id, 'chat-one');
    assert.equal(state.messages[0].ipKey, 'ip:198.51.100.51');
    assert.equal(serialized.includes('Spoofed Operator'), false);
    assert.equal(serialized.includes('/avatars/spoofed.png'), false);
    assert.equal(serialized.includes('client-supplied'), false);
    assert.equal(serialized.includes('session-one'), false);
  });

  it('POST stores canonical active presence identity when body ids need normalization', async () => {
    const now = 2_250_000;
    const access = await accessContext({ now, ip: '198.51.100.55' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: ' client one ',
      sessionId: ' tab:one / active ',
      handle: 'Canonical Operator',
      avatar: '/avatars/canonical.png',
    });

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: ' client one ',
        sessionId: ' tab:one / active ',
        text: 'canonical hello',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore,
      nowFn: () => now + 500,
      id: 'canonical-chat',
    });
    const body = await response.json();
    const state = await readChatState(chatStore);

    assert.equal(response.status, 200);
    assert.equal(body.messages[0].clientId, 'client-one');
    assert.equal(body.messages[0].handle, 'Canonical Operator');
    assert.equal(body.messages[0].avatar, '/avatars/canonical.png');
    assert.equal(state.messages[0].clientId, 'client-one');
    assert.equal(state.messages[0].sessionId, 'tab:one-active');
    assert.equal(state.messages[0].handle, 'Canonical Operator');
    assert.equal(state.messages[0].avatar, '/avatars/canonical.png');
  });

  it('POST stale session returns 409 and does not append', async () => {
    let now = 2_500_000;
    const access = await accessContext({ now, ip: '198.51.100.52' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();

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

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'old-session',
        text: 'stale hello',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore,
      nowFn: () => now + 100,
    });
    const body = await response.json();
    const state = await readChatState(chatStore);

    assert.equal(response.status, 409);
    assert.equal(body.detail, 'client_replaced');
    assert.deepEqual(state.messages, []);
  });

  it('POST blank message returns 400 and does not append', async () => {
    const now = 3_000_000;
    const access = await accessContext({ now, ip: '198.51.100.53' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
    });

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-one',
        text: ' \n\t ',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore,
      nowFn: () => now + 100,
    });
    const body = await response.json();
    const state = await readChatState(chatStore);

    assert.equal(response.status, 400);
    assert.equal(body.detail, 'chat_text_required');
    assert.deepEqual(state.messages, []);
  });

  it('storage failures return route-level non-200 responses while missing state is empty', async () => {
    const now = 3_500_000;
    const access = await accessContext({ now, ip: '198.51.100.54' });
    const presenceStore = new MemoryPresenceStore();

    const missingResponse = await handleChatRequest(new Request('https://site.test/api/chat', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      chatStore: new MemoryPresenceStore(),
      nowFn: () => now,
    });
    const missingBody = await missingResponse.json();

    const readFailureResponse = await handleChatRequest(new Request('https://site.test/api/chat', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      chatStore: new FailingReadStore(),
      nowFn: () => now,
    });
    const readFailureBody = await readFailureResponse.json();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
    });
    const writeFailureResponse = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-one',
        text: 'cannot write this',
      }),
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore: new FailingWriteStore(),
      nowFn: () => now + 100,
    });
    const writeFailureBody = await writeFailureResponse.json();

    assert.equal(missingResponse.status, 200);
    assert.deepEqual(missingBody.messages, []);
    assert.equal(readFailureResponse.status, 503);
    assert.equal(readFailureBody.detail, 'blob_read_failed');
    assert.equal(writeFailureResponse.status, 503);
    assert.equal(writeFailureBody.detail, 'blob_write_failed');
  });

  it('storage errors do not leak arbitrary IP-like exception messages', async () => {
    const now = 3_750_000;
    const access = await accessContext({ now, ip: '198.51.100.56' });

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      chatStore: new IpLeakReadStore(),
      nowFn: () => now,
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.detail, 'chat_failed');
  });
});

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
  CHAT_MAX_MESSAGES,
  CHAT_RATE_LIMIT_BAN_MS,
  CHAT_RATE_LIMIT_MAX_MESSAGES,
  CHAT_RATE_LIMIT_MAX_WARNINGS,
  CHAT_RATE_LIMIT_WINDOW_MS,
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

class IpLeakPresenceStore extends MemoryPresenceStore {
  async list() {
    throw new Error('198.51.100.99');
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

  it('appendChatMessage keeps only the latest 10 messages and public snapshot omits private fields', async () => {
    const store = new MemoryPresenceStore();
    const identity = {
      clientId: 'client-one',
      sessionId: 'secret-session',
      ipKey: 'ip:203.0.113.7',
      handle: 'Alice',
      avatar: '/avatars/alice.png',
    };

    for (let index = 1; index <= 55; index += 1) {
      await appendChatMessage(store, {
        ...identity,
        sessionId: `secret-session-${index}`,
      }, ` message ${index} `, 10_000 + index, `message-${index}`);
    }

    const state = await readChatState(store);
    const snapshot = publicChatSnapshot(state, 20_000);
    const serialized = JSON.stringify(snapshot);

    assert.equal(state.messages.length, CHAT_MAX_MESSAGES);
    assert.equal(state.messages[0].id, 'message-46');
    assert.equal(state.messages.at(-1).id, 'message-55');
    assert.deepEqual(Object.keys(snapshot.messages[0]).sort(), [
      'avatar',
      'clientId',
      'createdAt',
      'handle',
      'id',
      'text',
    ]);
    assert.equal(snapshot.messages.length, CHAT_MAX_MESSAGES);
    assert.equal(snapshot.messages[0].text, 'message 46');
    assert.equal(serialized.includes('secret-session'), false);
    assert.equal(serialized.includes('ip:'), false);
    assert.equal(serialized.includes('accessToken'), false);
    assert.equal(serialized.includes('203.0.113.7'), false);
  });

  it('allows only two messages per session per minute before warnings and a temporary ban', async () => {
    const store = new MemoryPresenceStore();
    const now = 5_000_000;
    const identity = {
      clientId: 'client-one',
      sessionId: 'rate-session',
      ipKey: 'ip:203.0.113.7',
      handle: 'Alice',
      avatar: '/avatars/alice.png',
    };

    await appendChatMessage(store, identity, 'one', now, 'rate-one');
    await appendChatMessage(store, identity, 'two', now + 1_000, 'rate-two');

    for (let warning = 1; warning <= CHAT_RATE_LIMIT_MAX_WARNINGS; warning += 1) {
      await assert.rejects(
        appendChatMessage(store, identity, `blocked ${warning}`, now + 2_000 + warning, `rate-blocked-${warning}`),
        (error) => {
          assert.equal(error.code, 'chat_rate_limited');
          assert.equal(error.status, 429);
          assert.equal(error.warnings, warning);
          assert.equal(error.warningsRemaining, CHAT_RATE_LIMIT_MAX_WARNINGS - warning);
          assert.equal(error.retryAfterMs > 0, true);
          return true;
        },
      );
    }

    await assert.rejects(
      appendChatMessage(store, identity, 'banned now', now + 10_000, 'rate-banned'),
      (error) => {
        assert.equal(error.code, 'chat_banned');
        assert.equal(error.status, 429);
        assert.equal(error.bannedUntil, now + 10_000 + CHAT_RATE_LIMIT_BAN_MS);
        assert.equal(error.retryAfterMs, CHAT_RATE_LIMIT_BAN_MS);
        return true;
      },
    );

    await assert.rejects(
      appendChatMessage(store, identity, 'still banned', now + CHAT_RATE_LIMIT_WINDOW_MS + 1, 'rate-still-banned'),
      (error) => {
        assert.equal(error.code, 'chat_banned');
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs > CHAT_RATE_LIMIT_BAN_MS - CHAT_RATE_LIMIT_WINDOW_MS, true);
        return true;
      },
    );

    await appendChatMessage(store, identity, 'after ban', now + 10_000 + CHAT_RATE_LIMIT_BAN_MS + 1, 'rate-after-ban');
    const state = await readChatState(store);
    const prunedState = await readChatState(
      store,
      now + 10_000 + (CHAT_RATE_LIMIT_BAN_MS * 2) + CHAT_RATE_LIMIT_WINDOW_MS + 2,
    );

    assert.deepEqual(state.messages.map((message) => message.id), ['rate-one', 'rate-two', 'rate-after-ban']);
    assert.deepEqual(prunedState.rateLimits, {});
  });
});

describe('Netlify chat route', () => {
  it('GET requires access and returns messages', async () => {
    const now = 1_500_000;
    const access = await accessContext({ now, ip: '198.51.100.50' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();
    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
      handle: 'Nina',
      avatar: '/avatars/nina.png',
    });
    await appendChatMessage(chatStore, {
      clientId: 'client-one',
      sessionId: 'session-one',
      ipKey: 'ip:198.51.100.50',
      handle: 'Nina',
      avatar: '/avatars/nina.png',
    }, 'Hello from chat', now, 'message-one');

    const denied = await chatHandler(new Request('https://site.test/api/chat'));
    const deniedBody = await denied.json();
    const response = await handleChatRequest(new Request('https://site.test/api/chat?clientId=client-one&sessionId=session-one', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      presenceStore,
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

  it('GET rejects stale sessions before returning messages', async () => {
    let now = 1_700_000;
    const access = await accessContext({ now, ip: '198.51.100.56' });
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
    await appendChatMessage(chatStore, {
      clientId: 'client-one',
      sessionId: 'new-session',
      ipKey: 'ip:198.51.100.56',
      handle: 'New tab',
      avatar: '/avatars/new.png',
    }, 'hidden from stale tab', now, 'message-stale-get');

    const response = await handleChatRequest(new Request('https://site.test/api/chat?clientId=client-one&sessionId=old-session', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore,
      nowFn: () => now + 100,
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.detail, 'client_replaced');
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

  it('POST returns warnings and a temporary ban when a session exceeds chat rate limits', async () => {
    const now = 2_350_000;
    const access = await accessContext({ now, ip: '198.51.100.58' });
    const presenceStore = new MemoryPresenceStore();
    const chatStore = new MemoryPresenceStore();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
      handle: 'Rate Operator',
      avatar: '/avatars/rate.png',
    });

    async function postChat(text, at, id) {
      return handleChatRequest(new Request('https://site.test/api/chat', {
        method: 'POST',
        headers: { ...access.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-one',
          sessionId: 'session-one',
          text,
        }),
      }), {
        accessStore: access.store,
        presenceStore,
        chatStore,
        nowFn: () => at,
        id,
      });
    }

    assert.equal((await postChat('one', now + 1_000, 'route-rate-one')).status, 200);
    assert.equal((await postChat('two', now + 2_000, 'route-rate-two')).status, 200);

    const warningResponse = await postChat('three', now + 3_000, 'route-rate-three');
    const warningBody = await warningResponse.json();

    assert.equal(warningResponse.status, 429);
    assert.equal(warningBody.detail, 'chat_rate_limited');
    assert.equal(warningBody.warnings, 1);
    assert.equal(warningBody.warningsRemaining, CHAT_RATE_LIMIT_MAX_WARNINGS - 1);
    assert.equal(warningBody.limit, CHAT_RATE_LIMIT_MAX_MESSAGES);
    assert.equal(warningBody.windowMs, CHAT_RATE_LIMIT_WINDOW_MS);

    await postChat('four', now + 4_000, 'route-rate-four');
    await postChat('five', now + 5_000, 'route-rate-five');

    const bannedResponse = await postChat('six', now + 6_000, 'route-rate-six');
    const bannedBody = await bannedResponse.json();
    const state = await readChatState(chatStore);

    assert.equal(bannedResponse.status, 429);
    assert.equal(bannedBody.detail, 'chat_banned');
    assert.equal(bannedBody.retryAfterMs, CHAT_RATE_LIMIT_BAN_MS);
    assert.equal(bannedBody.bannedUntil, now + 6_000 + CHAT_RATE_LIMIT_BAN_MS);
    assert.equal(bannedResponse.headers.get('retry-after'), '600');
    assert.deepEqual(state.messages.map((message) => message.id), ['route-rate-one', 'route-rate-two']);
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

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
    });

    const missingResponse = await handleChatRequest(new Request('https://site.test/api/chat?clientId=client-one&sessionId=session-one', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore: new MemoryPresenceStore(),
      nowFn: () => now,
    });
    const missingBody = await missingResponse.json();

    const readFailureResponse = await handleChatRequest(new Request('https://site.test/api/chat?clientId=client-one&sessionId=session-one', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore: new FailingReadStore(),
      nowFn: () => now,
    });
    const readFailureBody = await readFailureResponse.json();

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
    const presenceStore = new MemoryPresenceStore();

    await activatePresence({
      store: presenceStore,
      headers: access.headers,
      now,
      clientId: 'client-one',
      sessionId: 'session-one',
    });

    const response = await handleChatRequest(new Request('https://site.test/api/chat?clientId=client-one&sessionId=session-one', {
      headers: access.headers,
    }), {
      accessStore: access.store,
      presenceStore,
      chatStore: new IpLeakReadStore(),
      nowFn: () => now,
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.detail, 'chat_failed');
  });

  it('presence lookup errors do not leak arbitrary IP-like exception messages or append', async () => {
    const now = 4_000_000;
    const access = await accessContext({ now, ip: '198.51.100.57' });
    const chatStore = new MemoryPresenceStore();

    const response = await handleChatRequest(new Request('https://site.test/api/chat', {
      method: 'POST',
      headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-one',
        sessionId: 'session-one',
        text: 'do not append',
      }),
    }), {
      accessStore: access.store,
      presenceStore: new IpLeakPresenceStore(),
      chatStore,
      nowFn: () => now,
    });
    const body = await response.json();
    const state = await readChatState(chatStore);

    assert.equal(response.status, 503);
    assert.equal(body.detail, 'chat_failed');
    assert.deepEqual(state.messages, []);
  });
});

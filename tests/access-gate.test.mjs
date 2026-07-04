import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleAccessTokenRequest } from '../netlify/functions/access-token.mjs';
import {
  ACCESS_CHALLENGE_TTL_MS,
  ACCESS_TOKEN_TTL_MS,
  MemoryAccessGateStore,
  assertAccessToken,
  assertRequestAccess,
  createAccessChallenge,
  issueAccessToken,
  publicChallenge,
  validateAccessAnswers,
} from '../netlify/functions/lib/access-gate-store.mjs';

function correctAnswers(challenge) {
  return Object.fromEntries(challenge.questions.map((question) => [question.id, question.correct]));
}

function headerRequest(path, headers = {}) {
  return new Request(`https://site.test${path}`, { headers });
}

describe('access gate', () => {
  it('creates a public three-question challenge without correct answers', async () => {
    const store = new MemoryAccessGateStore();
    const challenge = await createAccessChallenge(store, {
      now: 1_000,
      rng: () => 0.01,
    });
    const publicView = publicChallenge(challenge);

    assert.equal(publicView.challengeId, challenge.challengeId);
    assert.equal(publicView.questions.length, 3);
    assert.equal(new Set(publicView.questions.map((question) => question.id)).size, 3);
    assert.equal(Object.hasOwn(publicView.questions[0], 'correct'), false);
    assert.equal(Object.hasOwn(publicView.questions[0].answers[0], 'correct'), false);
    assert.deepEqual(publicView.questions[0].answers.map((answer) => answer.value), [false, true]);
  });

  it('requires all three answers before issuing a token', async () => {
    const store = new MemoryAccessGateStore();
    const challenge = await createAccessChallenge(store, { now: 2_000 });
    const answers = correctAnswers(challenge);
    delete answers[challenge.questions[0].id];

    assert.equal(validateAccessAnswers(challenge, answers), false);
    await assert.rejects(
      issueAccessToken(store, {
        challengeId: challenge.challengeId,
        answers,
        accessSessionId: 'browser-session',
        ipKey: 'ip:local',
        now: 2_100,
      }),
      { status: 401, code: 'access_answers_invalid' },
    );
  });

  it('rejects wrong answers', async () => {
    const store = new MemoryAccessGateStore();
    const challenge = await createAccessChallenge(store, { now: 3_000 });
    const answers = correctAnswers(challenge);
    answers[challenge.questions[0].id] = !challenge.questions[0].correct;

    await assert.rejects(
      issueAccessToken(store, {
        challengeId: challenge.challengeId,
        answers,
        accessSessionId: 'browser-session',
        ipKey: 'ip:local',
        now: 3_100,
      }),
      { status: 401, code: 'access_answers_invalid' },
    );
  });

  it('issues a token tied to accessSessionId with a TTL', async () => {
    const store = new MemoryAccessGateStore();
    const now = 4_000;
    const challenge = await createAccessChallenge(store, { now });
    const issued = await issueAccessToken(store, {
      challengeId: challenge.challengeId,
      answers: correctAnswers(challenge),
      accessSessionId: 'session-a',
      now: now + 100,
    });

    assert.equal(typeof issued.accessToken, 'string');
    assert.equal(issued.accessToken.length > 20, true);
    assert.equal(issued.expiresAt, now + 100 + ACCESS_TOKEN_TTL_MS);
    assert.equal(await store.get(`challenges/${challenge.challengeId}`, { type: 'json' }), null);
    await assert.doesNotReject(assertAccessToken(store, {
      accessToken: issued.accessToken,
      accessSessionId: 'session-a',
      now: now + 200,
    }));
  });

  it('rejects missing, mismatched, and expired tokens', async () => {
    const store = new MemoryAccessGateStore();
    const now = 5_000;
    const challenge = await createAccessChallenge(store, { now });
    const issued = await issueAccessToken(store, {
      challengeId: challenge.challengeId,
      answers: correctAnswers(challenge),
      accessSessionId: 'session-a',
      now,
    });

    await assert.rejects(
      assertAccessToken(store, { accessSessionId: 'session-a', now }),
      { status: 401, code: 'access_token_missing' },
    );
    await assert.rejects(
      assertAccessToken(store, {
        accessToken: issued.accessToken,
        accessSessionId: 'session-b',
        now,
      }),
      { status: 401, code: 'access_session_mismatch' },
    );
    await assert.doesNotReject(assertAccessToken(store, {
      accessToken: issued.accessToken,
      accessSessionId: 'session-a',
      ipKey: 'ip:changed-network',
      now,
    }));
    await assert.rejects(
      assertAccessToken(store, {
        accessToken: issued.accessToken,
        accessSessionId: 'session-a',
        now: now + ACCESS_TOKEN_TTL_MS + 1,
      }),
      { status: 401, code: 'access_token_expired' },
    );
  });

  it('rejects expired challenges', async () => {
    const store = new MemoryAccessGateStore();
    const now = 6_000;
    const challenge = await createAccessChallenge(store, { now });

    await assert.rejects(
      issueAccessToken(store, {
        challengeId: challenge.challengeId,
        answers: correctAnswers(challenge),
        accessSessionId: 'browser-session',
        ipKey: 'ip:local',
        now: now + ACCESS_CHALLENGE_TTL_MS + 1,
      }),
      { status: 401, code: 'access_challenge_expired' },
    );
  });

  it('rejects missing request tokens before opening the default blob store', async () => {
    await assert.rejects(
      assertRequestAccess(new Request('https://site.test/api/config')),
      { status: 401, code: 'access_token_missing' },
    );
  });

  it('GET creates a public challenge and POST issues token for correct answers', async () => {
    const store = new MemoryAccessGateStore();
    const getResponse = await handleAccessTokenRequest(headerRequest('/api/access-token', {
      'x-nf-client-connection-ip': '203.0.113.15',
    }), { store, now: () => 7_000 });
    const challenge = await getResponse.json();
    const stored = await store.get(`challenges/${challenge.challengeId}`, { type: 'json' });
    const answers = correctAnswers(stored);

    assert.equal(getResponse.status, 200);
    assert.equal(challenge.questions.length, 3);
    assert.equal(Object.hasOwn(challenge.questions[0], 'correct'), false);

    const postResponse = await handleAccessTokenRequest(new Request('https://site.test/api/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nf-client-connection-ip': '203.0.113.15',
      },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        answers,
        accessSessionId: 'session-route',
      }),
    }), { store, now: () => 7_100 });
    const token = await postResponse.json();

    assert.equal(postResponse.status, 200);
    assert.equal(typeof token.accessToken, 'string');
    assert.equal(token.expiresAt, 7_100 + ACCESS_TOKEN_TTL_MS);
  });
});

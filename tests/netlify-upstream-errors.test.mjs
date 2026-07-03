import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import stationsHandler from '../netlify/functions/stations.mjs';
import {
  MemoryAccessGateStore,
  createAccessChallenge,
  issueAccessToken,
} from '../netlify/functions/lib/access-gate-store.mjs';

function correctAnswers(challenge) {
  return Object.fromEntries(challenge.questions.map((question) => [question.id, question.correct]));
}

async function accessHeaders() {
  const store = new MemoryAccessGateStore();
  const challenge = await createAccessChallenge(store);
  const accessSessionId = `test-session-${crypto.randomUUID()}`;
  const { accessToken } = await issueAccessToken(store, {
    challengeId: challenge.challengeId,
    answers: correctAnswers(challenge),
    accessSessionId,
    ipKey: 'ip:198.51.100.20',
  });
  return {
    store,
    headers: {
      'x-access-token': accessToken,
      'x-access-session': accessSessionId,
      'x-nf-client-connection-ip': '198.51.100.20',
    },
  };
}

describe('Netlify upstream error responses', () => {
  it('returns JSON 502 when GdeBenz cannot be reached', async () => {
    const access = await accessHeaders();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    try {
      const response = await stationsHandler(new Request(
        'http://localhost/api/stations?lat=55.7520&lon=37.6178&radius=20',
        { method: 'GET', headers: access.headers },
      ), access.store);
      const body = await response.json();

      assert.equal(response.status, 502);
      assert.match(body.detail, /Could not reach GdeBenz/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

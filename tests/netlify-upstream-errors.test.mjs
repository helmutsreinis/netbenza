import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import stationsHandler from '../netlify/functions/stations.mjs';

describe('Netlify upstream error responses', () => {
  it('returns JSON 502 when GdeBenz cannot be reached', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    try {
      const response = await stationsHandler(new Request(
        'http://localhost/api/stations?lat=55.7520&lon=37.6178&radius=20',
        { method: 'GET' },
      ));
      const body = await response.json();

      assert.equal(response.status, 502);
      assert.match(body.detail, /Could not reach GdeBenz/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import configHandler from '../netlify/functions/config.mjs';
import stationIdsHandler from '../netlify/functions/station-ids.mjs';
import stationsHandler from '../netlify/functions/stations.mjs';
import voteHandler from '../netlify/functions/vote.mjs';

const benzinStationsPayload = {
  stations: [
    {
      id: 123,
      name: 'Benzin One',
      brand: 'Brand A',
      lat: 55.75,
      lng: 37.62,
      address: 'One Street',
      source: 'osm',
      status: 'available',
      lastReportAt: 1760000000000,
      fuelTypes: ['ai95', 'gas'],
    },
    {
      id: 456,
      name: 'Benzin Two',
      brand: 'Brand B',
      lat: 55.76,
      lng: 37.63,
      address: 'Two Street',
      source: 'osm',
      status: 'limited',
      lastReportAt: 1760000005000,
      fuelTypes: ['ai92'],
    },
  ],
};

function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

describe('Netlify Benzin service routing', () => {
  it('returns Benzin-specific config for source=benzin', async () => {
    const response = await configHandler(new Request(
      'http://localhost/api/config?source=benzin',
      { method: 'GET' },
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.fuel_grades, ['92', '95', '98', '100', 'ДТ', 'ГАЗ']);
    assert.deepEqual(body.statuses.map(status => status.value), ['available', 'limited', 'none']);
  });

  it('lists Benzin stations through map.benzin-status.tech without touching GdeBenz', async () => {
    const requestedUrls = [];

    await withMockFetch(async (url) => {
      requestedUrls.push(String(url));
      assert.match(String(url), /^https:\/\/map\.benzin-status\.tech\/api\/stations/);
      return new Response(JSON.stringify(benzinStationsPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const response = await stationsHandler(new Request(
        'http://localhost/api/stations?source=benzin&lat=55.75&lon=37.62&limit=1',
        { method: 'GET' },
      ));
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.center.radius, 7);
      assert.equal(body.total, 2);
      assert.equal(body.filtered_total, 2);
      assert.equal(body.stations.length, 1);
      assert.equal(body.stations[0].osm_id, '123');
      assert.equal(body.stations[0].status_label, 'Fuel Available');
      assert.deepEqual(body.stations[0].fuel_list, ['95', 'ГАЗ']);
      assert.equal(requestedUrls.length, 1);
    });
  });

  it('returns Benzin station ids from the Netlify ids route', async () => {
    await withMockFetch(async () => new Response(JSON.stringify(benzinStationsPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), async () => {
      const response = await stationIdsHandler(new Request(
        'http://localhost/api/stations/ids?source=benzin&lat=55.75&lon=37.62&status=available',
        { method: 'GET' },
      ));
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.ids, ['123']);
      assert.equal(body.total, 1);
    });
  });

  it('submits Benzin reports from the Netlify vote route', async () => {
    const postedBodies = [];

    await withMockFetch(async (url, options = {}) => {
      assert.equal(String(url), 'https://map.benzin-status.tech/api/reports');
      postedBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const response = await voteHandler(new Request('http://localhost/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          source: 'benzin',
          osm_ids: ['123'],
          vote_status: 'available',
        }),
      }));
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(postedBodies, [{
        station_id: 123,
        status: 'available',
        fuel_types: [],
        prices: {},
      }]);
      assert.deepEqual(body, [{
        osm_id: '123',
        name: 'Station #123',
        success: true,
        reason: '',
      }]);
    });
  });
});

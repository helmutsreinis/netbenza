import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterStations,
  parseStation,
  stationOut,
  buildPagedStationResponse,
} from '../netlify/functions/lib/gdebenz-client.mjs';

describe('gdebenz station helpers', () => {
  const rawStations = [
    {
      osm_id: 101,
      name: '',
      brand: 'Lukoil',
      addr: 'First road',
      lat: '55.1',
      lon: '37.2',
      status: 'yes',
      fuels_now: '92, 95',
      confirmations: '3',
      distance_km: '1.25',
    },
    {
      osm_id: 102,
      name: 'Other',
      brand: 'Shell',
      addr: 'Second road',
      lat: 55.2,
      lon: 37.3,
      status: 'no',
      fuels_now: 'DT',
      confirmations: 0,
      distance_km: 2,
    },
  ];

  it('parses station defaults and exposes fuel list', () => {
    const parsed = parseStation(rawStations[0]);

    assert.equal(parsed.osm_id, '101');
    assert.equal(parsed.name, 'Lukoil');
    assert.deepEqual(parsed.fuel_list, ['92', '95']);
    assert.equal(parsed.status_label, 'Fuel Available');
    assert.equal(parsed.confirmations, 3);
  });

  it('filters stations by status, fuel, and brand', () => {
    const stations = rawStations.map(parseStation);
    const filtered = filterStations(stations, {
      fuelTypes: ['95'],
      statuses: ['yes'],
      brand: 'lukoil',
    });

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].osm_id, '101');
  });

  it('builds paged response in the current frontend shape', () => {
    const stations = rawStations.map(parseStation);
    const response = buildPagedStationResponse({
      stations,
      filtered: stations,
      summary: { yes: 1, no: 1 },
      center: { lat: 55.1, lon: 37.2, radius: 20 },
      offset: 1,
      limit: 1,
    });

    assert.equal(response.total, 2);
    assert.equal(response.filtered_total, 2);
    assert.equal(response.page, 2);
    assert.equal(response.pages, 2);
    assert.equal(response.stations.length, 1);
    assert.deepEqual(Object.keys(stationOut(stations[0])).sort(), [
      'addr',
      'brand',
      'confirmations',
      'distance_km',
      'fuel_list',
      'fuels_now',
      'last_at',
      'lat',
      'lon',
      'name',
      'osm_id',
      'status',
      'status_label',
    ].sort());
  });
});

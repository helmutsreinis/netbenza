import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

function loadFrontendHarness() {
  const dom = new JSDOM(`
    <!doctype html>
    <button id="vote-selected-btn">Vote Selected (<span id="vote-sel-count">0</span>)</button>
    <button id="vote-btn">Vote ALL (<span id="vote-all-count">0</span> filtered)</button>
    <select id="vote-status"><option value=""></option><option value="yes">yes</option></select>
    <div id="stats-summary"></div>
    <div id="stats-selected"></div>
    <button id="service-switch" hidden>Services</button>
    <div id="station-list"></div>
    <div id="stats-bar"></div>
    <div id="pagination"></div>
    <div id="pagination-bot"></div>
    <div id="vote-panel"></div>
    <div id="results-area"></div>
    <aside id="results-map-panel" hidden>
      <div id="current-page-map"></div>
    </aside>
    <div id="fuel-chips"></div>
    <div id="status-chips"></div>
    <select id="brand-filter"></select>
    <section id="service-picker" hidden>
      <button id="service-gdebenz-card" data-service="gdebenz">GdeBenz</button>
      <button id="service-benzin-card" data-service="benzin">Benzin</button>
    </section>
    <section id="gdebenz-service" hidden></section>
  `, { url: 'http://localhost/' });
  const configResponse = {
    fuel_grades: ['92', '95'],
    statuses: [{ value: 'yes', label: 'Yes', color: 'green' }],
    cities: [],
    brands: [],
  };
  const source = readFileSync('gdebenz_ui/static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    crypto,
    document: dom.window.document,
    fetch: async () => ({ ok: true, json: async () => configResponse }),
    Headers,
    localStorage: dom.window.localStorage,
    setInterval,
    setTimeout,
    URLSearchParams,
    window: dom.window,
  });

  vm.runInContext(source, context);
  return { context, dom };
}

describe('frontend DOM updates', () => {
  it('keeps split vote counters after updating vote button state', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.totalFiltered = 12;
      state.allSelected.add('one');
      document.getElementById('vote-status').value = 'yes';
      updateSelectedCount();
      updateVoteBtn();
      state.allSelected.add('two');
      updateSelectedCount();
    `, context);

    assert.equal(dom.window.document.getElementById('vote-sel-count')?.textContent, '2');
    assert.equal(dom.window.document.getElementById('vote-all-count')?.textContent, '12');
    assert.match(dom.window.document.getElementById('vote-btn')?.textContent || '', /12 filtered/);
  });

  it('renders Potemkin video standby when GdeBenz cannot be reached', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderSearchFailure(new Error('Could not reach GdeBenz. Please try again in a moment. (fetch failed)'));
    `, context);

    const stationList = dom.window.document.getElementById('station-list');
    assert.match(stationList?.textContent || '', /Please stand by and enjoy some Potemkin nostalgia/);
    assert.match(stationList?.textContent || '', /Live station data is unavailable for a moment/);
    assert.doesNotMatch(stationList?.textContent || '', /fetch failed|Could not reach GdeBenz/);
    assert.equal(stationList?.querySelectorAll('video').length, 1);
    assert.ok(stationList?.querySelector('video[src^="/video-reels/"]'));
    assert.equal(stationList?.querySelector('video')?.hasAttribute('controls'), true);
    assert.ok(stationList?.querySelector('.potemkin-quote'));
    assert.equal(dom.window.document.getElementById('vote-panel')?.style.display, 'none');
  });

  it('plays Potemkin videos one by one as each reel ends', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderSearchFailure(new Error('Could not reach GdeBenz. Please try again in a moment. (fetch failed)'));
    `, context);

    const video = dom.window.document.getElementById('potemkin-video');
    const firstSrc = video?.getAttribute('src') || '';
    assert.match(firstSrc, /\/video-reels\/17798970387630865084\.mp4$/);
    assert.equal(video?.hasAttribute('loop'), false);

    video?.dispatchEvent(new dom.window.Event('ended'));

    assert.match(video?.getAttribute('src') || '', /\/video-reels\/7OZ3wCRuoxyton22\.mp4$/);
    assert.match(dom.window.document.querySelector('.potemkin-video-count')?.textContent || '', /2 \/ 11/);
  });

  it('defaults Potemkin reels to 10 percent volume while staying muted for autoplay', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderSearchFailure(new Error('Could not reach GdeBenz. Please try again in a moment. (fetch failed)'));
    `, context);

    const video = dom.window.document.getElementById('potemkin-video');
    assert.equal(video?.muted, true);
    assert.equal(video?.volume, 0.1);
  });

  it('shows a current page map panel fallback with rendered station results', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.totalFiltered = 2;
      renderStations({
        center: { lat: 55.75, lon: 37.62, radius: 7 },
        total: 2,
        summary: { yes: 1, queue: 1 },
        stations: [
          {
            osm_id: '101',
            name: 'First Station',
            brand: 'Brand A',
            addr: 'One Street',
            lat: 55.75,
            lon: 37.62,
            status: 'yes',
            status_label: 'Fuel Available',
            fuel_list: ['95'],
            confirmations: 2,
            distance_km: 1.2,
          },
          {
            osm_id: '102',
            name: 'Second Station',
            brand: 'Brand B',
            addr: 'Two Street',
            lat: 55.76,
            lon: 37.63,
            status: 'queue',
            status_label: 'Queue',
            fuel_list: [],
            confirmations: 0,
            distance_km: 2.4,
          },
        ],
      });
    `, context);

    assert.equal(dom.window.document.querySelectorAll('.station-card').length, 2);
    assert.equal(dom.window.document.getElementById('results-map-panel')?.hidden, false);
    assert.match(dom.window.document.getElementById('current-page-map')?.textContent || '', /Map unavailable/);
  });

  it('uses red markers for current page map pins', () => {
    const { context } = loadFrontendHarness();
    const markerIcons = [];

    context.window.L = {
      divIcon(options) {
        markerIcons.push(options);
        return options;
      },
      marker() {
        return {
          addTo() { return this; },
          bindPopup() { return this; },
          on() { return this; },
          remove() {},
        };
      },
      map() {
        return {
          setView() { return this; },
          invalidateSize() {},
          fitBounds() {},
          remove() {},
        };
      },
      tileLayer() {
        return { addTo() { return this; } };
      },
      latLngBounds() {
        return { getCenter() { return { lat: 55.75, lng: 37.62 }; } };
      },
    };

    vm.runInContext(`
      state.totalFiltered = 1;
      renderStations({
        center: { lat: 55.75, lon: 37.62, radius: 7 },
        total: 1,
        summary: { yes: 1 },
        stations: [
          {
            osm_id: '101',
            name: 'First Station',
            brand: 'Brand A',
            addr: 'One Street',
            lat: 55.75,
            lon: 37.62,
            status: 'yes',
            status_label: 'Fuel Available',
            fuel_list: ['95'],
            confirmations: 1,
            distance_km: 1.2,
          },
        ],
      });
    `, context);

    assert.equal(markerIcons.length, 1);
    assert.match(markerIcons[0].html, /background:#FF4D5A/);
  });

  it('keeps ordinary search errors in the compact warning state', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderSearchFailure(new Error('Choose a city or coordinates.'));
    `, context);

    const stationList = dom.window.document.getElementById('station-list');
    assert.match(stationList?.textContent || '', /Choose a city or coordinates/);
    assert.equal(stationList?.querySelector('.potemkin-standby'), null);
  });

  it('shows service selection after identity is ready and keeps GdeBenz hidden', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.identity = { clientId: 'c1', handle: 'Operator', avatar: '/avatars/a.png' };
      showServicePicker();
    `, context);

    assert.equal(dom.window.document.getElementById('service-picker')?.hidden, false);
    assert.equal(dom.window.document.getElementById('gdebenz-service')?.hidden, true);
    assert.equal(dom.window.document.body.classList.contains('service-picker-open'), true);
  });

  it('opens GdeBenz only after choosing its service card', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.identity = { clientId: 'c1', handle: 'Operator', avatar: '/avatars/a.png' };
      showServicePicker();
      initServiceLauncher();
      document.getElementById('service-gdebenz-card').click();
    `, context);

    assert.equal(dom.window.document.getElementById('service-picker')?.hidden, true);
    assert.equal(dom.window.document.getElementById('gdebenz-service')?.hidden, false);
    assert.equal(dom.window.document.body.classList.contains('service-active-gdebenz'), true);
    assert.equal(vm.runInContext('state.activeService', context), 'gdebenz');
  });

  it('can return to service selection after opening GdeBenz', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.identity = { clientId: 'c1', handle: 'Operator', avatar: '/avatars/a.png' };
      initServiceLauncher();
      activateService('gdebenz');
      document.getElementById('service-switch').click();
    `, context);

    assert.equal(dom.window.document.getElementById('service-switch')?.hidden, false);
    assert.equal(dom.window.document.getElementById('service-picker')?.hidden, false);
    assert.equal(dom.window.document.getElementById('gdebenz-service')?.hidden, true);
    assert.equal(vm.runInContext('state.activeService', context), null);
    assert.equal(vm.runInContext('state.identity.handle', context), 'Operator');
  });
});

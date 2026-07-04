import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

function loadFrontendHarness(options = {}) {
  const fetchLog = [];
  const defaultConfigResponse = {
    fuel_grades: ['92', '95'],
    statuses: [{ value: 'yes', label: 'Yes', color: 'green' }],
    cities: [],
    brands: [],
  };
  const fetchImpl = options.fetch || (async (url, fetchOptions = {}) => {
    fetchLog.push({ url: String(url), options: fetchOptions });
    return { ok: true, json: async () => options.configResponse || defaultConfigResponse };
  });
  const dom = new JSDOM(`
    <!doctype html>
    <div id="access-gate-modal" hidden>
      <form id="access-gate-form">
        <div id="access-question-list"></div>
        <div id="access-gate-error" hidden></div>
        <button id="access-submit" type="submit">Enter</button>
      </form>
    </div>
    <div id="identity-modal" hidden>
      <form id="identity-form">
        <input id="identity-handle">
        <div id="avatar-grid"></div>
      </form>
    </div>
    <button id="identity-reset" type="button"></button>
    <span id="fp-indicator"></span>
    <div id="online-users"></div>
    <div id="toast"></div>
    <button id="vote-selected-btn">Vote Selected (<span id="vote-sel-count">0</span>)</button>
    <button id="vote-btn">Vote ALL (<span id="vote-all-count">0</span> filtered)</button>
    <select id="vote-status"><option value=""></option><option value="yes">yes</option></select>
    <select id="comment-mode"><option value="custom">custom</option><option value="positive">positive</option><option value="negative">negative</option></select>
    <textarea id="vote-text"></textarea>
    <input id="vote-onsite" type="checkbox">
    <input id="lat-input">
    <input id="lon-input">
    <input id="city-input">
    <div id="progress-bar" hidden>
      <div id="progress-fill"></div>
      <span id="progress-text"></span>
      <span id="progress-pct"></span>
      <span id="progress-current"></span>
      <span id="progress-badge"></span>
    </div>
    <div id="stats-summary"></div>
    <div id="stats-selected"></div>
    <section id="collaboration-panel">
      <span id="vote-queue-count"></span>
      <div id="vote-queue-list"></div>
      <span id="chat-count"></span>
      <div id="chat-messages"></div>
      <form id="chat-form">
        <input id="chat-input">
        <button id="chat-send" type="submit">Send</button>
      </form>
    </section>
    <div id="session-replaced-modal" hidden>
      <div id="session-replaced-reason"></div>
    </div>
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
  const source = readFileSync('gdebenz_ui/static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    crypto,
    document: dom.window.document,
    fetch: fetchImpl,
    Headers,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    setInterval,
    setTimeout,
    URLSearchParams,
    window: dom.window,
  });

  vm.runInContext(source, context);
  return { context, dom, fetchLog };
}

describe('frontend DOM updates', () => {
  it('renders server-provided access questions and answer order', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.accessChallenge = {
        challengeId: 'challenge-1',
        questions: [
          {
            id: 'crimea',
            prompt: 'Is Crimea part of Ukraine?',
            answers: [{ label: 'No', value: false }, { label: 'Yes', value: true }]
          },
          {
            id: 'riga',
            prompt: 'Is Riga the capital of Latvia?',
            answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }]
          },
          {
            id: 'baltic',
            prompt: 'Does Ukraine border the Baltic Sea?',
            answers: [{ label: 'No', value: false }, { label: 'Yes', value: true }]
          }
        ]
      };
      renderAccessGate();
    `, context);

    const questions = [...dom.window.document.querySelectorAll('.access-question')];
    assert.equal(questions.length, 3);
    assert.match(questions[0].textContent || '', /Is Crimea part of Ukraine/);
    assert.deepEqual(
      [...questions[0].querySelectorAll('input')].map((input) => input.value),
      ['false', 'true'],
    );
    assert.equal(dom.window.document.getElementById('access-gate-modal')?.hidden, false);
  });

  it('stores access token and session id after a correct questionnaire submit', async () => {
    const posts = [];
    const challenge = {
      challengeId: 'challenge-ok',
      questions: [
        { id: 'crimea', prompt: 'Is Crimea part of Ukraine?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
        { id: 'riga', prompt: 'Is Riga the capital of Latvia?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
        { id: 'baltic', prompt: 'Does Ukraine border the Baltic Sea?', answers: [{ label: 'No', value: false }, { label: 'Yes', value: true }] },
      ],
    };
    const { context, dom } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        if (String(url) === '/api/access-token' && options.method === 'POST') {
          posts.push(JSON.parse(options.body));
          return { ok: true, json: async () => ({ accessToken: 'access-token-ok', expiresAt: 123 }) };
        }
        if (String(url) === '/api/access-token') return { ok: true, json: async () => challenge };
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    await vm.runInContext('initAccessGate()', context);
    dom.window.document.querySelector('input[name="access-crimea"][value="true"]').checked = true;
    dom.window.document.querySelector('input[name="access-riga"][value="true"]').checked = true;
    dom.window.document.querySelector('input[name="access-baltic"][value="false"]').checked = true;
    await vm.runInContext('submitAccessGate(new window.Event("submit"))', context);

    assert.equal(dom.window.sessionStorage.getItem('gdebenz.accessToken.v1'), 'access-token-ok');
    assert.equal(Boolean(dom.window.sessionStorage.getItem('gdebenz.accessSession.v1')), true);
    assert.equal(dom.window.document.getElementById('access-gate-modal')?.hidden, true);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].answers, { crimea: true, riga: true, baltic: false });
    assert.equal(posts[0].challengeId, 'challenge-ok');
    assert.equal(posts[0].accessSessionId, dom.window.sessionStorage.getItem('gdebenz.accessSession.v1'));
  });

  it('shows retry state and fetches a fresh challenge after an incorrect submit', async () => {
    let challengeCount = 0;
    const challenges = [
      {
        challengeId: 'challenge-bad',
        questions: [
          { id: 'latvia-sea', prompt: 'Does Latvia border the Baltic Sea?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
          { id: 'riga', prompt: 'Is Riga the capital of Latvia?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
          { id: 'crimea', prompt: 'Is Crimea part of Ukraine?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
        ],
      },
      {
        challengeId: 'challenge-retry',
        questions: [
          { id: 'crimea', prompt: 'Is Crimea part of Ukraine?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
          { id: 'riga', prompt: 'Is Riga the capital of Latvia?', answers: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
          { id: 'baltic', prompt: 'Does Ukraine border the Baltic Sea?', answers: [{ label: 'No', value: false }, { label: 'Yes', value: true }] },
        ],
      },
    ];
    const { context, dom } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        if (String(url) === '/api/access-token' && options.method === 'POST') {
          return { ok: false, status: 401, json: async () => ({ detail: 'access_answers_invalid' }) };
        }
        if (String(url) === '/api/access-token') {
          return { ok: true, json: async () => challenges[challengeCount++] };
        }
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    await vm.runInContext('initAccessGate()', context);
    dom.window.document.querySelector('input[name="access-latvia-sea"][value="true"]').checked = true;
    dom.window.document.querySelector('input[name="access-riga"][value="true"]').checked = true;
    dom.window.document.querySelector('input[name="access-crimea"][value="true"]').checked = true;
    await vm.runInContext('submitAccessGate(new window.Event("submit"))', context);

    assert.equal(dom.window.document.getElementById('access-gate-modal')?.hidden, false);
    assert.equal(dom.window.document.getElementById('access-gate-error')?.hidden, false);
    assert.match(dom.window.document.getElementById('access-gate-error')?.textContent || '', /Try again/i);
    assert.match(dom.window.document.getElementById('access-question-list')?.textContent || '', /Does Ukraine border the Baltic Sea/);
    assert.equal(challengeCount, 2);
  });

  it('adds access token and session headers to API calls', async () => {
    const { context, dom, fetchLog } = loadFrontendHarness();
    dom.window.sessionStorage.setItem('gdebenz.accessToken.v1', 'token-123');
    dom.window.sessionStorage.setItem('gdebenz.accessSession.v1', 'session-123');

    await vm.runInContext('api("/api/config")', context);

    assert.equal(fetchLog[0].options.headers['x-access-token'], 'token-123');
    assert.equal(fetchLog[0].options.headers['x-access-session'], 'session-123');
  });

  it('creates a page-load presence session and includes it in presence POSTs', async () => {
    const { context, dom, fetchLog } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        fetchLog.push({ url: String(url), options });
        if (String(url) === '/api/presence') return { ok: true, json: async () => ({ users: [] }) };
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    try {
      vm.runInContext(`
        state.pendingAvatar = '/avatars/a.png';
        document.getElementById('identity-handle').value = 'Operator';
        saveIdentity(new window.Event('submit'));
      `, context);
      await vm.runInContext('postPresence()', context);

      const identity = vm.runInContext('state.identity', context);
      const presencePost = fetchLog
        .filter((entry) => entry.url === '/api/presence' && entry.options.method === 'POST')
        .at(-1);
      const payload = JSON.parse(presencePost?.options.body || '{}');

      assert.equal(Boolean(identity.sessionId), true);
      assert.equal(Number.isFinite(identity.sessionStartedAt), true);
      assert.equal(payload.clientId, identity.clientId);
      assert.equal(payload.sessionId, identity.sessionId);
      assert.equal(payload.sessionStartedAt, identity.sessionStartedAt);
    } finally {
      vm.runInContext('stopPresenceTimers()', context);
    }
  });

  it('waits for the initial presence POST before polling the new session', async () => {
    let resolvePresencePost;
    const presencePostResponse = new Promise((resolve) => {
      resolvePresencePost = () => resolve({ ok: true, json: async () => ({ users: [], session: { active: true } }) });
    });
    const presenceGets = [];
    const { context } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        const path = String(url);
        if (path === '/api/presence' && options.method === 'POST') return presencePostResponse;
        if (path.startsWith('/api/presence?')) {
          presenceGets.push({ url: path, options });
          return {
            ok: true,
            json: async () => ({ users: [], session: { active: false, reason: 'client_replaced' } }),
          };
        }
        if (path.startsWith('/api/vote/queue')) return { ok: true, json: async () => ({ entries: [], processing: null }) };
        if (path.startsWith('/api/chat')) return { ok: true, json: async () => ({ messages: [] }) };
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    try {
      vm.runInContext(`
        state.identity = {
          clientId: 'race-client',
          fingerprint: 'race-fingerprint',
          handle: 'Race Client',
          avatar: '/avatars/a.png',
          sessionId: 'race-session-new',
          sessionStartedAt: 12345
        };
        startPresence();
      `, context);

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(presenceGets.length, 0);

      resolvePresencePost();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(presenceGets.length, 1);
    } finally {
      vm.runInContext('stopPresenceTimers()', context);
    }
  });

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

  it('renders public queue entries and processing state without private fields', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderVoteQueue({
        entries: [{
          id: 'entry-one',
          clientId: 'client-visible-but-not-needed',
          handle: '<Queue Operator>',
          avatar: '/avatars/queue.png',
          source: 'benzin',
          stationId: 'station-101',
          status: 'available',
          position: 1,
          ipKey: 'ip:198.51.100.10',
          sessionId: 'secret-session-one',
          text: 'private text',
          fingerprint: 'private-fingerprint',
          privateVote: { vlat: 12.34, vlon: 56.78 }
        }],
        processing: {
          id: 'entry-two',
          handle: 'Processing User',
          avatar: '/avatars/processing.png',
          source: 'gdebenz',
          stationId: 'station-202',
          status: 'queue',
          state: 'processing',
          position: 0,
          ipKey: 'ip:198.51.100.11',
          sessionId: 'secret-session-two',
          rawIp: '198.51.100.11',
          coords: [12.34, 56.78]
        }
      });
    `, context);

    const list = dom.window.document.getElementById('vote-queue-list');
    const rendered = list?.textContent || '';
    const html = list?.innerHTML || '';

    assert.match(rendered, /<Queue Operator>/);
    assert.match(rendered, /Processing User/);
    assert.match(rendered, /available/);
    assert.match(rendered, /benzin/);
    assert.match(rendered, /station-101/);
    assert.match(rendered, /#1/);
    assert.match(rendered, /Processing/);
    assert.doesNotMatch(html, /<Queue Operator>/);
    assert.doesNotMatch(html + rendered, /ip:198\.51\.100|secret-session|198\.51\.100\.11|private text|private-fingerprint|12\.34|56\.78/);
    assert.equal(dom.window.document.getElementById('vote-queue-count')?.textContent, '2');
  });

  it('does not create queue avatar event attributes from server-supplied URLs', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderVoteQueue({
        entries: [{
          id: 'entry-injection',
          handle: 'Queue Operator',
          avatar: '/avatars/x" onerror="alert(1)',
          source: 'benzin',
          stationId: 'station-101',
          status: 'available',
          position: 1
        }]
      });
    `, context);

    const list = dom.window.document.getElementById('vote-queue-list');
    assert.equal(list?.querySelector('[onerror]'), null);
    assert.doesNotMatch(list?.innerHTML || '', /onerror/i);
  });

  it('renders chat messages with escaped text', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderChatMessages([{
        id: 'message-one',
        handle: 'Nina',
        avatar: '/avatars/nina.png',
        text: '<img src=x onerror=alert(1)> hello',
        createdAt: 123
      }]);
    `, context);

    const messages = dom.window.document.getElementById('chat-messages');
    assert.match(messages?.textContent || '', /<img src=x onerror=alert\(1\)> hello/);
    assert.doesNotMatch(messages?.innerHTML || '', /<img src=x/i);
    assert.equal(dom.window.document.getElementById('chat-count')?.textContent, '1');
  });

  it('does not create chat avatar event attributes from server-supplied URLs', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      renderChatMessages([{
        id: 'message-injection',
        handle: 'Nina',
        avatar: '/avatars/x" onerror="alert(1)',
        text: 'hello chat',
        createdAt: 123
      }]);
    `, context);

    const messages = dom.window.document.getElementById('chat-messages');
    assert.equal(messages?.querySelector('[onerror]'), null);
    assert.doesNotMatch(messages?.innerHTML || '', /onerror/i);
  });

  it('blocks stale replaced sessions from presence payloads and stops timers', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.presenceHeartbeat = 1;
      state.presencePoll = 2;
      state.presencePushTimer = 3;
      state.voteQueuePoll = 4;
      state.chatPoll = 5;
      handlePresencePayload({
        users: [],
        session: { active: false, reason: 'client_replaced' }
      });
    `, context);

    assert.equal(vm.runInContext('state.sessionBlocked', context), true);
    assert.equal(vm.runInContext('state.presenceHeartbeat', context), null);
    assert.equal(vm.runInContext('state.presencePoll', context), null);
    assert.equal(vm.runInContext('state.presencePushTimer', context), null);
    assert.equal(vm.runInContext('state.voteQueuePoll', context), null);
    assert.equal(vm.runInContext('state.chatPoll', context), null);
    assert.equal(dom.window.document.getElementById('session-replaced-modal')?.hidden, false);
    assert.match(dom.window.document.getElementById('session-replaced-reason')?.textContent || '', /client_replaced/);
  });

  it('shuffles ids deterministically with an injected random source', () => {
    const { context } = loadFrontendHarness();

    const shuffled = vm.runInContext("shuffleIds(['1', '2', '3', '4'], () => 0)", context);

    assert.deepEqual([...shuffled], ['2', '3', '4', '1']);
  });

  it('builds vote payloads with active public identity and station fields', () => {
    const { context } = loadFrontendHarness();

    const payload = vm.runInContext(`
      state.identity = {
        clientId: 'client-build',
        sessionId: 'session-build',
        sessionStartedAt: 12345,
        fingerprint: 'fingerprint-build',
        handle: 'Build Operator',
        avatar: '/avatars/build.png'
      };
      state.source = 'benzin';
      document.getElementById('vote-onsite').checked = true;
      buildVotePayload({
        osmId: 'station-build',
        voteStatus: 'available',
        baseText: 'station text',
        city: 'Kyiv',
        lat: 50.45,
        lon: 30.52
      });
    `, context);

    assert.deepEqual([...payload.osm_ids], ['station-build']);
    assert.equal(payload.vote_status, 'available');
    assert.equal(payload.text, 'station text');
    assert.equal(payload.city, 'Kyiv');
    assert.equal(payload.lat, 50.45);
    assert.equal(payload.lon, 30.52);
    assert.equal(payload.on_site, true);
    assert.equal(payload.source, 'benzin');
    assert.equal(payload.fingerprint, 'fingerprint-build');
    assert.equal(payload.clientId, 'client-build');
    assert.equal(payload.sessionId, 'session-build');
    assert.equal(payload.handle, 'Build Operator');
    assert.equal(payload.avatar, '/avatars/build.png');
    assert.equal(Object.hasOwn(payload, 'sessionStartedAt'), false);
  });

  it('posts chat with the active session identity and clears input after success', async () => {
    const chatBodies = [];
    const { context, dom } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        if (String(url) === '/api/chat' && options.method === 'POST') {
          chatBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            json: async () => ({
              messages: [{
                id: 'message-ok',
                clientId: 'client-chat',
                handle: 'Chat Operator',
                avatar: '/avatars/chat.png',
                text: 'hello chat',
                createdAt: 10,
              }],
            }),
          };
        }
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    vm.runInContext(`
      state.identity = {
        clientId: 'client-chat',
        sessionId: 'session-chat',
        sessionStartedAt: 12345,
        fingerprint: 'fingerprint-chat',
        handle: 'Chat Operator',
        avatar: '/avatars/chat.png'
      };
      document.getElementById('chat-input').value = ' hello chat ';
    `, context);

    await vm.runInContext('sendChatMessage(new window.Event("submit"))', context);

    assert.equal(chatBodies.length, 1);
    assert.equal(chatBodies[0].clientId, 'client-chat');
    assert.equal(chatBodies[0].sessionId, 'session-chat');
    assert.equal(chatBodies[0].text, 'hello chat');
    assert.equal(dom.window.document.getElementById('chat-input')?.value, '');
    assert.match(dom.window.document.getElementById('chat-messages')?.textContent || '', /hello chat/);
  });

  it('polls chat with the active session identity in the query string', async () => {
    const chatUrls = [];
    const { context, dom } = loadFrontendHarness({
      fetch: async (url) => {
        if (String(url).startsWith('/api/chat?')) {
          chatUrls.push(String(url));
          return {
            ok: true,
            json: async () => ({
              messages: [{
                id: 'message-read',
                clientId: 'client-chat-read',
                handle: 'Chat Reader',
                avatar: '/avatars/read.png',
                text: 'read hello',
                createdAt: 10,
              }],
            }),
          };
        }
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    vm.runInContext(`
      state.identity = {
        clientId: 'client-chat-read',
        sessionId: 'session-chat-read',
        sessionStartedAt: 12345,
        fingerprint: 'fingerprint-chat-read',
        handle: 'Chat Reader',
        avatar: '/avatars/read.png'
      };
    `, context);

    await vm.runInContext('pollChat()', context);

    assert.equal(chatUrls.length, 1);
    const url = new URL(chatUrls[0], 'https://site.test');
    assert.equal(url.pathname, '/api/chat');
    assert.equal(url.searchParams.get('clientId'), 'client-chat-read');
    assert.equal(url.searchParams.get('sessionId'), 'session-chat-read');
    assert.equal(url.searchParams.has('handle'), false);
    assert.equal(url.searchParams.has('avatar'), false);
    assert.match(dom.window.document.getElementById('chat-messages')?.textContent || '', /read hello/);
  });

  it('uses shuffled ids and the vote payload helper in both vote loops', async () => {
    const voteBodies = [];
    const { context, dom } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        if (String(url).startsWith('/api/stations/ids')) {
          return { ok: true, json: async () => ({ ids: ['1', '2', '3', '4'], total: 4 }) };
        }
        if (String(url) === '/api/vote') {
          voteBodies.push(JSON.parse(options.body));
          return { ok: true, json: async () => ([{ osm_id: JSON.parse(options.body).osm_ids[0], success: true }]) };
        }
        if (String(url) === '/api/presence') return { ok: true, json: async () => ({ users: [], session: { active: true } }) };
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    try {
      vm.runInContext(`
        Math.random = () => 0;
        state.identity = {
          clientId: 'client-vote',
          sessionId: 'session-vote',
          sessionStartedAt: 12345,
          fingerprint: 'fingerprint-vote',
          handle: 'Vote Operator',
          avatar: '/avatars/vote.png'
        };
        state.searchParams = new URLSearchParams('source=gdebenz');
        state.totalFiltered = 4;
        state.source = 'gdebenz';
        document.getElementById('vote-status').value = 'yes';
        document.getElementById('comment-mode').value = 'custom';
        document.getElementById('vote-text').value = 'queued text';
      `, context);

      await vm.runInContext('doVote()', context);

      vm.runInContext(`
        document.getElementById('vote-status').value = 'yes';
        state.allSelected = new Set(['1', '2', '3', '4']);
      `, context);
      await vm.runInContext('doVoteSelected()', context);

      assert.deepEqual(voteBodies.slice(0, 4).map((body) => body.osm_ids[0]), ['2', '3', '4', '1']);
      assert.deepEqual(voteBodies.slice(4).map((body) => body.osm_ids[0]), ['2', '3', '4', '1']);
      assert.equal(voteBodies.every((body) => body.clientId === 'client-vote'), true);
      assert.equal(voteBodies.every((body) => body.sessionId === 'session-vote'), true);
      assert.equal(voteBodies.every((body) => body.vote_status === 'yes'), true);
      assert.equal(voteBodies.every((body) => body.text === 'queued text'), true);
    } finally {
      vm.runInContext('clearTimeout(state.idleTimer); stopPresenceTimers();', context);
      dom.window.close();
    }
  });

  it('includes active presence session identity in vote request payloads', async () => {
    const voteBodies = [];
    const { context, dom } = loadFrontendHarness({
      fetch: async (url, options = {}) => {
        if (String(url).startsWith('/api/stations/ids')) {
          return { ok: true, json: async () => ({ ids: ['201'], total: 1 }) };
        }
        if (String(url) === '/api/vote') {
          voteBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            json: async () => ([{ osm_id: voteBodies.length === 1 ? '201' : '301', success: true, reason: '' }]),
          };
        }
        if (String(url) === '/api/presence') return { ok: true, json: async () => ({ users: [] }) };
        return { ok: true, json: async () => ({ fuel_grades: [], statuses: [], cities: [], brands: [] }) };
      },
    });

    try {
      vm.runInContext(`
        state.identity = {
          clientId: 'client-front',
          sessionId: 'session-front',
          sessionStartedAt: 12345,
          fingerprint: 'fingerprint-front',
          handle: 'Frontend Operator',
          avatar: '/avatars/front.png'
        };
        state.source = 'benzin';
        state.searchParams = new URLSearchParams('source=benzin');
        state.totalFiltered = 1;
        document.getElementById('vote-status').value = 'yes';
        document.getElementById('comment-mode').value = 'custom';
        document.getElementById('vote-text').value = 'frontend note';
      `, context);

      await vm.runInContext('doVote()', context);

      vm.runInContext(`
        document.getElementById('vote-status').value = 'yes';
        state.allSelected.add('301');
      `, context);
      await vm.runInContext('doVoteSelected()', context);

      assert.equal(voteBodies.length, 2);
      assert.deepEqual(voteBodies.map((body) => body.clientId), ['client-front', 'client-front']);
      assert.deepEqual(voteBodies.map((body) => body.sessionId), ['session-front', 'session-front']);
      assert.deepEqual(voteBodies.map((body) => body.handle), ['Frontend Operator', 'Frontend Operator']);
      assert.deepEqual(voteBodies.map((body) => body.avatar), ['/avatars/front.png', '/avatars/front.png']);
    } finally {
      vm.runInContext('clearTimeout(state.idleTimer); stopPresenceTimers();', context);
      dom.window.close();
    }
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
    assert.match(markerIcons[0].html, /background:#7F1D1D/);
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

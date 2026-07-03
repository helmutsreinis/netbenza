/**
 * GdeBenz Bulk Voter — Frontend App
 */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const PAGE_SIZE = 20;
const IDENTITY_KEY = 'gdebenz.identity.v1';
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_POLL_MS = 4000;
const PRESENCE_PUSH_MIN_MS = 1500;
const ACTIVITY_IDLE_MS = 15000;
const POTEMKIN_STANDBY_MESSAGE = 'Live station data is unavailable for a moment. Try again shortly.';
const RESULT_MAP_PIN_COLOR = '#FF4D5A';
const POTEMKIN_VIDEO_FILES = [
  '17798970387630865084.mp4',
  '7OZ3wCRuoxyton22.mp4',
  'R0lZwrAFanF8A-uk.mp4',
  'SnapVid.Net_14jw99baAbB25MUP_394p.mp4',
  'SnapVid.Net_EiU09O70Et952VPD_270p.mp4',
  'SnapVid.Net_ldH8N8KJfstXFVvb_568p.mp4',
  'SnapVid.Net_olBU0Z8Uv0ds8rGo_568p.mp4',
  'SnapVid.Net_T7g6os-tR-S0Bzwr_568p.mp4',
  'SnapVid.Net_wZIdR1EEoo-f2FgI_568p.mp4',
  'SnapVid.Net_y29hMZ6O4EUBvaPO_568p.mp4',
  'ssstwitter.com_1732014702019.mp4',
];
const POTEMKIN_QUOTES = [
  'No gasoline means every commute is now a wellness journey.',
  'A fuel queue is just a loyalty program with fewer rewards.',
  'Shortage? Please call it patriotic demand management.',
  'The empty pump is a minimalist infrastructure statement.',
  'Walking builds character. So does waiting five hours for 92.',
  'Congratulations: national carbon targets achieved by accident.',
  'Traffic is down because optimism cannot run on fumes.',
  'Premium silence at every station, now included free.',
];

const FALLBACK_AVATAR_FILES = [
  '2024-08-22 16_34_08-Vatatastan on X_ _Visas bildes uzņemtas .png',
  'G61WnILWUAANFli.png',
  'GBa5Ci0XEAAej5N.jpg',
  'GBVl9zUXYAAC7yD.png',
  'GEb2nimWgAAehI3.jpg',
  'GnxYJvYXMAAkSPh.jpeg',
  'GPYZx8BWMAABS99.jpg',
  'GWVQMYoXgAAacCV.jpeg',
  'HK4jrBIWEAAL5MF.png',
  'HMMyDNJWwAAb6ay.jpg',
];

// ── State ──────────────────────────────────────────
const state = {
  config: null,
  avatars: [],
  identity: null,
  pendingAvatar: '',
  activity: 'online',
  activityDetail: '',
  presenceUsers: [],
  presenceHeartbeat: null,
  presencePoll: null,
  presencePushTimer: null,
  lastPresencePost: 0,
  idleTimer: null,
  stations: [],          // stations on current page
  selected: new Set(),   // selected osm_ids on current page
  allSelected: new Set(),// all selected across all pages (persists)
  totalFiltered: 0,
  currentPage: 1,
  totalPages: 1,
  searchParams: null,    // last search params for cross-page ops
  activeService: null,
  resultsMap: null,
  resultMarkers: [],
  city: null,
  fuel: new Set(),
  status: new Set(),
};

// ── API helpers ────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

// ── Init ───────────────────────────────────────────
async function init() {
  try {
    state.config = await api('/api/config');
    renderFuelChips();
    renderStatusChips();
    renderVoteStatusOptions();
    renderCitySelect();
    renderBrandSelect();
  } catch (e) {
    toast('Config load error: ' + e.message);
  }

  // Add source to all future API calls
  state.source = 'gdebenz';

  // City dropdown → auto search
  initServiceLauncher();
  initIdentityGate();

  // City dropdown → auto search
  $('#city-select').addEventListener('change', () => {
    const sel = $('#city-select');
    const opt = sel.options[sel.selectedIndex];
    if (opt && opt.dataset.lat) {
      $('#lat-input').value = parseFloat(opt.dataset.lat).toFixed(4);
      $('#lon-input').value = parseFloat(opt.dataset.lon).toFixed(4);
      $('#city-input').value = opt.dataset.nameRu || opt.textContent;
      state.city = { name: opt.dataset.nameRu || opt.textContent, lat: parseFloat(opt.dataset.lat), lon: parseFloat(opt.dataset.lon) };
      doSearch();
    }
  });

  // City search with debounce
  let cityTimer;
  $('#city-input').addEventListener('input', () => {
    clearTimeout(cityTimer);
    const q = $('#city-input').value.trim();
    if (q.length < 2) { hideSuggestions(); return; }
    cityTimer = setTimeout(() => searchCity(q), 300);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.field')) hideSuggestions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement?.id === 'city-input') {
      hideSuggestions();
      doSearch();
    }
  });

  // Comment mode toggle
  $('#comment-mode').addEventListener('change', () => {
    const mode = $('#comment-mode').value;
    $('#comment-text-field').style.display = (mode === 'custom') ? '' : 'none';
    if (mode !== 'custom') {
      const preview = state.config?.comment_templates?.[mode === 'positive' ? 'positive' : 'negative'] || [];
      $('#vote-text').value = `[random from ${preview.length} templates]`;
    } else {
      $('#vote-text').value = '';
    }
  });

  $('#search-btn').addEventListener('click', doSearch);
  $('#apply-filters-btn').addEventListener('click', doSearch);
  $('#select-all-btn').addEventListener('click', selectAllPage);
  $('#deselect-all-btn').addEventListener('click', deselectAllPage);
  $('#vote-btn').addEventListener('click', doVote);
  $('#vote-selected-btn').addEventListener('click', doVoteSelected);
  $('#vote-status').addEventListener('change', updateVoteBtn);

  // Pagination
  $('#page-prev').addEventListener('click', () => goPage(state.currentPage - 1));
  $('#page-next').addEventListener('click', () => goPage(state.currentPage + 1));
  $('#page-prev-bot').addEventListener('click', () => goPage(state.currentPage - 1));
  $('#page-next-bot').addEventListener('click', () => goPage(state.currentPage + 1));
  window.addEventListener('pagehide', leavePresence);
}

// ── Identity & Presence ────────────────────────────
async function loadAvatars() {
  try {
    const data = await api('/api/avatars');
    state.avatars = Array.isArray(data.avatars) ? data.avatars : [];
  } catch {
    state.avatars = FALLBACK_AVATAR_FILES.map((file, index) => ({
      id: `avatar-${index + 1}`,
      file,
      url: `/avatars/${encodeURIComponent(file)}`,
    }));
  }
}

function initIdentityGate() {
  state.identity = readIdentity();
  state.pendingAvatar = state.identity?.avatar || state.avatars[0]?.url || '';
  renderAvatarGrid();
  renderIdentityBadge();
  renderOnlineUsers([]);

  $('#identity-form').addEventListener('submit', saveIdentity);
  $('#identity-reset').addEventListener('click', () => {
    state.pendingAvatar = state.identity?.avatar || state.avatars[0]?.url || '';
    $('#identity-handle').value = state.identity?.handle || '';
    renderAvatarGrid();
    showIdentityModal();
  });

  if (state.identity) {
    $('#identity-modal').hidden = true;
    startPresence();
    showServicePicker();
  } else {
    showIdentityModal();
  }
}

function readIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
    if (!saved?.clientId || !saved?.handle || !saved?.avatar) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveIdentity(event) {
  event.preventDefault();
  const handle = $('#identity-handle').value.trim();
  if (!handle) {
    toast('Enter a handle or name');
    return;
  }
  if (!state.pendingAvatar) {
    toast('Choose an avatar');
    return;
  }

  const previous = state.identity || {};
  state.identity = {
    clientId: previous.clientId || randomId(),
    fingerprint: previous.fingerprint || randomHex(16),
    handle: handle.slice(0, 32),
    avatar: state.pendingAvatar,
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(state.identity));
  $('#identity-modal').hidden = true;
  renderIdentityBadge();
  startPresence();
  showServicePicker();
}

function showIdentityModal() {
  $('#identity-modal').hidden = false;
  setTimeout(() => $('#identity-handle').focus(), 0);
}

function initServiceLauncher() {
  $$('[data-service]').forEach((button) => {
    if (button.dataset.boundServiceLauncher === 'true') return;
    button.dataset.boundServiceLauncher = 'true';
    button.addEventListener('click', () => activateService(button.dataset.service));
  });
  const serviceSwitch = $('#service-switch');
  if (serviceSwitch && serviceSwitch.dataset.boundServiceLauncher !== 'true') {
    serviceSwitch.dataset.boundServiceLauncher = 'true';
    serviceSwitch.addEventListener('click', showServicePicker);
  }
  updateServiceSwitch();
}

function showServicePicker() {
  state.activeService = null;
  const picker = $('#service-picker');
  const gdebenz = $('#gdebenz-service');
  if (picker) picker.hidden = false;
  if (gdebenz) gdebenz.hidden = true;
  document.body.classList.add('service-picker-open');
  document.body.classList.remove('service-active-gdebenz');
  updateServiceSwitch();
  setActivity('selecting', 'Services', true);
}

function activateService(service) {
  if (service !== 'gdebenz' && service !== 'benzin') {
    toast('Service is not available yet');
    return;
  }

  state.activeService = service;
  state.source = service;
  const picker = $('#service-picker');
  const gdebenz = $('#gdebenz-service');
  if (picker) picker.hidden = true;
  if (gdebenz) gdebenz.hidden = false;
  document.body.classList.remove('service-picker-open');
  document.body.classList.add('service-active-gdebenz');
  updateServiceSwitch();

  // Re-fetch config for the selected source and rebuild filters
  loadConfigForSource(service);
  setActivity('online', service === 'benzin' ? 'Benzin-Status' : 'GdeBenz', true);
}

function updateServiceSwitch() {
  const serviceSwitch = $('#service-switch');
  if (!serviceSwitch) return;
  serviceSwitch.hidden = !state.identity;
}

async function loadConfigForSource(source) {
  try {
    state.config = await api(`/api/config?source=${source}`);
    renderFuelChips();
    renderStatusChips();
    renderVoteStatusOptions();
    renderBrandSelect();
  } catch (e) {
    toast('Config load error: ' + e.message);
  }
}

function renderAvatarGrid() {
  const grid = $('#avatar-grid');
  if (!grid) return;
  const avatars = state.avatars.length ? state.avatars : FALLBACK_AVATAR_FILES.map((file, index) => ({
    id: `avatar-${index + 1}`,
    url: `/avatars/${encodeURIComponent(file)}`,
  }));
  if (!state.pendingAvatar && avatars.length) state.pendingAvatar = avatars[0].url;

  grid.innerHTML = avatars.map((avatar) => `
    <button class="avatar-choice ${avatar.url === state.pendingAvatar ? 'selected' : ''}"
            type="button"
            data-avatar="${esc(avatar.url)}"
            title="${esc(avatar.file || avatar.id || 'Avatar')}">
      <img src="${esc(avatar.url)}" alt="">
    </button>
  `).join('');

  $$('.avatar-choice', grid).forEach((button) => {
    button.addEventListener('click', () => {
      state.pendingAvatar = button.dataset.avatar;
      renderAvatarGrid();
    });
  });
}

function renderIdentityBadge() {
  const badge = $('#fp-indicator');
  if (!state.identity) {
    badge.textContent = '';
    return;
  }
  badge.textContent = state.identity.handle;
  badge.title = `Fingerprint ${state.identity.fingerprint}`;
  $('#identity-handle').value = state.identity.handle;
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `client-${randomHex(16)}`;
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function startPresence() {
  stopPresenceTimers();
  postPresence(true);
  pollPresence();
  state.presenceHeartbeat = setInterval(() => postPresence(true), PRESENCE_HEARTBEAT_MS);
  state.presencePoll = setInterval(pollPresence, PRESENCE_POLL_MS);
}

function stopPresenceTimers() {
  clearInterval(state.presenceHeartbeat);
  clearInterval(state.presencePoll);
  clearTimeout(state.presencePushTimer);
  state.presenceHeartbeat = null;
  state.presencePoll = null;
  state.presencePushTimer = null;
}

function setActivity(activity, detail = '', force = false) {
  if (!state.identity) return;
  state.activity = activity;
  state.activityDetail = detail;
  requestPresenceSync(force);

  clearTimeout(state.idleTimer);
  if (activity !== 'idle' && activity !== 'voting') {
    state.idleTimer = setTimeout(() => {
      state.activity = 'idle';
      state.activityDetail = '';
      requestPresenceSync(true);
    }, ACTIVITY_IDLE_MS);
  }
}

function requestPresenceSync(force = false) {
  if (force || Date.now() - state.lastPresencePost >= PRESENCE_PUSH_MIN_MS) {
    clearTimeout(state.presencePushTimer);
    state.presencePushTimer = null;
    postPresence(true);
    return;
  }
  if (state.presencePushTimer) return;
  state.presencePushTimer = setTimeout(() => {
    state.presencePushTimer = null;
    postPresence(true);
  }, PRESENCE_PUSH_MIN_MS);
}

async function postPresence() {
  if (!state.identity) return;
  state.lastPresencePost = Date.now();
  try {
    const data = await api('/api/presence', {
      method: 'POST',
      body: JSON.stringify({
        clientId: state.identity.clientId,
        handle: state.identity.handle,
        avatar: state.identity.avatar,
        activity: state.activity,
        detail: state.activityDetail,
      }),
    });
    renderOnlineUsers(data.users || []);
  } catch {
    renderOnlineUsers(state.presenceUsers);
  }
}

async function pollPresence() {
  if (!state.identity) return;
  try {
    const data = await api('/api/presence');
    renderOnlineUsers(data.users || []);
  } catch {
    renderOnlineUsers(state.presenceUsers);
  }
}

function leavePresence() {
  if (!state.identity) return;
  fetch(`/api/presence?clientId=${encodeURIComponent(state.identity.clientId)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {});
}

function renderOnlineUsers(users) {
  const el = $('#online-users');
  if (!el) return;
  state.presenceUsers = users || [];

  if (!state.presenceUsers.length) {
    el.innerHTML = '<span class="online-empty">No one online</span>';
    return;
  }

  el.innerHTML = state.presenceUsers.map((user) => `
    <div class="online-user" title="${esc(user.handle)} · ${esc(activityLabel(user.activity, user.detail))}">
      ${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : ''}
      <span class="online-copy">
        <span class="online-name">${esc(user.handle)}</span>
        <span class="online-activity">${esc(activityLabel(user.activity, user.detail))}</span>
      </span>
    </div>
  `).join('');
}

function activityLabel(activity, detail = '') {
  const labels = {
    online: 'Online',
    searching: 'Searching',
    filtering: 'Filtering',
    selecting: 'Selecting',
    voting: 'Voting',
    done: 'Done',
    idle: 'Idle',
  };
  return detail ? `${labels[activity] || 'Online'}: ${detail}` : (labels[activity] || 'Online');
}

// ── Chips & Selects ────────────────────────────────
function renderFuelChips() {
  const container = $('#fuel-chips');
  container.innerHTML = state.config.fuel_grades.map(f =>
    `<span class="chip" data-fuel="${f}" onclick="toggleChip(this, 'fuel')">${f}</span>`
  ).join('');
}
function renderStatusChips() {
  const container = $('#status-chips');
  container.innerHTML = state.config.statuses.map(s =>
    `<span class="chip chip-${s.value}" data-status="${s.value}" onclick="toggleChip(this, 'status')">${s.label}</span>`
  ).join('');
}
function renderVoteStatusOptions() {
  const sel = $('#vote-status');
  sel.innerHTML = '<option value="">— select —</option>' +
    state.config.statuses.map(s => `<option value="${s.value}">${s.label}</option>`).join('');
}
function renderCitySelect() {
  const sel = $('#city-select');
  sel.innerHTML = '<option value="">— select —</option>' +
    state.config.cities.map(c =>
      `<option value="${c.name}" data-lat="${c.lat}" data-lon="${c.lon}" data-name-ru="${c.name_ru}">${c.name} (${c.name_ru})</option>`
    ).join('');
}
function renderBrandSelect() {
  const sel = $('#brand-filter');
  sel.innerHTML = '<option value="">All brands</option>' +
    state.config.brands.map(b => `<option value="${b}">${b}</option>`).join('');
}

function toggleChip(el, group) {
  const val = el.dataset[group];
  const set = state[group];
  if (set.has(val)) {
    set.delete(val);
    el.classList.remove('on');
  } else {
    set.add(val);
    el.classList.add('on');
  }
  setActivity('filtering', 'Changed filters', true);
}

// ── City Search ────────────────────────────────────
async function searchCity(q) {
  setActivity('searching', q, false);
  try {
    const data = await api(`/api/city/search?q=${encodeURIComponent(q)}`);
    const results = data.results || [];
    const box = $('#city-suggestions');
    if (!results.length) { hideSuggestions(); return; }
    box.innerHTML = results.map(c =>
      `<div class="item" onclick="pickCity('${c.name}', ${c.lat}, ${c.lon})">
        ${c.name}<span class="sub">${c.sub || ''}</span>
      </div>`
    ).join('');
    box.classList.add('show');
  } catch (e) {
    hideSuggestions();
  }
}
function hideSuggestions() { $('#city-suggestions').classList.remove('show'); }
function pickCity(name, lat, lon) {
  $('#city-input').value = name;
  $('#lat-input').value = lat.toFixed(4);
  $('#lon-input').value = lon.toFixed(4);
  state.city = { name, lat, lon };
  hideSuggestions();
  doSearch();
}

// ── Search ──────────────────────────────────────────
function buildSearchParams() {
  const p = new URLSearchParams();
  const city = $('#city-input').value.trim();
  const lat = $('#lat-input').value;
  const lon = $('#lon-input').value;
  const radius = $('#radius-input').value || '7';
  const brand = $('#brand-filter').value;
  if (city) p.set('city', city);
  if (lat) p.set('lat', lat);
  if (lon) p.set('lon', lon);
  p.set('radius', radius);
  if (state.fuel.size) p.set('fuel', [...state.fuel].join(','));
  if (state.status.size) p.set('status', [...state.status].join(','));
  if (brand) p.set('brand', brand);
  p.set('source', state.source || 'gdebenz');
  return p;
}

async function doSearch() {
  const label = $('#city-input').value.trim() || $('#city-select').value || 'Coordinates';
  setActivity('searching', label, true);
  state.searchParams = buildSearchParams();
  state.allSelected.clear();
  state.selected.clear();
  state.currentPage = 1;
  await loadPage(0);
}

async function loadPage(offset) {
  const list = $('#station-list');
  list.innerHTML = '<div class="spinner"></div>';
  $('#stats-bar').style.display = 'none';
  $('#pagination').style.display = 'none';
  $('#pagination-bot').style.display = 'none';
  $('#vote-panel').style.display = 'none';
  $('#results-area').innerHTML = '';

  try {
    const params = new URLSearchParams(state.searchParams.toString());
    params.set('offset', offset);
    params.set('limit', PAGE_SIZE);

    const data = await api(`/api/stations?${params}`);
    state.stations = data.stations;
    state.totalFiltered = data.filtered_total;
    state.totalPages = data.pages;
    state.currentPage = data.page;

    // Sync selected state for this page
    state.selected.clear();
    data.stations.forEach(s => {
      if (state.allSelected.has(s.osm_id)) state.selected.add(s.osm_id);
    });

    renderStations(data);
    renderPagination();
    $('#filter-panel').style.display = '';
    $('#station-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActivity('online', `${state.totalFiltered} stations`, true);
  } catch (e) {
    renderSearchFailure(e);
    setActivity('idle', '', true);
  }
}

function renderSearchFailure(error) {
  const list = $('#station-list');
  $('#stats-bar').style.display = 'none';
  $('#pagination').style.display = 'none';
  $('#pagination-bot').style.display = 'none';
  $('#vote-panel').style.display = 'none';
  $('#results-area').innerHTML = '';

  if (!isGdeBenzOutageError(error)) {
    list.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${esc(error.message || String(error))}</div>`;
    return;
  }

  const quotes = POTEMKIN_QUOTES.map((quote, index) => `
    <span
      class="potemkin-quote"
      style="--quote-top:${10 + (index % 5) * 16}%; --quote-delay:${index * -2.3}s; --quote-duration:${22 + (index % 4) * 5}s">
      ${esc(quote)}
    </span>
  `).join('');

  list.innerHTML = `
    <section class="potemkin-standby" aria-live="polite">
      <div class="potemkin-quotes" aria-hidden="true">${quotes}</div>
      <div class="potemkin-copy">
        <p class="potemkin-kicker">GdeBenz signal lost</p>
        <h2>Please stand by and enjoy some Potemkin nostalgia</h2>
        <p class="potemkin-message">${POTEMKIN_STANDBY_MESSAGE}</p>
      </div>
      <div class="potemkin-player" aria-label="Potemkin nostalgia video reels">
        <article class="potemkin-video-shell">
          <video
            id="potemkin-video"
            class="potemkin-video"
            autoplay
            controls
            muted
            playsinline
            preload="metadata"
            src="${potemkinVideoSrc(0)}"
            data-video-index="0"></video>
          <div class="potemkin-video-meta">
            <span>Sequential nostalgia broadcast</span>
            <span class="potemkin-video-count">1 / ${POTEMKIN_VIDEO_FILES.length}</span>
          </div>
        </article>
      </div>
    </section>
  `;
  wirePotemkinVideoPlayer(list);
}

function isGdeBenzOutageError(error) {
  const message = String(error?.message || error || '');
  return /Could not reach GdeBenz|fetch failed|Failed to fetch|NetworkError/i.test(message);
}

function wirePotemkinVideoPlayer(root) {
  const video = $('#potemkin-video', root);
  if (!video) return;
  video.controls = true;
  video.muted = true;
  try {
    video.volume = 0.1;
  } catch {
    // Some test/browser environments can reject volume assignment.
  }
  if (POTEMKIN_VIDEO_FILES.length < 2) return;
  video.addEventListener('ended', () => advancePotemkinVideo(video, root));
}

function advancePotemkinVideo(video, root) {
  const currentIndex = Number(video.dataset.videoIndex || 0);
  const nextIndex = ((Number.isFinite(currentIndex) ? currentIndex : 0) + 1) % POTEMKIN_VIDEO_FILES.length;
  video.dataset.videoIndex = String(nextIndex);
  video.setAttribute('src', potemkinVideoSrc(nextIndex));

  const count = $('.potemkin-video-count', root);
  if (count) count.textContent = `${nextIndex + 1} / ${POTEMKIN_VIDEO_FILES.length}`;

  if (window.navigator?.userAgent?.includes('jsdom')) return;

  try {
    const playback = video.play?.();
    if (playback && typeof playback.catch === 'function') playback.catch(() => {});
  } catch {
    // Browsers may block autoplay after source changes; the next user-visible frame still advances.
  }
}

function potemkinVideoSrc(index) {
  return `/video-reels/${encodeURIComponent(POTEMKIN_VIDEO_FILES[index] || POTEMKIN_VIDEO_FILES[0])}`;
}

function goPage(page) {
  if (page < 1 || page > state.totalPages) return;
  setActivity('searching', `Page ${page}`, false);
  const offset = (page - 1) * PAGE_SIZE;
  loadPage(offset);
}

function renderStations(data) {
  const list = $('#station-list');
  if (!data.stations.length) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No stations found</div>';
    renderResultsMap([]);
    $('#stats-bar').style.display = 'none';
    $('#pagination').style.display = 'none';
    $('#pagination-bot').style.display = 'none';
    $('#vote-panel').style.display = 'none';
    return;
  }

  list.innerHTML = data.stations.map(s => `
    <div class="station-card ${state.allSelected.has(s.osm_id) ? 'selected' : ''}"
         data-osm="${s.osm_id}" onclick="toggleStation(this, '${s.osm_id}')">
      <div class="check"></div>
      <div class="body">
        <div class="name">${esc(s.name || s.brand || 'Gas Station')}</div>
        ${s.addr ? `<div class="addr">${esc(s.addr)}</div>` : ''}
        <div class="meta">
          <span class="pill pill-${s.status}">
            <span class="pill-dot" style="background:${statusColor(s.status)}"></span>
            ${s.status_label}
          </span>
          ${s.fuel_list.length ? `<span class="fuel-tags">${s.fuel_list.map(f => `<span class="fuel-tag">${f}</span>`).join('')}</span>` : ''}
          ${s.confirmations ? `<span class="conf">✓${s.confirmations}</span>` : ''}
          ${s.distance_km ? `<span class="conf">${s.distance_km.toFixed(1)} km</span>` : ''}
        </div>
      </div>
      <span class="chev">›</span>
    </div>
  `).join('');

  // Summary
  const summary = data.summary || {};
  const parts = [];
  if (summary.yes) parts.push(`🟢 ${summary.yes} available`);
  if (summary.queue) parts.push(`🟠 ${summary.queue} queue`);
  if (summary.low) parts.push(`🟡 ${summary.low} low`);
  if (summary.no) parts.push(`🔴 ${summary.no} none`);
  $('#stats-summary').innerHTML =
    `📍 ${data.center.lat.toFixed(3)}, ${data.center.lon.toFixed(3)} (${data.center.radius}km) — ` +
    `${data.total} total, ${state.totalFiltered} filtered` +
    (parts.length ? `<br><span style="font-size:12px">${parts.join(' · ')}</span>` : '');

  updateSelectedCount();
  $('#stats-bar').style.display = 'flex';
  $('#vote-panel').style.display = '';
  renderResultsMap(data.stations);
  updateVoteBtn();
}

function renderResultsMap(stations) {
  const panel = $('#results-map-panel');
  const mapEl = $('#current-page-map');
  const countEl = $('#results-map-count');
  if (!panel || !mapEl) return;

  const plottedStations = stations.filter(hasStationCoords);
  panel.hidden = stations.length === 0;
  if (countEl) {
    const count = plottedStations.length;
    countEl.textContent = `${count} ${count === 1 ? 'station' : 'stations'}`;
  }

  clearResultMarkers();

  if (!stations.length) {
    return;
  }

  if (!plottedStations.length) {
    destroyResultsMap();
    mapEl.innerHTML = '<div class="map-fallback"><div><strong>No coordinates</strong><span>Current page stations have no map positions.</span></div></div>';
    return;
  }

  if (!window.L) {
    destroyResultsMap();
    mapEl.innerHTML = '<div class="map-fallback"><div><strong>Map unavailable</strong><span>OpenStreetMap could not load, but the station list is ready.</span></div></div>';
    return;
  }

  if (!state.resultsMap) mapEl.innerHTML = '';
  const map = ensureResultsMap(mapEl, plottedStations[0]);
  if (!map) return;

  state.resultMarkers = plottedStations.map(station => {
    const marker = window.L.marker([station.lat, station.lon], {
      icon: window.L.divIcon({
        className: '',
        html: `<span class="result-map-marker" style="background:${RESULT_MAP_PIN_COLOR}"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      title: station.name || station.brand || 'Gas Station',
    }).addTo(map);

    marker.bindPopup(`
      <div class="result-map-popup">
        <strong>${esc(station.name || station.brand || 'Gas Station')}</strong>
        <span>${esc(station.addr || station.status_label || '')}</span>
      </div>
    `);
    marker.on('click', () => focusStationCard(station.osm_id));
    return marker;
  });

  const bounds = window.L.latLngBounds(plottedStations.map(station => [station.lat, station.lon]));
  setTimeout(() => {
    map.invalidateSize();
    if (plottedStations.length === 1) {
      map.setView(bounds.getCenter(), 14);
    } else {
      map.fitBounds(bounds, { padding: [22, 22], maxZoom: 15 });
    }
  }, 0);
}

function ensureResultsMap(mapEl, firstStation) {
  if (state.resultsMap) return state.resultsMap;
  state.resultsMap = window.L.map(mapEl, {
    attributionControl: true,
    scrollWheelZoom: false,
  }).setView([firstStation.lat, firstStation.lon], 12);

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.resultsMap);

  return state.resultsMap;
}

function clearResultMarkers() {
  if (!state.resultsMap || !state.resultMarkers.length) {
    state.resultMarkers = [];
    return;
  }
  state.resultMarkers.forEach(marker => marker.remove());
  state.resultMarkers = [];
}

function destroyResultsMap() {
  clearResultMarkers();
  if (!state.resultsMap) return;
  state.resultsMap.remove();
  state.resultsMap = null;
}

function hasStationCoords(station) {
  return station.lat !== null && station.lat !== undefined && station.lat !== '' &&
    station.lon !== null && station.lon !== undefined && station.lon !== '' &&
    Number.isFinite(Number(station.lat)) && Number.isFinite(Number(station.lon));
}

function focusStationCard(osmId) {
  const card = $$('.station-card').find(el => el.dataset.osm === String(osmId));
  if (!card) return;
  $$('.station-card.map-focused').forEach(el => el.classList.remove('map-focused'));
  card.classList.add('map-focused');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderPagination() {
  const show = state.totalPages > 1;
  const info = `Page ${state.currentPage} / ${state.totalPages}`;
  const totalInfo = `${state.totalFiltered} stations across ${state.totalPages} ${state.totalPages === 1 ? 'page' : 'pages'}`;

  for (const id of ['pagination', 'pagination-bot']) {
    const el = $('#' + id);
    if (!el) continue;
    el.style.display = show ? 'flex' : 'none';
    el.querySelector('.page-info').textContent = info;
    const totalEl = el.querySelector('.page-total');
    if (totalEl) totalEl.textContent = totalInfo;
  }

  $('#page-prev').disabled = state.currentPage <= 1;
  $('#page-next').disabled = state.currentPage >= state.totalPages;
  $('#page-prev-bot').disabled = state.currentPage <= 1;
  $('#page-next-bot').disabled = state.currentPage >= state.totalPages;
}

// ── Selection ──────────────────────────────────────
function toggleStation(card, osmId) {
  if (state.allSelected.has(osmId)) {
    state.allSelected.delete(osmId);
    state.selected.delete(osmId);
    card.classList.remove('selected');
  } else {
    state.allSelected.add(osmId);
    state.selected.add(osmId);
    card.classList.add('selected');
  }
  updateSelectedCount();
  updateVoteBtn();
  setActivity('selecting', `${state.allSelected.size} selected`, true);
}

function selectAllPage() {
  state.stations.forEach(s => { state.selected.add(s.osm_id); state.allSelected.add(s.osm_id); });
  $$('.station-card').forEach(c => c.classList.add('selected'));
  updateSelectedCount();
  updateVoteBtn();
  setActivity('selecting', `${state.allSelected.size} selected`, true);
}

function deselectAllPage() {
  state.stations.forEach(s => { state.selected.delete(s.osm_id); state.allSelected.delete(s.osm_id); });
  $$('.station-card').forEach(c => c.classList.remove('selected'));
  updateSelectedCount();
  updateVoteBtn();
  setActivity('selecting', `${state.allSelected.size} selected`, true);
}

function updateSelectedCount() {
  const statsEl = $('#stats-selected');
  if (statsEl) statsEl.textContent = `Selected: ${state.allSelected.size} (total across all pages)`;
  const selCnt = $('#vote-sel-count');
  if (selCnt) selCnt.textContent = state.allSelected.size;
  const allCnt = $('#vote-all-count');
  if (allCnt) allCnt.textContent = state.totalFiltered;
}

function updateVoteBtn() {
  const hasStatus = !!$('#vote-status')?.value;
  const voteBtn = $('#vote-btn');
  if (voteBtn) voteBtn.disabled = !hasStatus || state.totalFiltered === 0;
  const selBtn = $('#vote-selected-btn');
  if (selBtn) selBtn.disabled = !hasStatus || state.allSelected.size === 0;
}

// ── Voting (ALL filtered stations across all pages) ──
async function doVote() {
  const voteStatus = $('#vote-status').value;
  if (!voteStatus) return;
  setActivity('voting', 'Preparing', true);

  const mode = $('#comment-mode').value;
  const lat = parseFloat($('#lat-input').value) || null;
  const lon = parseFloat($('#lon-input').value) || null;
  const city = $('#city-input').value.trim() || null;

  // First, fetch ALL filtered station IDs from the server
  const btn = $('#vote-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching IDs...';

  let ids = [];
  try {
    const idsParams = new URLSearchParams(state.searchParams.toString());
    const data = await api(`/api/stations/ids?${idsParams}`);
    ids = data.ids;
  } catch (e) {
    toast('Failed to fetch station IDs: ' + e.message);
    btn.disabled = false;
    updateVoteBtn();
    return;
  }

  if (!ids.length) {
    toast('No stations to vote on');
    btn.disabled = false;
    updateVoteBtn();
    return;
  }

  const total = ids.length;
  btn.textContent = '⏳ Voting...';
  setActivity('voting', `0 / ${total}`, true);

  // Progress bar
  const progBar = $('#progress-bar');
  const progFill = $('#progress-fill');
  const progText = $('#progress-text');
  const progPct = $('#progress-pct');
  const progCur = $('#progress-current');
  const progBadge = $('#progress-badge');
  progBar.style.display = '';
  progFill.style.width = '0%';
  progFill.classList.remove('done');
  $('#results-area').innerHTML = '';

  let baseText = '';
  if (mode === 'positive') baseText = '__random_positive__';
  else if (mode === 'negative') baseText = '__random_negative__';
  else baseText = $('#vote-text').value;

  const results = [];
  let ok = 0, fail = 0, skip = 0;
  const startTime = Date.now();

  for (let i = 0; i < total; i++) {
    const osmId = ids[i];

    // Progress update
    const pct = Math.round((i / total) * 100);
    progFill.style.width = pct + '%';
    progText.textContent = `Voted ${i} / ${total}`;
    progBadge.textContent = `#${i + 1} of ${total}`;
    if (i > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.ceil((total - i) / (i / elapsed));
      progPct.textContent = pct + `% — ~${remaining}s left`;
    } else {
      progPct.textContent = '0%';
    }
    progCur.textContent = `Station ${osmId}`;
    if (i === 0 || i % 5 === 0) {
      setActivity('voting', `${i + 1} / ${total}`, true);
    }

    try {
      const resp = await api('/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          osm_ids: [osmId],
          vote_status: voteStatus,
          text: baseText,
          on_site: $('#vote-onsite').checked,
          city: city, lat: lat, lon: lon,
          source: state.source || 'gdebenz',
          fingerprint: state.identity?.fingerprint || state.identity?.clientId || '',
        }),
      });
      const r = resp[0] || { osm_id: osmId, name: osmId, success: false, reason: 'no response' };
      r.success ? ok++ : (r.reason === 'already voted' ? skip++ : fail++);
      results.push(r);
    } catch (e) {
      fail++;
      results.push({ osm_id: osmId, name: osmId, success: false, reason: e.message });
    }
  }

  // Done
  progFill.style.width = '100%';
  progFill.classList.add('done');
  progText.textContent = `✅ ${ok} OK · ⏭ ${skip} skipped · ❌ ${fail} failed`;
  progPct.textContent = '100%';
  progBadge.textContent = 'COMPLETE';
  progCur.textContent = '';
  btn.disabled = false;
  $('#vote-status').value = '';
  updateVoteBtn();
  setActivity('done', `${ok} OK · ${fail} failed`, true);
  setTimeout(() => { progBar.style.display = 'none'; }, 10000);
  if (fail || skip) renderResults(results);
  else toast(`✅ All ${ok} votes sent!`);
}

// ── Voting (selected stations only) ─────────────────
async function doVoteSelected() {
  const voteStatus = $('#vote-status').value;
  if (!voteStatus || state.allSelected.size === 0) return;

  const ids = [...state.allSelected];
  const total = ids.length;
  const btn = $('#vote-selected-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Voting...';

  const mode = $('#comment-mode').value;
  const lat = parseFloat($('#lat-input').value) || null;
  const lon = parseFloat($('#lon-input').value) || null;
  const city = $('#city-input').value.trim() || null;

  // Progress bar
  const progBar = $('#progress-bar');
  const progFill = $('#progress-fill');
  const progText = $('#progress-text');
  const progPct = $('#progress-pct');
  const progCur = $('#progress-current');
  const progBadge = $('#progress-badge');
  progBar.style.display = '';
  progFill.style.width = '0%';
  progFill.classList.remove('done');
  $('#results-area').innerHTML = '';

  let baseText = '';
  if (mode === 'positive') baseText = '__random_positive__';
  else if (mode === 'negative') baseText = '__random_negative__';
  else baseText = $('#vote-text').value;

  const results = [];
  let ok = 0, fail = 0, skip = 0;
  const startTime = Date.now();

  for (let i = 0; i < total; i++) {
    const osmId = ids[i];
    const pct = Math.round((i / total) * 100);
    progFill.style.width = pct + '%';
    progText.textContent = `Voted ${i} / ${total}`;
    progBadge.textContent = `#${i + 1} of ${total}`;
    if (i > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.ceil((total - i) / (i / elapsed));
      progPct.textContent = pct + `% — ~${remaining}s left`;
    } else {
      progPct.textContent = '0%';
    }
    progCur.textContent = `Station ${osmId}`;

    try {
      const resp = await api('/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          osm_ids: [osmId], vote_status: voteStatus, text: baseText,
          on_site: $('#vote-onsite').checked, city, lat, lon,
          source: state.source || 'gdebenz',
          fingerprint: state.identity?.fingerprint || state.identity?.clientId || '',
        }),
      });
      const r = resp[0] || { osm_id: osmId, name: osmId, success: false, reason: 'no response' };
      r.success ? ok++ : (r.reason === 'already voted' ? skip++ : fail++);
      results.push(r);
    } catch (e) {
      fail++;
      results.push({ osm_id: osmId, name: osmId, success: false, reason: e.message });
    }
  }

  // Done
  progFill.style.width = '100%';
  progFill.classList.add('done');
  progText.textContent = `✅ ${ok} OK · ⏭ ${skip} skipped · ❌ ${fail} failed`;
  progPct.textContent = '100%';
  progBadge.textContent = 'COMPLETE';
  progCur.textContent = '';
  btn.textContent = `🗳 Vote Selected (${total})`;
  btn.disabled = false;
  state.allSelected.clear();
  state.selected.clear();
  $$('.station-card').forEach(c => c.classList.remove('selected'));
  updateSelectedCount();
  updateVoteBtn();
  $('#vote-status').value = '';
  setActivity('done', `${ok} OK · ${fail} failed`, true);
  setTimeout(() => { progBar.style.display = 'none'; }, 10000);
  if (fail || skip) renderResults(results);
  else toast(`✅ All ${ok} votes sent!`);
}

function renderResults(results) {
  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success && r.reason !== 'already voted').length;
  const skip = results.filter(r => !r.success && r.reason === 'already voted').length;
  const area = $('#results-area');
  area.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:8px;font-size:13px;font-weight:600">
      ${ok ? `<span style="color:var(--green)">✅ ${ok} success</span>` : ''}
      ${skip ? `<span style="color:var(--yellow)">⏭ ${skip} already voted</span>` : ''}
      ${fail ? `<span style="color:var(--red)">❌ ${fail} failed</span>` : ''}
    </div>
    ${results.filter(r => !r.success).map(r => `
      <div class="result-card ${r.reason === 'already voted' ? 'result-skip' : 'result-fail'}">
        ${r.reason === 'already voted' ? '⏭' : '❌'}
        ${esc(r.name || r.osm_id)} — ${r.reason || 'error'}
      </div>
    `).join('')}
  `;
}

// ── Helpers ─────────────────────────────────────────
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function statusColor(s) { return { yes: '#30D56B', queue: '#FF7A1A', low: '#FFC400', no: '#FF4D5A' }[s] || '#8A94A6'; }
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

init();

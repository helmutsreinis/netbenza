const BASE_URL = 'https://gdebenz.ru';

export const FUEL_GRADES = ['92', '95', '98', '100', 'ДТ'];
export const STATUSES = ['yes', 'queue', 'low', 'no'];

export const STATUS_LABELS_EN = {
  yes: 'Fuel Available',
  queue: 'Queue',
  low: 'Low Fuel',
  no: 'No Fuel',
};

export const TOP_CITIES = [
  { name: 'Moscow', name_ru: 'Москва', lat: 55.7520, lon: 37.6178 },
  { name: 'Saint Petersburg', name_ru: 'Санкт-Петербург', lat: 59.9386, lon: 30.3141 },
  { name: 'Novosibirsk', name_ru: 'Новосибирск', lat: 55.0302, lon: 82.9204 },
  { name: 'Yekaterinburg', name_ru: 'Екатеринбург', lat: 56.8389, lon: 60.6057 },
  { name: 'Kazan', name_ru: 'Казань', lat: 55.7961, lon: 49.1064 },
  { name: 'Nizhny Novgorod', name_ru: 'Нижний Новгород', lat: 56.3287, lon: 44.0020 },
  { name: 'Chelyabinsk', name_ru: 'Челябинск', lat: 55.1644, lon: 61.4368 },
  { name: 'Samara', name_ru: 'Самара', lat: 53.1959, lon: 50.1002 },
  { name: 'Omsk', name_ru: 'Омск', lat: 54.9893, lon: 73.3682 },
  { name: 'Rostov-on-Don', name_ru: 'Ростов-на-Дону', lat: 47.2357, lon: 39.7015 },
  { name: 'Ufa', name_ru: 'Уфа', lat: 54.7388, lon: 55.9721 },
  { name: 'Krasnoyarsk', name_ru: 'Красноярск', lat: 56.0106, lon: 92.8526 },
  { name: 'Perm', name_ru: 'Пермь', lat: 58.0105, lon: 56.2294 },
  { name: 'Voronezh', name_ru: 'Воронеж', lat: 51.6606, lon: 39.2003 },
  { name: 'Volgograd', name_ru: 'Волгоград', lat: 48.7080, lon: 44.5133 },
  { name: 'Krasnodar', name_ru: 'Краснодар', lat: 45.0355, lon: 38.9753 },
  { name: 'Saratov', name_ru: 'Саратов', lat: 51.5336, lon: 46.0343 },
  { name: 'Tyumen', name_ru: 'Тюмень', lat: 57.1522, lon: 65.5272 },
  { name: 'Sochi', name_ru: 'Сочи', lat: 43.5855, lon: 39.7231 },
  { name: 'Vladivostok', name_ru: 'Владивосток', lat: 43.1155, lon: 131.8855 },
];

export const TOP_BRANDS = [
  'Лукойл', 'Газпромнефть', 'Роснефть', 'Татнефть', 'Башнефть',
  'Shell', 'ТНК', 'Трасса', 'Топаз', 'ННК', 'Flash', 'Fueller',
  'Газпром', 'Asco', 'Ирбис', 'Нефтьмагистраль', 'Калининграднефтепродукт',
  'Сургутнефтегаз', 'ТАИФ-НК', 'А+', 'Энергия', 'GP', 'G7',
  'Formula', 'Роса', 'Нефтемаркет', 'ОПТИ', 'Прайм', 'Varta',
  'Gulf', 'Петрол', 'Октан', 'Сибнефть', 'Эталон', 'ОЛВИ',
  'Трансбункер', 'Радуга', 'Альянс', 'Солид', 'Омни',
];

export const COMMENT_TEMPLATES = {
  positive: [
    'Есть топливо, все колонки работают',
    'Заправился без проблем, всё есть',
    'Бензин есть, очереди нет',
    'Все марки топлива в наличии',
    'Работает, заправился быстро',
    'Есть и 92 и 95 и дизель',
    'Полные баки, приезжайте',
    'Без перебоев, топливо есть',
    'Заправка работает штатно',
    'Всё OK, топливо на всех колонках',
  ],
  negative: [
    'Топлива нет, не тратьте время',
    'Бензина нет уже несколько часов',
    'Только дизель, бензина нет',
    'Закрыто, не работает',
    'Очередь на час, топлива мало',
    '92 нет, только 95 остался',
    'Колонки не работают',
    'Топливо закончилось',
    'Привоз обещали но пока нет',
    'Не заправиться, сухо',
  ],
};

export const AVATAR_FILES = [
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

const tokenCache = new Map();

export class GdeBenzUnavailableError extends Error {
  constructor(cause) {
    const detail = cause?.message || String(cause || 'request failed');
    super(`Could not reach GdeBenz. Please try again in a moment. (${detail})`);
    this.name = 'GdeBenzUnavailableError';
    this.cause = cause;
  }
}

export function isGdeBenzUnavailableError(error) {
  return error instanceof GdeBenzUnavailableError;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intOrZero(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cacheGet(key) {
  const entry = tokenCache.get(key);
  if (entry && Date.now() < entry.expires) return entry.value;
  tokenCache.delete(key);
  return '';
}

function cacheSet(key, value, ttlSeconds = 1800) {
  tokenCache.set(key, {
    value,
    expires: Date.now() + Math.max(30, ttlSeconds - 60) * 1000,
  });
}

export function statusColor(status) {
  return {
    yes: '#30D56B',
    queue: '#FF7A1A',
    low: '#FFC400',
    no: '#FF4D5A',
  }[status] || '#8A94A6';
}

export function avatarList() {
  return AVATAR_FILES.map((file, index) => ({
    id: `avatar-${index + 1}`,
    file,
    url: `/avatars/${encodeURIComponent(file)}`,
  }));
}

export function parseStation(raw = {}) {
  const fuelsNow = raw.fuels_now || '';
  const fuelList = String(fuelsNow)
    .split(',')
    .map((fuel) => fuel.trim())
    .filter(Boolean);
  const status = raw.status || 'none';
  const brand = raw.brand || '';
  const name = raw.name || brand || 'Заправка';

  return {
    osm_id: String(raw.osm_id || ''),
    name,
    brand,
    addr: raw.addr || '',
    lat: numberOrZero(raw.lat),
    lon: numberOrZero(raw.lon),
    status,
    status_label: STATUS_LABELS_EN[status] || status,
    fuels_now: String(fuelsNow),
    fuel_list: fuelList,
    confirmations: intOrZero(raw.confirmations),
    confirmed: Boolean(raw.confirmed),
    last_at: raw.last_at || '',
    distance_km: numberOrZero(raw.distance_km),
    conflict: raw.conflict || '',
    confidence_base: numberOrZero(raw.confidence_base),
  };
}

export function stationOut(station) {
  return {
    osm_id: station.osm_id,
    name: station.name,
    brand: station.brand,
    addr: station.addr,
    lat: station.lat,
    lon: station.lon,
    status: station.status,
    status_label: station.status_label,
    fuels_now: station.fuels_now,
    fuel_list: station.fuel_list,
    confirmations: station.confirmations,
    distance_km: station.distance_km,
    last_at: station.last_at,
  };
}

export function filterStations(stations, options = {}) {
  const fuelTypes = options.fuelTypes || null;
  const statuses = options.statuses || null;
  const brand = options.brand || '';
  const brandLower = brand.toLowerCase();

  return stations.filter((station) => {
    if (statuses?.length && !statuses.includes(station.status)) return false;
    if (fuelTypes?.length && !fuelTypes.some((fuel) => station.fuel_list.includes(fuel))) {
      return false;
    }
    if (
      brandLower
      && !station.brand.toLowerCase().includes(brandLower)
      && !station.name.toLowerCase().includes(brandLower)
    ) {
      return false;
    }
    return true;
  });
}

export function buildPagedStationResponse({
  stations,
  filtered,
  summary,
  center,
  offset = 0,
  limit = 20,
}) {
  const safeLimit = Math.max(0, Number(limit) || 20);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const pageStations = safeLimit > 0 ? filtered.slice(safeOffset, safeOffset + safeLimit) : filtered;
  const pages = filtered.length > 0 && safeLimit > 0
    ? Math.max(1, Math.ceil(filtered.length / safeLimit))
    : 1;

  return {
    center,
    summary,
    total: stations.length,
    filtered_total: filtered.length,
    page: safeLimit > 0 ? Math.floor(safeOffset / safeLimit) + 1 : 1,
    pages,
    stations: pageStations.map(stationOut),
  };
}

export function getConfigPayload() {
  return {
    fuel_grades: FUEL_GRADES,
    statuses: Object.entries(STATUS_LABELS_EN).map(([value, label]) => ({
      value,
      label,
      color: statusColor(value),
    })),
    cities: TOP_CITIES,
    brands: TOP_BRANDS,
    comment_templates: COMMENT_TEMPLATES,
  };
}

function splitParam(value) {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function queryOptions(searchParams) {
  return {
    city: searchParams.get('city') || '',
    lat: searchParams.has('lat') ? Number(searchParams.get('lat')) : null,
    lon: searchParams.has('lon') ? Number(searchParams.get('lon')) : null,
    radius: Number(searchParams.get('radius') || 20),
    fuelTypes: splitParam(searchParams.get('fuel')),
    statuses: splitParam(searchParams.get('status')),
    brand: searchParams.get('brand') || '',
    offset: Number(searchParams.get('offset') || 0),
    limit: Number(searchParams.get('limit') || 20),
  };
}

async function fetchJson(path, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'user-agent': 'gdebenz-netlify/1.0',
        accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new GdeBenzUnavailableError(error);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    if (response.status >= 500) {
      throw new GdeBenzUnavailableError(new Error(detail || response.statusText));
    }
    throw new Error(detail || response.statusText);
  }
  return response.json();
}

function pathWithParams(path, params) {
  const search = new URLSearchParams(params);
  return `${path}?${search.toString()}`;
}

export async function getRealtimeToken(fetchImpl = fetch) {
  const cached = cacheGet('rt');
  if (cached) return cached;
  try {
    const data = await fetchJson('/api/rt', {}, fetchImpl);
    const token = data.rt || '';
    if (token) cacheSet('rt', token, data.ttl || 1800);
    return token;
  } catch {
    return '';
  }
}

export async function getVoteToken(fetchImpl = fetch) {
  const cached = cacheGet('vt');
  if (cached) return cached;
  try {
    const data = await fetchJson('/api/vt', {}, fetchImpl);
    const token = data.vt || '';
    if (token) cacheSet('vt', token, data.ttl || 1800);
    return token;
  } catch {
    return '';
  }
}

export async function searchCity(query, fetchImpl = fetch) {
  const data = await fetchJson(pathWithParams('/api/cities', { q: query }), {}, fetchImpl);
  if (Array.isArray(data)) return data;
  return Array.isArray(data.results) ? data.results : [];
}

export async function geoip(fetchImpl = fetch) {
  return fetchJson('/api/geoip', {}, fetchImpl);
}

export async function resolveCoords({ city, lat, lon }, fetchImpl = fetch) {
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  if (city) {
    const cities = await searchCity(city, fetchImpl);
    if (!cities.length) throw new Error(`City '${city}' not found`);
    return {
      lat: numberOrZero(cities[0].lat),
      lon: numberOrZero(cities[0].lon),
    };
  }
  const location = await geoip(fetchImpl);
  return {
    lat: numberOrZero(location.lat) || 55.75,
    lon: numberOrZero(location.lon) || 37.62,
  };
}

export async function getNearby(lat, lon, radius, fetchImpl = fetch) {
  const rt = await getRealtimeToken(fetchImpl);
  const latSnapped = Math.round(lat * 20) / 20;
  const lonSnapped = Math.round(lon * 20) / 20;
  const data = await fetchJson(
    pathWithParams('/api/nearby', {
      lat: latSnapped.toFixed(2),
      lon: lonSnapped.toFixed(2),
      radius_km: radius || 20,
    }),
    { headers: rt ? { 'x-rt': rt } : {} },
    fetchImpl,
  );
  return {
    stations: Array.isArray(data.stations) ? data.stations.map(parseStation) : [],
    summary: data.summary || {},
  };
}

export async function getStationComments(osmId, fetchImpl = fetch) {
  const rt = await getRealtimeToken(fetchImpl);
  return fetchJson(`/api/comments/${encodeURIComponent(osmId)}`, {
    headers: rt ? { 'x-rt': rt } : {},
  }, fetchImpl);
}

export async function listStations(options, fetchImpl = fetch) {
  const centerCoords = await resolveCoords(options, fetchImpl);
  const radius = Number.isFinite(options.radius) ? options.radius : 20;
  const { stations, summary } = await getNearby(centerCoords.lat, centerCoords.lon, radius, fetchImpl);
  const filtered = filterStations(stations, options);

  return buildPagedStationResponse({
    stations,
    filtered,
    summary,
    center: { lat: centerCoords.lat, lon: centerCoords.lon, radius },
    offset: options.offset,
    limit: options.limit,
  });
}

export async function allStationIds(options, fetchImpl = fetch) {
  const centerCoords = await resolveCoords(options, fetchImpl);
  const radius = Number.isFinite(options.radius) ? options.radius : 20;
  const { stations } = await getNearby(centerCoords.lat, centerCoords.lon, radius, fetchImpl);
  const filtered = filterStations(stations, options);

  return { ids: filtered.map((station) => station.osm_id), total: filtered.length };
}

export async function votePreview(options, fetchImpl = fetch) {
  const centerCoords = await resolveCoords(options, fetchImpl);
  const radius = Number.isFinite(options.radius) ? options.radius : 20;
  const { stations } = await getNearby(centerCoords.lat, centerCoords.lon, radius, fetchImpl);
  const filtered = filterStations(stations, options);
  const limit = Number.isFinite(options.limit) ? options.limit : 200;
  const limited = limit > 0 ? filtered.slice(0, limit) : filtered;
  return limited.map(stationOut);
}

export function resolveCommentText(text) {
  if (text !== '__random_positive__' && text !== '__random_negative__') return text || '';
  const key = text === '__random_positive__' ? 'positive' : 'negative';
  const templates = COMMENT_TEMPLATES[key] || [];
  return templates[Math.floor(Math.random() * templates.length)] || '';
}

export async function submitVote(vote, fetchImpl = fetch) {
  if (!STATUSES.includes(vote.status)) {
    throw new Error(`Invalid status: ${vote.status}`);
  }

  const [vt, rt, comments] = await Promise.all([
    getVoteToken(fetchImpl),
    getRealtimeToken(fetchImpl),
    getStationComments(vote.osm_id, fetchImpl).catch(() => ({})),
  ]);
  const name = vote.name || comments.addr || vote.osm_id;
  const lat = numberOrZero(vote.lat);
  const lon = numberOrZero(vote.lon);
  const body = {
    osm_id: vote.osm_id,
    name,
    lat,
    lon,
    status: vote.status,
    text: resolveCommentText(vote.text),
    fp: vote.fingerprint || '',
    cf: '',
    vt,
  };
  if (comments.cvt) body.cvt = comments.cvt;
  if (vote.vlat && vote.vlon) {
    body.vlat = vote.vlat;
    body.vlon = vote.vlon;
  }

  const response = await fetchImpl(`${BASE_URL}/api/comments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'gdebenz-netlify/1.0',
      ...(rt ? { 'x-rt': rt } : {}),
    },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const detail = await response.json().then((data) => data.detail).catch(() => '');
    return { osm_id: vote.osm_id, name, success: false, reason: detail || 'already voted' };
  }
  if (response.status === 403) {
    return { osm_id: vote.osm_id, name, success: false, reason: 'forbidden' };
  }
  if (!response.ok) {
    const reason = await response.text().catch(() => response.statusText);
    return { osm_id: vote.osm_id, name, success: false, reason: reason || response.statusText };
  }

  return { osm_id: vote.osm_id, name, success: true, reason: '' };
}

import { TOP_CITIES } from './gdebenz-client.mjs';

const BASE_URL = 'https://map.benzin-status.tech';

export const BENZIN_FUEL_GRADES = ['92', '95', '98', '100', 'ДТ', 'ГАЗ'];
export const BENZIN_DISPLAY_STATUSES = ['available', 'limited', 'unavailable', 'queue', 'none'];
export const BENZIN_STATUSES = ['available', 'limited', 'none'];

export const BENZIN_DISPLAY_LABELS_EN = {
  available: 'Fuel Available',
  limited: 'Limited',
  unavailable: 'No Fuel',
  queue: 'Queue',
  none: 'No Reports',
};

export const BENZIN_STATUS_LABELS_EN = {
  available: 'Fuel Available',
  limited: 'Limited',
  none: 'No Fuel',
};

const FUEL_MAP = {
  ai92: '92',
  ai95: '95',
  ai98: '98',
  ai100: '100',
  dt: 'ДТ',
  gas: 'ГАЗ',
};
const FUEL_MAP_REVERSE = Object.fromEntries(Object.entries(FUEL_MAP).map(([key, value]) => [value, key]));

export class BenzinUnavailableError extends Error {
  constructor(cause) {
    const detail = cause?.message || String(cause || 'request failed');
    super(`Could not reach Benzin-Status. Please try again in a moment. (${detail})`);
    this.name = 'BenzinUnavailableError';
    this.cause = cause;
  }
}

export function isBenzinUnavailableError(error) {
  return error instanceof BenzinUnavailableError;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intOrZero(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tsToString(tsMs) {
  if (!tsMs) return '';
  return new Date(Number(tsMs)).toISOString().replace('T', ' ').slice(0, 19);
}

function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function statusColor(status) {
  return {
    available: '#30D56B',
    limited: '#FFC400',
    unavailable: '#FF4D5A',
    queue: '#FF7A1A',
    none: '#8A94A6',
  }[status] || '#8A94A6';
}

export function getBenzinConfigPayload() {
  return {
    fuel_grades: BENZIN_FUEL_GRADES,
    statuses: Object.entries(BENZIN_STATUS_LABELS_EN).map(([value, label]) => ({
      value,
      label,
      color: statusColor(value),
    })),
    cities: TOP_CITIES,
    brands: [],
    comment_templates: { positive: [], negative: [] },
  };
}

function resolveBenzinCoords(options = {}) {
  if (Number.isFinite(options.lat) && Number.isFinite(options.lon)) {
    return { lat: options.lat, lon: options.lon };
  }
  if (options.city) {
    const city = TOP_CITIES.find((candidate) => (
      candidate.name.toLowerCase() === String(options.city).toLowerCase()
      || candidate.name_ru.toLowerCase() === String(options.city).toLowerCase()
    ));
    if (city) return { lat: city.lat, lon: city.lon };
  }
  return { lat: 55.75, lon: 37.62 };
}

function buildBbox(lat, lon, radiusKm) {
  const deltaLat = radiusKm / 111;
  const cosLat = Math.max(0.01, Math.cos(lat * Math.PI / 180));
  const deltaLon = radiusKm / (111 * cosLat);
  return `${(lat - deltaLat).toFixed(6)},${(lon - deltaLon).toFixed(6)},${(lat + deltaLat).toFixed(6)},${(lon + deltaLon).toFixed(6)}`;
}

async function fetchBenzinJson(path, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        referer: 'https://map.benzin-status.tech/',
        accept: 'application/json',
        'user-agent': 'gdebenz-netlify/1.0',
        'x-device-id': 'netbenza-netlify',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new BenzinUnavailableError(error);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    if (response.status >= 500 || response.status === 429) {
      throw new BenzinUnavailableError(new Error(detail || response.statusText));
    }
    throw new Error(detail || response.statusText);
  }
  return response.json();
}

function parseBenzinStation(raw = {}, center = null) {
  const lat = numberOrZero(raw.lat);
  const lon = numberOrZero(raw.lng);
  const status = raw.status || 'none';
  const fuelList = (Array.isArray(raw.fuelTypes) ? raw.fuelTypes : []).map(fuel => FUEL_MAP[fuel] || fuel);

  return {
    osm_id: String(raw.id || ''),
    name: raw.name || 'Gas Station',
    brand: raw.brand || '',
    addr: raw.address || '',
    lat,
    lon,
    status,
    status_label: BENZIN_DISPLAY_LABELS_EN[status] || status,
    fuels_now: fuelList.join(', '),
    fuel_list: fuelList,
    confirmations: 1,
    distance_km: center ? haversine(center.lat, center.lon, lat, lon) : 0,
    last_at: tsToString(raw.lastReportAt),
  };
}

function filterBenzinStations(stations, options = {}) {
  const fuelTypes = options.fuelTypes || null;
  const statuses = options.statuses || null;
  const brand = (options.brand || '').toLowerCase();

  return stations.filter((station) => {
    if (statuses?.length && !statuses.includes(station.status)) return false;
    if (fuelTypes?.length && !fuelTypes.some(fuel => station.fuel_list.includes(fuel))) return false;
    if (
      brand
      && !station.brand.toLowerCase().includes(brand)
      && !station.name.toLowerCase().includes(brand)
    ) {
      return false;
    }
    return true;
  });
}

function pagedBenzinResponse({ stations, filtered, center, offset = 0, limit = 20 }) {
  const safeLimit = Math.max(0, Number(limit) || 20);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const pageStations = safeLimit > 0 ? filtered.slice(safeOffset, safeOffset + safeLimit) : filtered;
  const pages = filtered.length > 0 && safeLimit > 0
    ? Math.max(1, Math.ceil(filtered.length / safeLimit))
    : 1;
  const summary = Object.fromEntries(BENZIN_DISPLAY_STATUSES.map(status => [
    status,
    filtered.filter(station => station.status === status).length,
  ]));

  return {
    center,
    summary,
    total: stations.length,
    filtered_total: filtered.length,
    page: safeLimit > 0 ? Math.floor(safeOffset / safeLimit) + 1 : 1,
    pages,
    stations: pageStations,
  };
}

async function getBenzinStations(options, fetchImpl = fetch) {
  const center = resolveBenzinCoords(options);
  const radius = Number.isFinite(options.radius) ? options.radius : 7;
  const params = new URLSearchParams({
    bbox: buildBbox(center.lat, center.lon, radius),
    limit: '200',
    offset: '0',
  });
  const data = await fetchBenzinJson(`/api/stations?${params.toString()}`, {}, fetchImpl);
  const rawStations = Array.isArray(data) ? data : (Array.isArray(data.stations) ? data.stations : []);
  return {
    center: { lat: center.lat, lon: center.lon, radius },
    stations: rawStations.map(raw => parseBenzinStation(raw, center)),
  };
}

export async function listBenzinStations(options, fetchImpl = fetch) {
  const { center, stations } = await getBenzinStations(options, fetchImpl);
  const filtered = filterBenzinStations(stations, options);
  return pagedBenzinResponse({
    stations,
    filtered,
    center,
    offset: options.offset,
    limit: options.limit,
  });
}

export async function allBenzinStationIds(options, fetchImpl = fetch) {
  const { stations } = await getBenzinStations(options, fetchImpl);
  const filtered = filterBenzinStations(stations, options);
  return {
    ids: filtered.map(station => station.osm_id),
    total: filtered.length,
  };
}

export async function submitBenzinReport({ stationId, status, fuelTypes = [] }, fetchImpl = fetch) {
  if (!BENZIN_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const body = {
    station_id: Number(stationId),
    status,
    fuel_types: fuelTypes.map(fuel => FUEL_MAP_REVERSE[fuel] || fuel),
    prices: {},
  };
  const response = await fetchBenzinJson('/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, fetchImpl);

  return {
    osm_id: String(stationId),
    name: `Station #${stationId}`,
    success: true,
    reason: response?.reason || '',
  };
}

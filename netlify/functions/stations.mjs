import {
  isGdeBenzUnavailableError,
  listStations,
  queryOptions,
} from './lib/gdebenz-client.mjs';
import { isBenzinUnavailableError, listBenzinStations } from './lib/benzin-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleStationsRequest(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const url = new URL(req.url);
  const query = queryOptions(url.searchParams);

  try {
    return jsonResponse(
      query.source === 'benzin'
        ? await listBenzinStations(query)
        : await listStations(query),
    );
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) || isBenzinUnavailableError(error) ? 502 : 400,
      error.message || 'Station lookup failed',
    );
  }
}

export default async function handler(req) {
  return handleStationsRequest(req);
}

export const config = { path: '/api/stations' };

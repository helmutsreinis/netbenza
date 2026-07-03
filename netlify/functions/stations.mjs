import {
  isGdeBenzUnavailableError,
  listStations,
  queryOptions,
} from './lib/gdebenz-client.mjs';
import { isBenzinUnavailableError, listBenzinStations } from './lib/benzin-client.mjs';
import { assertRequestAccess, getAccessGateStore } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req, accessStore = getAccessGateStore()) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  try {
    await assertRequestAccess(req, accessStore);
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const url = new URL(req.url);
  const options = queryOptions(url.searchParams);

  try {
    return jsonResponse(
      options.source === 'benzin'
        ? await listBenzinStations(options)
        : await listStations(options),
    );
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) || isBenzinUnavailableError(error) ? 502 : 400,
      error.message || 'Station lookup failed',
    );
  }
}

export const config = { path: '/api/stations' };

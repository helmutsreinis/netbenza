import {
  allStationIds,
  isGdeBenzUnavailableError,
  queryOptions,
} from './lib/gdebenz-client.mjs';
import { allBenzinStationIds, isBenzinUnavailableError } from './lib/benzin-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleStationIdsRequest(req, options = {}) {
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
        ? await allBenzinStationIds(query)
        : await allStationIds(query),
    );
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) || isBenzinUnavailableError(error) ? 502 : 400,
      error.message || 'Station lookup failed',
    );
  }
}

export default async function handler(req) {
  return handleStationIdsRequest(req);
}

export const config = { path: '/api/stations/ids' };

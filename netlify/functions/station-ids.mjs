import {
  allStationIds,
  isGdeBenzUnavailableError,
  queryOptions,
} from './lib/gdebenz-client.mjs';
import { allBenzinStationIds, isBenzinUnavailableError } from './lib/benzin-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(req.url);
  const options = queryOptions(url.searchParams);

  try {
    return jsonResponse(
      options.source === 'benzin'
        ? await allBenzinStationIds(options)
        : await allStationIds(options),
    );
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) || isBenzinUnavailableError(error) ? 502 : 400,
      error.message || 'Station lookup failed',
    );
  }
}

export const config = { path: '/api/stations/ids' };

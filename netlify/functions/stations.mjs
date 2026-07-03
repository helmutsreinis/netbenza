import {
  isGdeBenzUnavailableError,
  listStations,
  queryOptions,
} from './lib/gdebenz-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(req.url);

  try {
    return jsonResponse(await listStations(queryOptions(url.searchParams)));
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) ? 502 : 400,
      error.message || 'Station lookup failed',
    );
  }
}

export const config = { path: '/api/stations' };

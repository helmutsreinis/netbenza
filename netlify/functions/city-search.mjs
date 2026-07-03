import {
  isGdeBenzUnavailableError,
  searchCity,
} from './lib/gdebenz-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleCitySearchRequest(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || '';
  if (!q.trim()) return errorResponse(400, 'Missing city query');

  try {
    return jsonResponse({ results: await searchCity(q) });
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) ? 502 : 500,
      error.message || 'City search failed',
    );
  }
}

export default async function handler(req) {
  return handleCitySearchRequest(req);
}

export const config = { path: '/api/city/search' };

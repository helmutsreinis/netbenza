import {
  isGdeBenzUnavailableError,
  searchCity,
} from './lib/gdebenz-client.mjs';
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

export const config = { path: '/api/city/search' };

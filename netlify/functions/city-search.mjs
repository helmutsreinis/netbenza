import { searchCity } from './lib/gdebenz-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || '';
  if (!q.trim()) return errorResponse(400, 'Missing city query');

  try {
    return jsonResponse({ results: await searchCity(q) });
  } catch (error) {
    return errorResponse(500, error.message || 'City search failed');
  }
}

export const config = { path: '/api/city/search' };

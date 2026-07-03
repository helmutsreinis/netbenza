import { getConfigPayload } from './lib/gdebenz-client.mjs';
import { jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  return jsonResponse(getConfigPayload());
}

export const config = { path: '/api/config' };

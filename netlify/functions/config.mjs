import { getConfigPayload } from './lib/gdebenz-client.mjs';
import { getBenzinConfigPayload } from './lib/benzin-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleConfigRequest(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const url = new URL(req.url);
  return jsonResponse(
    url.searchParams.get('source') === 'benzin'
      ? getBenzinConfigPayload()
      : getConfigPayload(),
  );
}

export default async function handler(req) {
  return handleConfigRequest(req);
}

export const config = { path: '/api/config' };

import { getConfigPayload } from './lib/gdebenz-client.mjs';
import { getBenzinConfigPayload } from './lib/benzin-client.mjs';
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
  return jsonResponse(
    url.searchParams.get('source') === 'benzin'
      ? getBenzinConfigPayload()
      : getConfigPayload(),
  );
}

export const config = { path: '/api/config' };

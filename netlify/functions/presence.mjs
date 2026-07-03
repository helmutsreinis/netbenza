import { assertRequestAccess, getAccessGateStore } from './lib/access-gate-store.mjs';
import { errorResponse, methodNotAllowed } from './lib/http.mjs';
import { handlePresenceRequest } from './lib/presence-store.mjs';

export default async function handler(req, accessStore = getAccessGateStore()) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return methodNotAllowed(['GET', 'POST', 'DELETE']);
  try {
    await assertRequestAccess(req, accessStore);
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  return handlePresenceRequest(req);
}

export const config = { path: '/api/presence' };

import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, methodNotAllowed } from './lib/http.mjs';
import { handlePresenceRequest } from './lib/presence-store.mjs';

export async function handleProtectedPresenceRequest(req, options = {}) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return methodNotAllowed(['GET', 'POST', 'DELETE']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  return handlePresenceRequest(req, options.presenceStore, options.nowFn || Date.now);
}

export default async function handler(req) {
  return handleProtectedPresenceRequest(req);
}

export const config = { path: '/api/presence' };

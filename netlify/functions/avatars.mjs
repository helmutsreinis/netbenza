import { avatarList } from './lib/gdebenz-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleAvatarsRequest(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  return jsonResponse({ avatars: avatarList() });
}

export default async function handler(req) {
  return handleAvatarsRequest(req);
}

export const config = { path: '/api/avatars' };

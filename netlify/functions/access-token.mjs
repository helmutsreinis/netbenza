import {
  createAccessChallenge,
  getAccessGateStore,
  issueAccessToken,
  publicChallenge,
} from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';
import { requestIpKey } from './lib/request-context.mjs';

export async function handleAccessTokenRequest(req, options = {}) {
  const store = options.store || getAccessGateStore();
  const now = options.now || Date.now;

  if (req.method === 'GET') {
    const challenge = await createAccessChallenge(store, { now: now() });
    return jsonResponse(publicChallenge(challenge));
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    try {
      return jsonResponse(await issueAccessToken(store, {
        challengeId: body.challengeId,
        answers: body.answers || {},
        accessSessionId: body.accessSessionId,
        ipKey: requestIpKey(req),
        now: now(),
      }));
    } catch (error) {
      return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
    }
  }

  return methodNotAllowed(['GET', 'POST']);
}

export default async function handler(req) {
  return handleAccessTokenRequest(req);
}

export const config = { path: '/api/access-token' };

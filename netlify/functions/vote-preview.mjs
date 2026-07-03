import {
  isGdeBenzUnavailableError,
  queryOptions,
  votePreview,
} from './lib/gdebenz-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export async function handleVotePreviewRequest(req, options = {}) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const url = new URL(req.url);
  const query = queryOptions(url.searchParams);
  if (!url.searchParams.has('limit')) query.limit = 200;

  try {
    return jsonResponse(await votePreview(query));
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) ? 502 : 400,
      error.message || 'Vote preview failed',
    );
  }
}

export default async function handler(req) {
  return handleVotePreviewRequest(req);
}

export const config = { path: '/api/vote/preview' };

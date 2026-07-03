import {
  isGdeBenzUnavailableError,
  queryOptions,
  votePreview,
} from './lib/gdebenz-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const url = new URL(req.url);
  const options = queryOptions(url.searchParams);
  if (!url.searchParams.has('limit')) options.limit = 200;

  try {
    return jsonResponse(await votePreview(options));
  } catch (error) {
    return errorResponse(
      isGdeBenzUnavailableError(error) ? 502 : 400,
      error.message || 'Vote preview failed',
    );
  }
}

export const config = { path: '/api/vote/preview' };

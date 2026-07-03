import { getConfigPayload } from './lib/gdebenz-client.mjs';
import { getBenzinConfigPayload } from './lib/benzin-client.mjs';
import { jsonResponse, methodNotAllowed } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(req.url);
  return jsonResponse(
    url.searchParams.get('source') === 'benzin'
      ? getBenzinConfigPayload()
      : getConfigPayload(),
  );
}

export const config = { path: '/api/config' };

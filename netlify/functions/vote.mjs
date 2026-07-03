import { STATUSES, resolveCoords, submitVote } from './lib/gdebenz-client.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';

export default async function handler(req) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const body = await readJson(req);

  if (!STATUSES.includes(body.vote_status)) {
    return errorResponse(400, `Invalid status: ${body.vote_status}`);
  }
  if (!Array.isArray(body.osm_ids)) {
    return errorResponse(400, 'osm_ids must be an array');
  }

  let voterCoords = { lat: 0, lon: 0 };
  if (body.city || (body.lat && body.lon)) {
    voterCoords = await resolveCoords({
      city: body.city,
      lat: Number(body.lat),
      lon: Number(body.lon),
    }).catch(() => ({ lat: 0, lon: 0 }));
  }

  const results = [];
  for (const osmId of body.osm_ids) {
    try {
      results.push(await submitVote({
        osm_id: String(osmId),
        status: body.vote_status,
        text: body.text || '',
        vlat: voterCoords.lat,
        vlon: voterCoords.lon,
        fingerprint: body.fingerprint || '',
      }));
    } catch (error) {
      results.push({
        osm_id: String(osmId),
        name: '',
        success: false,
        reason: error.message || 'Vote failed',
      });
    }
  }

  return jsonResponse(results);
}

export const config = { path: '/api/vote' };

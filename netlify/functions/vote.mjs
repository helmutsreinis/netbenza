import { STATUSES, resolveCoords, submitVote } from './lib/gdebenz-client.mjs';
import { BENZIN_STATUSES, submitBenzinReport } from './lib/benzin-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';

export async function handleVoteRequest(req, options = {}) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: options.now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const body = await readJson(req);
  const source = body.source || 'gdebenz';

  if (source === 'benzin') {
    if (!BENZIN_STATUSES.includes(body.vote_status)) {
      return errorResponse(400, `Invalid status: ${body.vote_status}`);
    }
    if (!Array.isArray(body.osm_ids)) {
      return errorResponse(400, 'osm_ids must be an array');
    }
    const results = [];
    for (const osmId of body.osm_ids) {
      try {
        results.push(await submitBenzinReport({
          stationId: String(osmId),
          status: body.vote_status,
        }));
      } catch (error) {
        results.push({
          osm_id: String(osmId),
          name: `Station #${osmId}`,
          success: false,
          reason: error.message || 'Vote failed',
        });
      }
    }
    return jsonResponse(results);
  }

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

export default async function handler(req) {
  return handleVoteRequest(req);
}

export const config = { path: '/api/vote' };

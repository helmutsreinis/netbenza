import { STATUSES, resolveCoords, submitVote } from './lib/gdebenz-client.mjs';
import { BENZIN_STATUSES, submitBenzinReport } from './lib/benzin-client.mjs';
import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { assertActiveSession, getPresenceStore, presenceSnapshot } from './lib/presence-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';
import { requestIpKey } from './lib/request-context.mjs';
import { getVoteQueueStore, runQueuedVote } from './lib/vote-queue-store.mjs';

function optionNowFn(options = {}) {
  if (typeof options.nowFn === 'function') return options.nowFn;
  if (typeof options.now === 'function') return options.now;
  if (options.now !== undefined) return () => options.now;
  return Date.now;
}

function currentNow(options, nowFn) {
  if (typeof options.now === 'function') return options.now();
  if (options.now !== undefined) return options.now;
  return nowFn();
}

function voteIdentity(req, body = {}) {
  return {
    clientId: body.clientId,
    sessionId: body.sessionId,
    ipKey: requestIpKey(req),
  };
}

async function assertVoteSession(req, body, options, nowFn) {
  const identity = voteIdentity(req, body);
  const presenceStore = options.presenceStore || getPresenceStore();
  const now = currentNow(options, nowFn);
  await assertActiveSession(presenceStore, identity, now);
  const snapshot = await presenceSnapshot(presenceStore, now, identity);
  const activeUser = (snapshot.users || []).find((user) => user.clientId === identity.clientId);
  return {
    ...identity,
    handle: activeUser?.handle || 'Anonymous',
    avatar: activeUser?.avatar || '',
  };
}

const QUEUE_ROUTE_ERROR_CODES = new Set([
  'client_active',
  'clientId_required',
  'id_required',
  'ip_active',
  'ipKey_required',
  'queue_entry_invalid',
  'queue_entry_missing',
  'queue_wait_timeout',
  'sessionId_required',
  'stationId_required',
  'status_required',
  'submit_required',
]);

function queueRouteErrorResponse(error) {
  const status = Number(error?.status);
  const code = String(error?.code || error?.message || '');
  if (!Number.isInteger(status) || status < 400 || !QUEUE_ROUTE_ERROR_CODES.has(code)) return null;
  return errorResponse(status, code || 'vote_queue_failed');
}

export async function handleVoteRequest(req, options = {}) {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const nowFn = optionNowFn(options);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now: currentNow(options, nowFn) });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }
  const body = await readJson(req);
  const source = body.source || 'gdebenz';
  const queueStore = options.queueStore || getVoteQueueStore();
  const queueOptions = {
    queueStore,
    nowFn,
    sleep: options.sleep || options.sleepFn,
    maxWaitMs: options.maxWaitMs,
  };

  if (source === 'benzin') {
    if (!BENZIN_STATUSES.includes(body.vote_status)) {
      return errorResponse(400, `Invalid status: ${body.vote_status}`);
    }
    if (!Array.isArray(body.osm_ids)) {
      return errorResponse(400, 'osm_ids must be an array');
    }
    let identity;
    try {
      identity = await assertVoteSession(req, body, options, nowFn);
    } catch (error) {
      return errorResponse(error.status || 409, error.code || error.message || 'inactive_session');
    }
    const results = [];
    for (const osmId of body.osm_ids) {
      const stationId = String(osmId);
      try {
        results.push(await runQueuedVote({
          ...queueOptions,
          identity,
          vote: {
            source: 'benzin',
            stationId,
            status: body.vote_status,
          },
          submit: async (vote) => submitBenzinReport({
            stationId: vote.stationId,
            status: vote.status,
          }),
        }));
      } catch (error) {
        const routeError = queueRouteErrorResponse(error);
        if (routeError) return routeError;
        results.push({
          osm_id: stationId,
          name: `Station #${stationId}`,
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
  let identity;
  try {
    identity = await assertVoteSession(req, body, options, nowFn);
  } catch (error) {
    return errorResponse(error.status || 409, error.code || error.message || 'inactive_session');
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
    const stationId = String(osmId);
    try {
      results.push(await runQueuedVote({
        ...queueOptions,
        identity,
        vote: {
          source: 'gdebenz',
          osm_id: stationId,
          status: body.vote_status,
          text: body.text || '',
          vlat: voterCoords.lat,
          vlon: voterCoords.lon,
          fingerprint: body.fingerprint || '',
        },
        submit: async (vote) => submitVote(vote),
      }));
    } catch (error) {
      const routeError = queueRouteErrorResponse(error);
      if (routeError) return routeError;
      results.push({
        osm_id: stationId,
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

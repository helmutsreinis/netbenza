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

function safeRouteErrorDetail(error) {
  const detail = String(error?.code || error?.message || 'vote_queue_failed');
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail) ? detail : 'vote_queue_failed';
}

function queueRouteErrorResponse(error) {
  const status = Number(error?.status);
  const responseStatus = Number.isInteger(status) && status >= 400 ? status : 503;
  return errorResponse(responseStatus, safeRouteErrorDetail(error));
}

async function submitBenzinVoteResult(vote) {
  try {
    return await submitBenzinReport({
      stationId: vote.stationId,
      status: vote.status,
    });
  } catch (error) {
    return {
      osm_id: String(vote.stationId),
      name: `Station #${vote.stationId}`,
      success: false,
      reason: error.message || 'Vote failed',
    };
  }
}

async function submitGdeBenzVoteResult(vote) {
  try {
    return await submitVote(vote);
  } catch (error) {
    return {
      osm_id: String(vote.osm_id),
      name: '',
      success: false,
      reason: error.message || 'Vote failed',
    };
  }
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
          submit: submitBenzinVoteResult,
        }));
      } catch (error) {
        return queueRouteErrorResponse(error);
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
        submit: submitGdeBenzVoteResult,
      }));
    } catch (error) {
      return queueRouteErrorResponse(error);
    }
  }

  return jsonResponse(results);
}

export default async function handler(req) {
  return handleVoteRequest(req);
}

export const config = { path: '/api/vote' };

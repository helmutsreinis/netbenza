import { assertRequestAccess } from './lib/access-gate-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed } from './lib/http.mjs';
import {
  getVoteQueueStore,
  publicQueueSnapshot,
  readQueueState,
} from './lib/vote-queue-store.mjs';

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

function safeRouteErrorDetail(error) {
  const detail = String(error?.code || error?.message || 'vote_queue_failed');
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail) ? detail : 'vote_queue_failed';
}

function queueRouteErrorResponse(error) {
  const status = Number(error?.status);
  const responseStatus = Number.isInteger(status) && status >= 400 ? status : 503;
  return errorResponse(responseStatus, safeRouteErrorDetail(error));
}

export async function handleVoteQueueRequest(req, options = {}) {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);

  const nowFn = optionNowFn(options);
  const now = currentNow(options, nowFn);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }

  const queueStore = options.queueStore || getVoteQueueStore();
  try {
    const state = await readQueueState(queueStore, now);
    return jsonResponse(publicQueueSnapshot(state, now));
  } catch (error) {
    return queueRouteErrorResponse(error);
  }
}

export default async function handler(req) {
  return handleVoteQueueRequest(req);
}

export const config = { path: '/api/vote/queue' };

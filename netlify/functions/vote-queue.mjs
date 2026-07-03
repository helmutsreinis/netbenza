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
  const state = await readQueueState(queueStore, now);
  return jsonResponse(publicQueueSnapshot(state, now));
}

export default async function handler(req) {
  return handleVoteQueueRequest(req);
}

export const config = { path: '/api/vote/queue' };

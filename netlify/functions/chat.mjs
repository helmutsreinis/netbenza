import { assertRequestAccess } from './lib/access-gate-store.mjs';
import {
  assertActiveSession,
  getPresenceStore,
  presenceSnapshot,
} from './lib/presence-store.mjs';
import { errorResponse, jsonResponse, methodNotAllowed, readJson } from './lib/http.mjs';
import { requestIpKey } from './lib/request-context.mjs';
import {
  appendChatMessage,
  getChatStore,
  normalizeChatText,
  publicChatSnapshot,
  readChatState,
} from './lib/chat-store.mjs';

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

function chatIdentity(req, body = {}) {
  return {
    clientId: body.clientId,
    sessionId: body.sessionId,
    ipKey: requestIpKey(req),
  };
}

async function activeChatIdentity(req, body, options, now) {
  const identity = chatIdentity(req, body);
  const presenceStore = options.presenceStore || getPresenceStore();
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
  const detail = String(error?.code || error?.message || 'chat_failed');
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail) ? detail : 'chat_failed';
}

function chatRouteErrorResponse(error) {
  const status = Number(error?.status);
  const responseStatus = Number.isInteger(status) && status >= 400 ? status : 503;
  return errorResponse(responseStatus, safeRouteErrorDetail(error));
}

export async function handleChatRequest(req, options = {}) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(['GET', 'POST']);

  const nowFn = optionNowFn(options);
  const now = currentNow(options, nowFn);
  try {
    await assertRequestAccess(req, { accessStore: options.accessStore, now });
  } catch (error) {
    return errorResponse(error.status || 401, error.code || error.message || 'access_denied');
  }

  const chatStore = options.chatStore || getChatStore();
  if (req.method === 'GET') {
    try {
      return jsonResponse(publicChatSnapshot(await readChatState(chatStore), now));
    } catch (error) {
      return chatRouteErrorResponse(error);
    }
  }

  const body = await readJson(req);
  const text = normalizeChatText(body.text);
  if (!text) return errorResponse(400, 'chat_text_required');

  let identity;
  try {
    identity = await activeChatIdentity(req, body, options, now);
  } catch (error) {
    return errorResponse(error.status || 409, error.code || error.message || 'inactive_session');
  }

  try {
    const state = await appendChatMessage(chatStore, identity, text, now, options.id);
    return jsonResponse(publicChatSnapshot(state, now));
  } catch (error) {
    return chatRouteErrorResponse(error);
  }
}

export default async function handler(req) {
  return handleChatRequest(req);
}

export const config = { path: '/api/chat' };

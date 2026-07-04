import { randomUUID } from 'node:crypto';

import { getStore } from '@netlify/blobs';

export const CHAT_MAX_MESSAGES = 10;
export const CHAT_MAX_TEXT_LENGTH = 240;
export const CHAT_RATE_LIMIT_MAX_MESSAGES = 2;
export const CHAT_RATE_LIMIT_WINDOW_MS = 60_000;
export const CHAT_RATE_LIMIT_MAX_WARNINGS = 3;
export const CHAT_RATE_LIMIT_BAN_MS = 10 * 60_000;

const CHAT_STATE_KEY = 'chat/state';
const CHAT_RATE_LIMIT_TTL_MS = CHAT_RATE_LIMIT_BAN_MS;

export function getChatStore() {
  return getStore({ name: 'gdebenz-chat', consistency: 'strong' });
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultChatState() {
  return { messages: [], rateLimits: {} };
}

function clippedString(value, max = CHAT_MAX_TEXT_LENGTH) {
  return String(value || '').trim().slice(0, max);
}

function requiredString(value, field) {
  const normalized = clippedString(value, 240);
  if (!normalized) {
    const error = new Error(`${field}_required`);
    error.code = `${field}_required`;
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeTimestamp(value) {
  const timestamp = Math.trunc(Number(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function chatError(code, status = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  Object.assign(error, details);
  return error;
}

export function normalizeChatText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_TEXT_LENGTH)
    .trim();
}

function normalizeMessage(message) {
  if (!message?.id || !message?.clientId) return null;
  const text = normalizeChatText(message.text);
  if (!text) return null;
  return {
    id: clippedString(message.id, 120),
    clientId: clippedString(message.clientId, 120),
    sessionId: clippedString(message.sessionId, 160),
    ipKey: clippedString(message.ipKey, 180),
    handle: clippedString(message.handle, 32) || 'Anonymous',
    avatar: clippedString(message.avatar, 240),
    text,
    createdAt: normalizeTimestamp(message.createdAt),
  };
}

function sessionRateLimitKey(identity = {}) {
  const clientId = clippedString(identity.clientId, 120);
  const sessionId = clippedString(identity.sessionId, 160);
  if (!clientId || !sessionId) return '';
  return `${clientId}:${sessionId}`;
}

function normalizeRateLimitRecord(record, now = Date.now()) {
  const currentTime = normalizeTimestamp(now) || Date.now();
  const bannedUntil = normalizeTimestamp(record?.bannedUntil);
  const timestamps = Array.isArray(record?.timestamps)
    ? record.timestamps
      .map(normalizeTimestamp)
      .filter((timestamp) => timestamp && currentTime - timestamp < CHAT_RATE_LIMIT_WINDOW_MS)
      .sort((left, right) => left - right)
    : [];
  const lastTouched = normalizeTimestamp(record?.lastTouched)
    || Math.max(0, bannedUntil, timestamps.at(-1) || 0);
  const activeBan = bannedUntil > currentTime;
  const expiredBan = Boolean(bannedUntil && !activeBan);
  const warnings = expiredBan
    ? 0
    : Math.max(0, Math.trunc(Number(record?.warnings || 0)) || 0);

  if (!activeBan && !timestamps.length && currentTime - lastTouched > CHAT_RATE_LIMIT_TTL_MS) {
    return null;
  }

  return {
    timestamps,
    warnings,
    bannedUntil: activeBan ? bannedUntil : 0,
    lastTouched,
  };
}

function normalizeRateLimits(rateLimits = {}, now = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return {};
  return Object.fromEntries(Object.entries(rateLimits)
    .map(([key, record]) => {
      const normalizedKey = clippedString(key, 300);
      const normalizedRecord = normalizeRateLimitRecord(record, now);
      return normalizedKey && normalizedRecord ? [normalizedKey, normalizedRecord] : null;
    })
    .filter(Boolean));
}

function rateLimitError(record, now) {
  const oldest = record.timestamps[0] || now;
  const retryAfterMs = Math.max(1, oldest + CHAT_RATE_LIMIT_WINDOW_MS - now);
  return chatError('chat_rate_limited', 429, {
    warnings: record.warnings,
    warningsRemaining: Math.max(0, CHAT_RATE_LIMIT_MAX_WARNINGS - record.warnings),
    retryAfterMs,
    limit: CHAT_RATE_LIMIT_MAX_MESSAGES,
    windowMs: CHAT_RATE_LIMIT_WINDOW_MS,
  });
}

function bannedError(record, now) {
  return chatError('chat_banned', 429, {
    warnings: record.warnings,
    warningsRemaining: 0,
    bannedUntil: record.bannedUntil,
    retryAfterMs: Math.max(1, record.bannedUntil - now),
    limit: CHAT_RATE_LIMIT_MAX_MESSAGES,
    windowMs: CHAT_RATE_LIMIT_WINDOW_MS,
  });
}

function assertWithinChatRateLimit(state, message, now = Date.now()) {
  const currentTime = normalizeTimestamp(now) || Date.now();
  const key = sessionRateLimitKey(message);
  if (!key) throw chatError('sessionId_required', 400);

  state.rateLimits = normalizeRateLimits(state.rateLimits, currentTime);
  const record = state.rateLimits[key] || {
    timestamps: [],
    warnings: 0,
    bannedUntil: 0,
    lastTouched: currentTime,
  };

  if (record.bannedUntil > currentTime) {
    record.lastTouched = currentTime;
    state.rateLimits[key] = record;
    throw bannedError(record, currentTime);
  }

  record.bannedUntil = 0;
  record.timestamps = record.timestamps
    .filter((timestamp) => currentTime - timestamp < CHAT_RATE_LIMIT_WINDOW_MS)
    .sort((left, right) => left - right);
  record.lastTouched = currentTime;

  if (record.timestamps.length >= CHAT_RATE_LIMIT_MAX_MESSAGES) {
    if (record.warnings >= CHAT_RATE_LIMIT_MAX_WARNINGS) {
      record.bannedUntil = currentTime + CHAT_RATE_LIMIT_BAN_MS;
      state.rateLimits[key] = record;
      throw bannedError(record, currentTime);
    }
    record.warnings += 1;
    state.rateLimits[key] = record;
    throw rateLimitError(record, currentTime);
  }

  record.timestamps.push(currentTime);
  state.rateLimits[key] = record;
}

function normalizeState(state, now = Date.now()) {
  const messages = Array.isArray(state?.messages)
    ? state.messages.map(normalizeMessage).filter(Boolean)
    : [];
  return {
    messages: messages.slice(-CHAT_MAX_MESSAGES),
    rateLimits: normalizeRateLimits(state?.rateLimits || {}, now),
  };
}

async function writeChatState(store, state, now = Date.now()) {
  const normalized = normalizeState(state, now);
  await store.setJSON(CHAT_STATE_KEY, normalized);
  return normalized;
}

export async function readChatState(store = getChatStore(), now = Date.now()) {
  const state = await store.get(CHAT_STATE_KEY, { type: 'json' });
  if (!state) return defaultChatState();
  return normalizeState(state, now);
}

export function createChatMessage({
  identity = {},
  text,
  now = Date.now(),
  id = randomUUID(),
} = {}) {
  const normalizedText = normalizeChatText(text);
  if (!normalizedText) throw chatError('chat_text_required', 400);

  return {
    id: requiredString(id, 'id'),
    clientId: requiredString(identity.clientId, 'clientId'),
    sessionId: requiredString(identity.sessionId, 'sessionId'),
    ipKey: requiredString(identity.ipKey, 'ipKey'),
    handle: clippedString(identity.handle, 32) || 'Anonymous',
    avatar: clippedString(identity.avatar, 240),
    text: normalizedText,
    createdAt: normalizeTimestamp(now) || Date.now(),
  };
}

export async function appendChatMessage(
  store = getChatStore(),
  identity = {},
  text = '',
  now = Date.now(),
  id = randomUUID(),
) {
  const message = createChatMessage({ identity, text, now, id });
  const state = await readChatState(store, now);
  try {
    assertWithinChatRateLimit(state, message, now);
  } catch (error) {
    await writeChatState(store, state, now);
    throw error;
  }
  state.messages.push(message);
  return writeChatState(store, state, now);
}

function publicMessage(message) {
  return {
    id: message.id,
    clientId: message.clientId,
    handle: message.handle,
    avatar: message.avatar,
    text: message.text,
    createdAt: message.createdAt,
  };
}

export function publicChatSnapshot(state = defaultChatState(), now = Date.now()) {
  const normalized = normalizeState(state);
  return {
    messages: clone(normalized.messages.map(publicMessage)),
    serverTime: normalizeTimestamp(now) || Date.now(),
  };
}

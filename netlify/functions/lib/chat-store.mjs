import { randomUUID } from 'node:crypto';

import { getStore } from '@netlify/blobs';

export const CHAT_MAX_MESSAGES = 10;
export const CHAT_MAX_TEXT_LENGTH = 240;

const CHAT_STATE_KEY = 'chat/state';

export function getChatStore() {
  return getStore({ name: 'gdebenz-chat', consistency: 'strong' });
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultChatState() {
  return { messages: [] };
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

function chatError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
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

function normalizeState(state) {
  const messages = Array.isArray(state?.messages)
    ? state.messages.map(normalizeMessage).filter(Boolean)
    : [];
  return {
    messages: messages.slice(-CHAT_MAX_MESSAGES),
  };
}

async function writeChatState(store, state) {
  const normalized = normalizeState(state);
  await store.setJSON(CHAT_STATE_KEY, normalized);
  return normalized;
}

export async function readChatState(store = getChatStore()) {
  const state = await store.get(CHAT_STATE_KEY, { type: 'json' });
  if (!state) return defaultChatState();
  return normalizeState(state);
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
    sessionId: clippedString(identity.sessionId, 160),
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
  const state = await readChatState(store);
  state.messages.push(message);
  return writeChatState(store, state);
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

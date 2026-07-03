import { randomBytes, randomUUID } from 'node:crypto';

import { getStore } from '@netlify/blobs';

import { requestIpKey } from './request-context.mjs';

export const ACCESS_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
export const ACCESS_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const ACCESS_QUESTION_BANK = [
  { id: 'crimea-ukraine', prompt: 'Is Crimea part of Ukraine?', correct: true },
  { id: 'ukraine-black-sea', prompt: 'Does Ukraine border the Black Sea?', correct: true },
  { id: 'ukraine-largest-europe', prompt: 'Is Ukraine the largest country entirely within Europe by area?', correct: true },
  { id: 'dnipro-longest', prompt: 'Is the Dnipro the longest river that flows through Ukraine?', correct: true },
  { id: 'ukraine-slovakia', prompt: 'Does Ukraine share a border with Slovakia?', correct: true },
  { id: 'hoverla-highest', prompt: 'Is Mount Hoverla the highest peak in Ukraine?', correct: true },
  { id: 'ukraine-baltic-sea', prompt: 'Does Ukraine border the Baltic Sea?', correct: false },
  { id: 'odesa-port', prompt: 'Is Odesa a major Ukrainian port city on the Black Sea?', correct: true },
  { id: 'carpathians-ukraine', prompt: 'Are the Carpathian Mountains partly located in Ukraine?', correct: true },
  { id: 'full-scale-invasion', prompt: 'Did Russia launch a full-scale invasion of Ukraine on February 24, 2022?', correct: true },
  { id: 'zelenskyy-president', prompt: 'Is Volodymyr Zelenskyy the President of Ukraine?', correct: true },
  { id: 'ukraine-eu-application', prompt: 'Did Ukraine apply for EU membership after the 2022 invasion?', correct: true },
  { id: 'borscht', prompt: 'Is borscht a traditional Ukrainian dish?', correct: true },
  { id: 'ukrainian-cyrillic', prompt: 'Is the Ukrainian language written in the Cyrillic alphabet?', correct: true },
  { id: 'vyshyvanka', prompt: 'Are vyshyvanka traditional Ukrainian embroidered shirts?', correct: true },
  { id: 'shevchenko', prompt: "Is Taras Shevchenko considered Ukraine's national poet?", correct: true },
  { id: 'sunflower-oil', prompt: "Is Ukraine one of the world's largest exporters of sunflower oil?", correct: true },
  { id: 'breadbasket', prompt: 'Was Ukraine known as the "breadbasket of Europe" due to its fertile black soil?', correct: true },
  { id: 'mriya', prompt: "Is the Antonov An-225 Mriya, destroyed in 2022, the world's heaviest aircraft ever built and was it Ukrainian?", correct: true },
  { id: 'arsenalna', prompt: "Is Kyiv's Arsenalna metro station one of the deepest metro stations in the world?", correct: true },
  { id: 'klitschko', prompt: 'Did Ukrainian boxers Vitali and Wladimir Klitschko both become world heavyweight champions?', correct: true },
  { id: 'riga-capital', prompt: 'Is Riga the capital of Latvia?', correct: true },
  { id: 'latvia-baltic-state', prompt: 'Is Latvia one of the three Baltic states?', correct: true },
  { id: 'latvia-baltic-sea', prompt: 'Does Latvia border the Baltic Sea?', correct: true },
  { id: 'latvia-ukraine-border', prompt: 'Does Latvia share a land border with Ukraine?', correct: false },
  { id: 'latvian-flag', prompt: 'Is the Latvian flag carmine red with a white horizontal stripe?', correct: true },
  { id: 'latvian-latin', prompt: 'Is Latvian written with the Latin alphabet?', correct: true },
  { id: 'latvia-euro', prompt: 'Does Latvia use the euro?', correct: true },
  { id: 'latvia-eu-nato', prompt: 'Is Latvia a member of the European Union and NATO?', correct: true },
  { id: 'latvia-russia-border', prompt: 'Does Latvia share a land border with Russia?', correct: true },
  { id: 'daugava-riga', prompt: 'Is Daugava the river that flows through Riga?', correct: true },
  { id: 'song-dance', prompt: "Is Latvian Song and Dance Celebration part of Latvia's major cultural heritage?", correct: true },
];

export class MemoryAccessGateStore {
  constructor() {
    this.records = new Map();
  }

  async setJSON(key, value) {
    this.records.set(key, structuredClone(value));
    return { modified: true, etag: `"${key}"` };
  }

  async get(key, options = {}) {
    const value = this.records.get(key);
    if (value === undefined) return null;
    if (options.type === 'json') return structuredClone(value);
    return JSON.stringify(value);
  }

  async delete(key) {
    this.records.delete(key);
  }
}

export function getAccessGateStore() {
  return getStore({ name: 'gdebenz-access-gate', consistency: 'strong' });
}

function shuffledCopy(items, rng = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function opaqueId(prefix) {
  const id = typeof randomUUID === 'function'
    ? randomUUID()
    : randomBytes(16).toString('hex');
  return `${prefix}_${id}`;
}

function tokenId() {
  return randomBytes(32).toString('base64url');
}

function accessError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

export async function createAccessChallenge(store, options = {}) {
  const now = options.now ?? Date.now();
  const rng = options.rng || Math.random;
  const challengeId = options.challengeId || opaqueId('challenge');
  const questions = shuffledCopy(ACCESS_QUESTION_BANK, rng).slice(0, 3).map((question) => ({
    ...question,
    answers: shuffledCopy([
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ], rng),
  }));
  const challenge = {
    challengeId,
    issuedAt: now,
    expiresAt: now + ACCESS_CHALLENGE_TTL_MS,
    questions,
  };

  await store.setJSON(`challenges/${challengeId}`, challenge);
  return challenge;
}

export function publicChallenge(challenge) {
  return {
    challengeId: challenge.challengeId,
    questions: (challenge.questions || []).map((question) => ({
      id: question.id,
      prompt: question.prompt,
      answers: question.answers,
    })),
  };
}

export function validateAccessAnswers(challenge, answers = {}) {
  return Array.isArray(challenge?.questions)
    && challenge.questions.length === 3
    && challenge.questions.every((question) => answers[question.id] === question.correct);
}

export async function issueAccessToken(store, options = {}) {
  const now = options.now ?? Date.now();
  const { challengeId, answers, accessSessionId, ipKey } = options;
  if (!accessSessionId) throw accessError(400, 'access_session_missing');

  const challenge = challengeId
    ? await store.get(`challenges/${challengeId}`, { type: 'json' }).catch(() => null)
    : null;
  if (!challenge) throw accessError(401, 'access_challenge_invalid');
  if (Number(challenge.expiresAt) <= now) {
    await store.delete(`challenges/${challengeId}`).catch(() => {});
    throw accessError(401, 'access_challenge_expired');
  }
  if (!validateAccessAnswers(challenge, answers)) {
    throw accessError(401, 'access_answers_invalid');
  }

  const accessToken = options.accessToken || tokenId();
  const token = {
    accessToken,
    accessSessionId,
    ipKey: ipKey || 'ip:local',
    issuedAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
  };

  await store.setJSON(`tokens/${accessToken}`, token);
  await store.delete(`challenges/${challengeId}`).catch(() => {});
  return { accessToken, expiresAt: token.expiresAt };
}

export async function assertAccessToken(store, options = {}) {
  const now = options.now ?? Date.now();
  const { accessToken, accessSessionId, ipKey } = options;
  if (!accessToken) throw accessError(401, 'access_token_missing');
  if (!accessSessionId) throw accessError(401, 'access_session_missing');

  const token = await store.get(`tokens/${accessToken}`, { type: 'json' }).catch(() => null);
  if (!token) throw accessError(401, 'access_token_invalid');
  if (Number(token.expiresAt) <= now) {
    await store.delete(`tokens/${accessToken}`).catch(() => {});
    throw accessError(401, 'access_token_expired');
  }
  if (token.accessSessionId !== accessSessionId) {
    throw accessError(401, 'access_session_mismatch');
  }
  if (token.ipKey !== ipKey) {
    throw accessError(401, 'access_ip_mismatch');
  }

  return token;
}

export async function assertRequestAccess(req, options = {}) {
  const url = new URL(req.url);
  const accessToken = req.headers.get('x-access-token') || url.searchParams.get('accessToken');
  const accessSessionId = req.headers.get('x-access-session') || url.searchParams.get('accessSessionId');
  const now = options.now ?? options.nowFn?.() ?? Date.now();
  const tokenOptions = {
    accessToken,
    accessSessionId,
    ipKey: requestIpKey(req),
    now,
  };
  if (!accessToken || !accessSessionId) return assertAccessToken(null, tokenOptions);
  const store = options.accessStore || options.store || getAccessGateStore();
  return assertAccessToken(store, {
    ...tokenOptions,
  });
}

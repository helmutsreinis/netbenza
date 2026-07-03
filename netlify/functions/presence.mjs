import { handlePresenceRequest } from './lib/presence-store.mjs';

export default async function handler(req) {
  return handlePresenceRequest(req);
}

export const config = { path: '/api/presence' };

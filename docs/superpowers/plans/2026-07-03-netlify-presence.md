# Netlify Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully standalone Netlify deployment with avatar identity and temporary multi-user presence.

**Architecture:** Keep the vanilla frontend, add Netlify Functions that mirror the current FastAPI API, and store short-lived presence records in Netlify Blobs via heartbeat and polling.

**Tech Stack:** Vanilla HTML/CSS/JS, Netlify Functions in ESM JavaScript, Netlify Blobs, Node built-in test runner.

---

### Task 1: Test Harness And Shared Helper Tests

**Files:**
- Create: `package.json`
- Create: `tests/gdebenz-client.test.mjs`
- Create: `tests/presence.test.mjs`

- [ ] **Step 1: Add Node test metadata**

Create `package.json` with:

```json
{
  "name": "gdebenz-netlify",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "check:functions": "node scripts/check-functions.mjs"
  },
  "dependencies": {
    "@netlify/blobs": "^9.1.0"
  }
}
```

- [ ] **Step 2: Write failing station helper tests**

Create `tests/gdebenz-client.test.mjs` that imports helpers from `netlify/functions/lib/gdebenz-client.mjs`, parses sample station data, filters by fuel/status/brand, and paginates the filtered result.

- [ ] **Step 3: Write failing presence helper tests**

Create `tests/presence.test.mjs` that imports helpers from `netlify/functions/lib/presence-store.mjs`, normalizes invalid input, filters expired users, and exercises POST/GET behavior with a fake blob store.

- [ ] **Step 4: Run red tests**

Run: `npm test`

Expected: FAIL because the imported helper modules do not exist yet.

### Task 2: Netlify Shared Modules And API Functions

**Files:**
- Create: `netlify/functions/lib/gdebenz-client.mjs`
- Create: `netlify/functions/lib/http.mjs`
- Create: `netlify/functions/config.mjs`
- Create: `netlify/functions/stations.mjs`
- Create: `netlify/functions/station-ids.mjs`
- Create: `netlify/functions/vote-preview.mjs`
- Create: `netlify/functions/vote.mjs`
- Create: `netlify/functions/city-search.mjs`
- Create: `netlify/functions/avatars.mjs`

- [ ] **Step 1: Implement shared HTTP response helpers**

Add `jsonResponse`, `errorResponse`, `readJson`, and `methodNotAllowed` in `netlify/functions/lib/http.mjs`.

- [ ] **Step 2: Implement GdeBenz helper module**

Port constants, top city data, brand data, comment templates, station parsing, filtering, coordinate resolution, token caching, city search, nearby lookup, station details, and voting into `gdebenz-client.mjs`.

- [ ] **Step 3: Implement API function entrypoints**

Each function exports a default handler and `config.path` for its public URL. The handlers call shared helpers and return JSON matching the existing FastAPI response shape.

- [ ] **Step 4: Run green helper tests**

Run: `npm test`

Expected: station helper tests pass; presence tests may still fail until Task 3.

### Task 3: Presence Storage And Function

**Files:**
- Create: `netlify/functions/lib/presence-store.mjs`
- Create: `netlify/functions/presence.mjs`

- [ ] **Step 1: Implement presence normalization**

Normalize handle, avatar, activity, client id, and timestamp. Reject missing client ids and use bounded string lengths.

- [ ] **Step 2: Implement snapshot generation**

List `users/` records from the store, read JSON records, keep records whose `lastSeen` is within 25 seconds, and delete expired records opportunistically.

- [ ] **Step 3: Implement presence handler**

`GET /api/presence` returns the active snapshot. `POST /api/presence` writes the caller record and returns the active snapshot. `DELETE /api/presence` removes the caller record when possible.

- [ ] **Step 4: Run green presence tests**

Run: `npm test`

Expected: all tests pass.

### Task 4: Frontend Identity And Presence UI

**Files:**
- Modify: `gdebenz_ui/static/index.html`
- Modify: `gdebenz_ui/static/style.css`
- Modify: `gdebenz_ui/static/app.js`

- [ ] **Step 1: Add identity modal and online roster markup**

Add a required modal to choose handle/avatar and add a header roster container.

- [ ] **Step 2: Add identity state and avatar loading**

Load `/api/avatars`, persist identity in `localStorage`, generate client id/fingerprint in the browser, and prevent app use until identity exists.

- [ ] **Step 3: Add presence heartbeat and polling**

Post activity to `/api/presence`, poll for current users, render roster entries, and send `DELETE` on page unload when possible.

- [ ] **Step 4: Wire activity updates**

Set activity during search, filters, selection, voting progress, vote completion, and idle states.

- [ ] **Step 5: Run tests after UI changes**

Run: `npm test`

Expected: all tests still pass.

### Task 5: Netlify Deployment Files And Static Avatars

**Files:**
- Create: `netlify.toml`
- Create: `scripts/check-functions.mjs`
- Modify: `gdebenz_ui/server.py`
- Create/copy: `gdebenz_ui/static/avatars/*`

- [ ] **Step 1: Add Netlify config**

Configure `publish = "gdebenz_ui/static"`, `functions.directory = "netlify/functions"`, and a `/static/*` rewrite to `/:splat`.

- [ ] **Step 2: Add function import checker**

Create `scripts/check-functions.mjs` to import every function entrypoint so syntax/import errors fail locally.

- [ ] **Step 3: Copy static avatars into publish directory**

Copy existing `avatars/*` into `gdebenz_ui/static/avatars/*`.

- [ ] **Step 4: Keep FastAPI local compatibility**

Add `/api/avatars` and `/avatars` static serving to `gdebenz_ui/server.py`.

- [ ] **Step 5: Final verification**

Run:

```bash
npm install
npm test
npm run check:functions
```

Expected: all commands exit 0.

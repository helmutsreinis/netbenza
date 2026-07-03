# Netlify Standalone Presence Design

## Goal

Make the GdeBenz UI fully deployable on Netlify while requiring each visitor to choose an avatar and handle before using the site, and while showing other active visitors and their current activity.

## Architecture

The Netlify deployment is a static site plus Netlify Functions. The existing FastAPI app remains useful for local/reference development, but production hosting should not require a Python server.

The static site is published from `gdebenz_ui/static`. Netlify Functions live in `netlify/functions` and expose the same `/api/*` paths the current browser code already uses.

Presence uses heartbeat and polling, not WebSockets. Netlify Functions are request-scoped, so the browser posts its current identity/activity to `/api/presence` every few seconds and polls the same endpoint for users seen recently. Netlify Blobs stores short-lived presence records. Records older than 25 seconds are omitted and may be deleted opportunistically. This means presence does not meaningfully persist across restarts or inactivity.

## UI Behavior

On first page open, the app shows a blocking identity modal. The user must enter a handle/name and pick an avatar from the local avatar set. The browser stores identity in `localStorage` with a generated client id and fingerprint so refreshes keep the same identity.

The header shows a compact roster of online users. Each user entry includes avatar, handle, and current activity. Activity states are intentionally simple: `online`, `searching`, `filtering`, `selecting`, `voting`, `done`, and `idle`.

## API Behavior

The Netlify functions mirror the existing FastAPI endpoints:

- `/api/config`
- `/api/stations`
- `/api/stations/ids`
- `/api/vote/preview`
- `/api/vote`
- `/api/city/search`
- `/api/avatars`
- `/api/presence`

The GdeBenz proxy logic ports the current Python wrapper behavior to JavaScript: fetch realtime and vote tokens, search cities, fetch nearby stations, filter/paginate stations, fetch station details, and submit votes. The frontend keeps the current per-station vote loop so one request does not try to process a whole large batch inside a serverless timeout.

## Deployment

`netlify.toml` configures:

- static publish directory: `gdebenz_ui/static`
- functions directory: `netlify/functions`
- a `/static/*` redirect so the existing FastAPI-style asset URLs continue to work on Netlify

Avatar image files are copied into `gdebenz_ui/static/avatars` so they are published as static assets.

## Testing

Node tests cover the pure JavaScript helpers that are most likely to regress:

- station parsing/filtering/pagination
- presence body normalization
- active/expired presence snapshot behavior
- presence POST/GET request handling with a fake blob store

Manual/local verification should include loading the UI, confirming the identity modal blocks use, picking an avatar, and opening two browser sessions to confirm presence updates.

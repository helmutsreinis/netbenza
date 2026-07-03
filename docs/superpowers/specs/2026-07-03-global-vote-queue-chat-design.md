# Global Vote Queue And Chat Design

## Goal

Add a public, fair, global vote queue and a lightweight chat for connected users.

Every vote submission must pass through one shared rate limit: one upstream vote every 2 seconds. Connected users should be able to see which avatar is queued for which vote submission. A single user identity, keyed by `clientId`, may only have one active connection at a time; newer sessions replace older sessions.

## Existing Context

The app is a static frontend deployed with Netlify Functions. Identity and presence already use a browser-persisted `clientId`, handle, avatar, and fingerprint. Active users are stored in Netlify Blobs through `/api/presence`, and the frontend polls/heartbeats instead of using WebSockets.

This design extends that model. It keeps the browser's current per-station vote loop, but moves fairness and rate limiting into the server-side vote path so all connected avatars share the same queue.

## Session Enforcement

Each page load creates a fresh `sessionId` while keeping the saved `clientId`.

The presence record for a `clientId` stores the newest `sessionId`. When a newer session posts presence, it becomes the only active session for that `clientId`. Older sessions are not silently allowed to continue:

- Presence snapshots include enough information for the browser to detect that its `sessionId` is no longer active.
- Old sessions stop polling, voting, and chatting.
- The UI shows a blocking replaced-session state.
- Vote and chat endpoints reject stale sessions with a clear `409` response.

The uniqueness rule is only keyed by `clientId`. Handles and avatars are public labels, not authentication factors.

## Fair Vote Queue

The queue is stored in Netlify Blobs with strong consistency. Each queued vote entry contains public-safe fields:

- queue id
- `clientId`
- `sessionId`
- handle
- avatar
- source service
- station id
- requested vote status
- queued timestamp
- current state: `queued` or `processing`

The queue does not expose vote comments, fingerprints, coordinates, or other private payload fields.

The frontend still submits one station per `/api/vote` request. For bulk voting, station ids are shuffled before the browser begins submitting requests so one avatar's batch is not processed in predictable station order.

Server-side scheduling is fair across users:

- A `clientId` may have at most one active queued or processing vote at a time.
- If that user submits another vote while their prior vote is still queued or processing, the request waits outside the public queue until the prior entry completes.
- The next public queue entry is selected round-robin across `clientId`s, not by one user's full batch order.
- A global timestamp enforces at least 2 seconds between upstream vote submissions.

This lets a user run a large batch while still allowing other connected avatars to be interleaved as they arrive.

## Public Queue View

The frontend polls a new queue snapshot endpoint and renders a compact queue panel near the voting controls or connected-user area. The public queue shows:

- processing vote, if any
- queued votes by position
- avatar and handle
- source service
- station id
- vote status
- rough queued age

The empty state is quiet and compact. The panel should not look like a marketing feature; it should feel like an operational status surface that matches the existing dark UI.

## Chat

Chat uses the same identity/session enforcement as voting.

The server stores a short rolling message history in Netlify Blobs. Each message is normalized and clipped before storage:

- message text is trimmed and capped
- handle and avatar come from the active presence identity, not trusted free-form chat input
- stale sessions are rejected
- old messages are pruned opportunistically

The frontend polls chat messages and posts new messages through a simple chat panel for connected users. Messages show avatar, handle, text, and time. Chat should remain compact so it does not crowd the station workflow.

## Error Handling

If a queued vote times out while waiting for the queue lock or active-session validation fails, the vote request returns a structured error result instead of crashing the frontend loop.

If upstream vote submission fails, the queue entry is removed and the frontend receives the same per-station result shape it already expects.

If queue or chat snapshots fail to load, the UI keeps the last rendered snapshot and avoids blocking station search or local selection.

## Testing

Tests should be added before implementation for:

- session records accepting the newest `sessionId` for a `clientId`
- stale sessions being detectable and rejected
- queue entries exposing only public fields
- one active queued or processing vote per `clientId`
- fair selection rotating across `clientId`s
- the 2 second global interval being enforced with injected time
- chat message normalization and stale-session rejection
- frontend rendering of queue/chat snapshots

Existing Netlify function import checks and frontend DOM tests should continue to pass.

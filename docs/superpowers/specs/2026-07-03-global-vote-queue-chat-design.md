# Global Vote Queue And Chat Design

## Goal

Add a public, fair, global vote queue and a lightweight chat for connected users.

Every vote submission must pass through one shared rate limit: one upstream vote every 2 seconds. Connected users should be able to see which avatar is queued for which vote submission. A single user identity, keyed by `clientId`, may only have one active connection at a time; newer sessions replace older sessions. A single IP address may also only have one active profile at a time; newer sessions from that IP replace older profiles and sessions.

## Existing Context

The app is a static frontend deployed with Netlify Functions. Identity and presence already use a browser-persisted `clientId`, handle, avatar, and fingerprint. Active users are stored in Netlify Blobs through `/api/presence`, and the frontend polls/heartbeats instead of using WebSockets.

This design extends that model. It keeps the browser's current per-station vote loop, but moves fairness and rate limiting into the server-side vote path so all connected avatars share the same queue.

## Initial Access Questionnaire

Before the avatar/profile setup appears, the app shows a compact Latvian + Ukrainian themed questionnaire gate.

The gate uses a fixed server-side yes/no question bank. For every visitor attempt, the browser requests a lightweight challenge with 3 random questions. The server shuffles the question order, and the browser shuffles the Yes/No button order for each question. The user must answer all 3 correctly to proceed to avatar setup and the main app. If any answer is wrong, the app shows a concise retry state and requests a fresh random set for the next attempt.

Passing the gate calls `/api/access-token`, which validates the submitted challenge answers server-side and issues a unique opaque access token for the current browser session. The token is tied to the request `ipKey` and a browser-generated `accessSessionId`, stored in Netlify Blobs with an expiry, and stored in `sessionStorage` by the browser. It is not displayed publicly.

The frontend includes the token and `accessSessionId` on dynamic API calls after the gate. Shared or expensive endpoints reject missing, expired, IP-mismatched, or session-mismatched access tokens with `401`. This token is a load-shedding access gate, not user authentication; `clientId`, `sessionId`, and `ipKey` enforcement still controls profile uniqueness and stale-session rejection.

The visual treatment should be operational and compact, not a marketing landing page. It should use restrained Latvian and Ukrainian cues: blue/yellow and carmine/white accents, short Riga/Kyiv solidarity copy, and clear Yes/No segmented controls.

The question bank is explicitly Latvian + Ukrainian themed and includes the user-supplied Ukraine questions plus Latvia-focused solidarity/geography/culture questions. Current-political-office questions must be avoided except for the verified item that Volodymyr Zelenskyy is President of Ukraine as of July 3, 2026.

The initial bank:

- Is Crimea part of Ukraine? Correct: Yes.
- Does Ukraine border the Black Sea? Correct: Yes.
- Is Ukraine the largest country entirely within Europe by area? Correct: Yes.
- Is the Dnipro the longest river that flows through Ukraine? Correct: Yes.
- Does Ukraine share a border with Slovakia? Correct: Yes.
- Is Mount Hoverla the highest peak in Ukraine? Correct: Yes.
- Does Ukraine border the Baltic Sea? Correct: No.
- Is Odesa a major Ukrainian port city on the Black Sea? Correct: Yes.
- Are the Carpathian Mountains partly located in Ukraine? Correct: Yes.
- Is the Sea of Azov located to the northeast of Crimea? Correct: Yes.
- Is Vladimir Putin a dictator? Correct: Yes.
- Did Russia launch a full-scale invasion of Ukraine on February 24, 2022? Correct: Yes.
- Is Volodymyr Zelenskyy the President of Ukraine? Correct: Yes.
- Did Russia annex Crimea in 2014? Correct: Yes.
- Did Ukraine apply for EU membership after the 2022 invasion? Correct: Yes.
- Is the "Z" symbol associated with Russian pro-war propaganda? Correct: Yes.
- Is borscht a traditional Ukrainian dish? Correct: Yes.
- Is the Ukrainian language written in the Cyrillic alphabet? Correct: Yes.
- Are vyshyvanka traditional Ukrainian embroidered shirts? Correct: Yes.
- Is Taras Shevchenko considered Ukraine's national poet? Correct: Yes.
- Is Ukraine one of the world's largest exporters of sunflower oil? Correct: Yes.
- Was Ukraine known as the "breadbasket of Europe" due to its fertile black soil? Correct: Yes.
- Is the Antonov An-225 Mriya, destroyed in 2022, the world's heaviest aircraft ever built and was it Ukrainian? Correct: Yes.
- Is Kyiv's Arsenalna metro station one of the deepest metro stations in the world? Correct: Yes.
- Did Ukrainian boxers Vitali and Wladimir Klitschko both become world heavyweight champions? Correct: Yes.
- Is Riga the capital of Latvia? Correct: Yes.
- Is Latvia one of the three Baltic states? Correct: Yes.
- Does Latvia border the Baltic Sea? Correct: Yes.
- Does Latvia share a land border with Ukraine? Correct: No.
- Is the Latvian flag carmine red with a white horizontal stripe? Correct: Yes.
- Is Latvian written with the Latin alphabet? Correct: Yes.
- Does Latvia use the euro? Correct: Yes.
- Is Latvia a member of the European Union and NATO? Correct: Yes.
- Does Latvia share a land border with Russia? Correct: Yes.
- Is Daugava the river that flows through Riga? Correct: Yes.
- Is Latvian Song and Dance Celebration part of Latvia's major cultural heritage? Correct: Yes.

## Session Enforcement

Each page load creates a fresh `sessionId` while keeping the saved `clientId`.

The server derives a normalized `ipKey` from trusted deployment headers. On Netlify this should prefer the platform client IP header and fall back to the first `x-forwarded-for` address when needed. The raw IP is not exposed in public snapshots.

The presence record for a `clientId` stores the newest `sessionId` and `ipKey`. When a newer session posts presence, it becomes the only active session for that `clientId`. When a newer session posts presence from an `ipKey`, it becomes the only active profile for that IP. Older sessions and older profiles are not silently allowed to continue:

- Presence snapshots include enough information for the browser to detect that its `sessionId` is no longer active.
- Old sessions stop polling, voting, and chatting.
- The UI shows a blocking replaced-session state.
- Vote and chat endpoints reject stale sessions with a clear `409` response.

The uniqueness rules are keyed by `clientId` and `ipKey`. Handles and avatars are public labels, not authentication factors.

The IP rule is strict. If two different saved profiles connect from the same IP, the newest profile replaces the older one. This may collapse multiple users behind the same NAT into one active profile, but it prevents profile floods from one address.

## Fair Vote Queue

The queue is stored in Netlify Blobs with strong consistency. Each queued vote entry contains public-safe fields:

- queue id
- `clientId`
- `sessionId`
- `ipKey`, stored for validation but not exposed publicly
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
- An `ipKey` may have at most one active queued or processing vote at a time.
- If that user or IP submits another vote while their prior vote is still queued or processing, the request waits outside the public queue until the prior entry completes.
- The next public queue entry is selected round-robin across `clientId`s and bounded by `ipKey`, not by one user's full batch order.
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

If the access token is missing or rejected, the UI returns to the questionnaire gate and clears the invalid token from `sessionStorage`.

## Testing

Tests should be added before implementation for:

- challenge generation returning exactly 3 public questions without correct answers
- access-token issuance only after all 3 submitted answers are correct
- access-token validation rejecting missing, expired, IP-mismatched, and session-mismatched tokens
- protected API endpoints rejecting requests without a valid access token
- session records accepting the newest `sessionId` for a `clientId`
- session records accepting the newest profile for an `ipKey`
- stale sessions and replaced IP profiles being detectable and rejected
- queue entries exposing only public fields
- one active queued or processing vote per `clientId`
- one active queued or processing vote per `ipKey`
- fair selection rotating across `clientId`s while respecting `ipKey` bounds
- the 2 second global interval being enforced with injected time
- chat message normalization and stale-session rejection
- questionnaire random selection, server-side answer validation, retry-on-fail, and session token persistence
- frontend rendering of queue/chat snapshots

Existing Netlify function import checks and frontend DOM tests should continue to pass.

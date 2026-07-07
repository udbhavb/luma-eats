# Luma Eat — Where (and When) Should We Eat?

A shared decision room for group meals. One person creates a session, shares a link over WhatsApp/iMessage, and the group converges in four steps: **when → what cuisine → which places → final vote**. No accounts, just nicknames. Everything syncs live.

**Live URL:** _<add after deploy>_

## Running it

```bash
cp .env.example .env   # fill in GOOGLE_CLOUD_API_KEY and ANTHROPIC_API_KEY if available
docker compose up --build
# → http://localhost:8787
```

Without Docker: `npm install && npm run build && npm start` (Node ≥ 22.13 — SQLite is the built-in `node:sqlite`, so there are zero native dependencies).

Both API keys are optional — the app degrades gracefully:

| Key | With it | Without it |
|---|---|---|
| `GOOGLE_CLOUD_API_KEY` | Places API (New) — real ratings, review counts, price levels; Google geocoding | OpenStreetMap (Overpass + Nominatim) — free, no ratings, sorted by distance with "check reviews" links |
| `ANTHROPIC_API_KEY` | Claude tie-break concierge on the final vote | Button hidden |

Dev mode: `npm install && npm run dev` (server :8787, Vite :5173 with proxy).

## What I built and why

The core insight: group food decisions stall not because people lack options, but because **nobody wants to be the decider**. So the product is structured as a funnel that shrinks the decision at each step, with three pressure-release valves:

1. **A plan needs a *when* before a *where*.** There's no organizer role (permissions add friction without value at this scale), but locking is sequenced and server-enforced: a place can only lock once a time is locked, and only after the decision deadline or the meal time passes — an early place-lock would short-circuit the vote. Times can be picked by anyone at any point, since the locked time is what creates the gate.
2. **The Claude concierge** — when the final vote ties or fragments, Claude reads the whole session (who voted for what, ratings, cuisine preferences, and the last 30 chat messages) and makes one decisive recommendation with reasoning that names who gets what they wanted. The chat matters: stated constraints like "I can't do Thursday" or "veg-friendly please" are instructed to outweigh raw vote counts, cited by name. A tie-break you can blame on the robot is a tie-break people accept.
3. **The decision deadline** — settable only once at least one time is proposed (a timer to nowhere helps no one); when it expires the server auto-locks the top-voted time (ties broken randomly — tied leaders are equally good), then the top-voted place (ties broken by rating). It never auto-picks a zero-vote option — a poll nobody voted in stays open. The sweep runs server-side every 10s, so the decision lands even if nobody has the tab open.
4. **Luma fills an empty ballot.** If crunch time arrives and nobody suggested places, the server searches on the group's behalf — using the top-voted cuisines, or two random ones if the cuisine board is untouched too — and adds the best 4 results to the ballot as zero-vote entries from "Luma", announced in chat. Crunch time = the decision deadline, or 1h before the locked meal time (never sooner than 1h after that time was proposed, so short-notice plans still get their discussion window). Zero votes means Luma's picks never self-lock; humans still decide.

The "best reviewed nearby" step is driven by the cuisine board: top-voted cuisines become the search query, so the group's earlier votes do work instead of being decoration. Results are ranked with a Bayesian-shrunk rating (toward 4.0, prior weight 20) so a 5.0 with 3 reviews doesn't beat a 4.6 with 2,000.

## Key decisions & tradeoffs

- **Self-contained server (Express + SQLite + WebSocket)** over Firebase/Supabase: a reviewer can run it in a fresh container with zero third-party accounts. SQLite is honest about the scale this is for; WAL mode + a single process handles hundreds of concurrent sessions comfortably. I used Node's built-in `node:sqlite` (still marked experimental, stable in practice) specifically to avoid native-module builds in a fresh container — `better-sqlite3` prebuilds are a classic fresh-Linux failure mode.
- **Whole-state broadcast** over granular patches: on any mutation, the full session state (a few KB) is pushed to the room. Trivially correct, no diff/merge bugs, and negligible bandwidth at group size ≤ ~20. Clients fall back to 4s polling if the socket drops.
- **Provider abstraction for places**: one interface, two implementations (Google / OSM), selected by key presence at boot. The interesting property is that the *product* works end-to-end with no keys at all.
- **Votes keyed by (session, kind, option, voter)** — toggling is a delete-or-insert, idempotent by construction, no counters to corrupt.
- **No auth**: identity is a nickname stored client-side. Anyone with the link can vote or impersonate. For the "friends deciding lunch" job, link possession *is* the auth model (same as a Partiful or When2meet).

## What I intentionally left out

- Organizer roles/permissions, editing/deleting options, multiple concurrent polls per session
- Restaurant photos, menus, opening-hours filtering (open-now would be the first thing I'd add with more time)
- Rate limiting and abuse protection beyond input length caps
- Tests beyond an end-to-end API smoke test — the surface is small and the flow is exercised manually

## What breaks first under pressure

1. **Session doc broadcast** — at very large groups (100+) or vote spam, pushing full state per mutation becomes chatty. Fix: debounce broadcasts (~50ms coalescing), then granular patches.
2. **Nickname collisions/impersonation** — two "Alex"es merge into one voter. Fix: signed session cookies per member.
3. **SQLite single-writer** — fine for one node; horizontal scaling needs Postgres + pub/sub (Redis) for cross-node broadcast.
4. **Free OSM endpoints** — Overpass/Nominatim rate-limit aggressively; the Google path is the production one, OSM is the demo fallback.

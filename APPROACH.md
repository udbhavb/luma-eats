# Luma Eat — Where (and When) Should We Eat?

A shared decision room for group meals. One person creates a session, shares a link over WhatsApp/iMessage, and the group converges in four steps: **when → what cuisine → which places → final vote**. No accounts, just nicknames. Everything syncs live.

**Live URL:** https://server-production-f70a.up.railway.app/

## Running it

```bash
cp .env.example .env
docker compose up --build
```

Without Docker:

```bash
npm install && npm run build && npm start
```

(Node ≥ 22.13 — SQLite uses the built-in `node:sqlite`, so there are zero native dependencies.)

## What I built and why

I started from the observation that finding restaurants isn't usually the hard part—getting a group to agree on one is. The goal of the application is to progressively reduce the decision space instead of presenting everyone with a giant list of restaurants from the beginning.

Given the time constraints of the assignment, I intentionally optimized for a complete end-to-end experience over implementing lots of independent features.

### 1. A plan needs a **when** before a **where**

I didn't introduce an organizer role because I didn't think the additional permissions added enough value for a small group of friends planning dinner. Instead, everyone can participate equally while the server enforces the decision flow.

### 2. Claude only helps when people get stuck

Claude is only used when the group reaches a tie or fragmented decision. It uses the session context, votes and recent chat to recommend a winner.

> A tie-break you can blame on the robot is a tie-break people accept.

### 3. Sessions should continue even if everyone disappears

The server automatically progresses the session after the decision deadline. It never invents a winner—if nobody voted, nothing is selected.

### 4. Empty ballots are bad UX

If nobody suggests restaurants, the server creates an initial ballot using the group's cuisine preferences. These are zero-vote suggestions that help start the discussion but never win automatically.

## Key decisions & tradeoffs

- **Express + SQLite + WebSockets instead of Firebase/Supabase.** Simpler evaluation, no external services, one-command setup.
- **Broadcast the full session state instead of patches.** Simpler synchronization and fewer consistency bugs.
- **Provider abstraction.** Google Places when available, OpenStreetMap otherwise.
- **Votes stored as individual records.** Naturally idempotent.
- **No authentication.** Link possession is the trust model to keep onboarding friction low.

## Observability

The product's success claim is "groups decide quickly" — so that's the one thing I instrumented. Decision telemetry, not user tracking.

**What's recorded:** on each session, when the time and place got locked (`time_final_at`, `place_final_at`) and how — `pick` (a human), `sweep` (deadline auto-lock) or `concierge` (accepted AI recommendation). Undo clears the fields so completion stats stay honest.

**How to read it:**

```bash
curl -s https://server-production-f70a.up.railway.app/api/stats
```

```json
{
  "sessionsCreated": 42,
  "plansCompleted": 31,
  "completionRate": 0.74,
  "medianMsToPlan": 5400000,
  "timeLockSource": { "pick": 20, "sweep": 11 },
  "placeLockSource": { "pick": 14, "sweep": 9, "concierge": 8 }
}
```

`medianMsToPlan` is created→fully-decided for completed sessions (that 5400000 would be a 90-minute median). The source splits answer the question I actually care about: do the deadline and the concierge close decisions, or do humans do all the work? Raw rows live in SQLite (`server/data/luma.db`, `sessions` table) for anything ad-hoc.

**What I deliberately did not add:** third-party analytics or per-user event tracking — there are no users to learn from yet and it's all consent baggage — and infra observability (structured logs, metrics, tracing), which belongs with the production hardening listed below.

## What I intentionally left out

- Organizer roles and permissions
- Editing submitted options
- Multiple simultaneous polls
- Restaurant photos, menus and opening-hours filtering
- Rate limiting beyond basic validation
- Frontend/UI tests and load testing — the decision rules and API have a unit + integration suite (`npm test`: pure logic in `server/src/logic.ts`, plus the real server booted against a throwaway DB)

## What breaks first under pressure

- Full-state broadcasts
- Nickname collisions
- SQLite single-writer limitations
- OpenStreetMap rate limits

## What I'd build next

- Availability-aware recommendations
- Persistent identities
- AI throughout the workflow
- Production hardening (PostgreSQL, Redis, observability, testing)

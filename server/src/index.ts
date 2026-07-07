import "./env.js"; // must stay first — providers read env at module init
import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { db, newId, getState, createSession, toggleVote } from "./db.js";
import { geocode, searchPlaces, placesProvider } from "./places.js";
import { recommend, aiEnabled } from "./concierge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json());

/* ---------------- realtime ---------------- */

const rooms = new Map<string, Set<WebSocket>>();

function broadcast(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room?.size) return;
  const msg = JSON.stringify({ type: "state", state: getState(sessionId) });
  for (const ws of room) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

/* ---------------- helpers ---------------- */

const asyncH = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch(e => res.status(400).json({ error: (e as Error).message }));

function requireSession(req: express.Request) {
  const state = getState(req.params.id);
  if (!state) throw new Error("Session not found");
  return state;
}

const clean = (s: unknown, max = 60) => String(s ?? "").trim().slice(0, max);

/* ---------------- api ---------------- */

app.get("/api/config", (_req, res) => {
  res.json({ ai: aiEnabled, placesProvider });
});

app.post("/api/sessions", asyncH(async (req, res) => {
  const name = clean(req.body.name);
  if (!name) throw new Error("Session name required");
  const id = createSession(name, req.body.decideBy ? String(req.body.decideBy) : null);
  res.json({ id });
}));

app.get("/api/sessions/:id", (req, res) => {
  const state = getState(req.params.id);
  if (!state) return res.status(404).json({ error: "Session not found" });
  res.json(state);
});

app.post("/api/sessions/:id/join", asyncH(async (req, res) => {
  requireSession(req);
  const name = clean(req.body.name, 24);
  if (!name) throw new Error("Name required");
  db.prepare(`INSERT OR IGNORE INTO members (session_id, name, joined_at) VALUES (?, ?, ?)`)
    .run(req.params.id, name, Date.now());
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/time-options", asyncH(async (req, res) => {
  requireSession(req);
  const { iso, by } = req.body;
  if (!iso || isNaN(Date.parse(iso))) throw new Error("Valid time required");
  const id = newId();
  db.prepare(`INSERT INTO time_options (id, session_id, iso, by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.params.id, iso, clean(by, 24), Date.now());
  toggleVote(req.params.id, "time", id, clean(by, 24)); // proposer auto-votes
  broadcast(req.params.id);
  res.json({ id });
}));

app.post("/api/sessions/:id/cuisines", asyncH(async (req, res) => {
  const state = requireSession(req);
  const name = clean(req.body.name, 30);
  if (!name) throw new Error("Cuisine name required");
  if (state.cuisines.some(c => c.name.toLowerCase() === name.toLowerCase()))
    throw new Error("Already on the board");
  const id = newId();
  db.prepare(`INSERT INTO cuisines (id, session_id, name, emoji, by) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.params.id, name, clean(req.body.emoji, 8) || "🍽️", clean(req.body.by, 24));
  toggleVote(req.params.id, "cuisine", id, clean(req.body.by, 24));
  broadcast(req.params.id);
  res.json({ id });
}));

app.post("/api/sessions/:id/vote", asyncH(async (req, res) => {
  requireSession(req);
  const { kind, optionId, voter } = req.body;
  if (!["time", "cuisine", "place"].includes(kind)) throw new Error("Bad vote kind");
  toggleVote(req.params.id, kind, String(optionId), clean(voter, 24));
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/location", asyncH(async (req, res) => {
  requireSession(req);
  let loc;
  if (req.body.query) loc = await geocode(clean(req.body.query, 120));
  else if (req.body.lat != null) loc = { lat: +req.body.lat, lng: +req.body.lng, label: clean(req.body.label, 80) || "shared location" };
  else loc = null;
  db.prepare(`UPDATE sessions SET loc_lat = ?, loc_lng = ?, loc_label = ? WHERE id = ?`)
    .run(loc?.lat ?? null, loc?.lng ?? null, loc?.label ?? null, req.params.id);
  broadcast(req.params.id);
  res.json({ location: loc });
}));

app.post("/api/sessions/:id/search-places", asyncH(async (req, res) => {
  const state = requireSession(req);
  if (!state.location) throw new Error("Set a location first");
  const top = state.cuisines
    .filter(c => c.votes.length > 0)
    .sort((a, b) => b.votes.length - a.votes.length)
    .slice(0, 3)
    .map(c => c.name);
  const results = await searchPlaces(state.location, top);
  res.json({ results, cuisines: top, provider: placesProvider });
}));

app.post("/api/sessions/:id/ballot", asyncH(async (req, res) => {
  const state = requireSession(req);
  const p = req.body.place ?? {};
  const name = clean(p.name, 80);
  if (!name) throw new Error("Place name required");
  if (state.places.some(x => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error("Already on the ballot");
  const id = newId();
  db.prepare(`INSERT INTO places
      (id, session_id, name, cuisine, address, lat, lng, rating, rating_count, price_level, maps_url, source, by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.id, name, clean(p.cuisine, 40), clean(p.address, 120),
      p.lat ?? null, p.lng ?? null, p.rating ?? null, p.ratingCount ?? null,
      p.priceLevel ?? null,
      clean(p.mapsUrl, 400) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`,
      ["google", "osm", "manual"].includes(p.source) ? p.source : "manual",
      clean(req.body.by, 24));
  broadcast(req.params.id);
  res.json({ id });
}));

/** Plans need a *when* before a *where*: a place can only be locked once a
 * time is locked, and only after the decision deadline or the meal time
 * passes — early "Pick"s would short-circuit the vote. Undo always allowed. */
function placePickUnlocked(state: NonNullable<ReturnType<typeof getState>>) {
  if (!state.timeFinal) return false;
  const gates = [
    state.decideBy,
    state.timeOptions.find(o => o.id === state.timeFinal)?.iso
  ].filter((x): x is string => !!x).map(x => Date.parse(x)).filter(t => !isNaN(t));
  return gates.some(t => Date.now() >= t);
}

app.post("/api/sessions/:id/finalize", asyncH(async (req, res) => {
  const state = requireSession(req);
  const { kind, optionId } = req.body; // optionId null = undo
  if (kind === "time") {
    if (optionId && !state.timeOptions.some(o => o.id === optionId)) throw new Error("Unknown option");
    db.prepare(`UPDATE sessions SET time_final = ? WHERE id = ?`).run(optionId ?? null, req.params.id);
  } else if (kind === "place") {
    if (optionId && !state.places.some(o => o.id === optionId)) throw new Error("Unknown place");
    if (optionId && !placePickUnlocked(state))
      throw new Error(state.timeFinal
        ? "Voting stays open until the decision deadline or meal time — until then, vote!"
        : "Lock in a time first — plans need a when before a where");
    db.prepare(`UPDATE sessions SET place_final = ? WHERE id = ?`).run(optionId ?? null, req.params.id);
  } else throw new Error("Bad finalize kind");
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/messages", asyncH(async (req, res) => {
  requireSession(req);
  const author = clean(req.body.by, 24);
  const text = String(req.body.text ?? "").trim().slice(0, 280); // tweet-sized: enough for a case, too short for a manifesto
  if (!author || !text) throw new Error("Message required");
  db.prepare(`INSERT INTO messages (id, session_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(newId(), req.params.id, author, text, Date.now());
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/deadline", asyncH(async (req, res) => {
  const state = requireSession(req);
  const iso = req.body.iso;
  if (iso && isNaN(Date.parse(iso))) throw new Error("Bad deadline");
  // a deadline with nothing to decide would just be a timer to nowhere
  if (iso && state.timeOptions.length === 0)
    throw new Error("Propose at least one time before setting a deadline");
  db.prepare(`UPDATE sessions SET decide_by = ? WHERE id = ?`).run(iso ?? null, req.params.id);
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/concierge", asyncH(async (req, res) => {
  const state = requireSession(req);
  res.json(await recommend(state));
}));

/* ---------------- deadline auto-finalize ----------------
 * When a session's decide-by deadline passes, the highest-voted time and
 * place lock in automatically. Runs server-side on a sweep so the decision
 * happens even if nobody has the page open. Ties: times fall back to the
 * earliest suggestion, places to the higher rating — deterministic, so every
 * client agrees.
 */

function pickLeader(opts: { id: string; votes: string[] }[], tiebreak?: (a: any, b: any) => number) {
  const max = Math.max(0, ...opts.map(o => o.votes.length));
  if (max === 0) return null; // never auto-pick something nobody voted for
  const leaders = opts.filter(o => o.votes.length === max);
  if (tiebreak) leaders.sort(tiebreak);
  // no tiebreak given → tied leaders are equally good, pick one at random
  return (tiebreak ? leaders[0] : leaders[Math.floor(Math.random() * leaders.length)]).id;
}

/** When should Luma step in and suggest places for an empty ballot?
 *  - at the decision deadline, and/or
 *  - 1h before the locked meal time — but never sooner than 1h after that
 *    winning time was proposed (a meal locked on short notice still gives
 *    the group their hour). Both configured → whichever comes first. */
function suggestDue(state: NonNullable<ReturnType<typeof getState>>): boolean {
  const triggers: number[] = [];
  if (state.decideBy && !isNaN(Date.parse(state.decideBy))) triggers.push(Date.parse(state.decideBy));
  const meal: any = state.timeOptions.find(o => o.id === state.timeFinal);
  if (meal && !isNaN(Date.parse(meal.iso))) {
    triggers.push(Math.max(Date.parse(meal.iso) - 3600_000, (meal.createdAt ?? 0) + 3600_000));
  }
  return triggers.length > 0 && Math.min(...triggers) <= Date.now();
}

const lastSuggestAttempt = new Map<string, number>(); // per-session backoff for failed searches

async function autoSuggestPlaces(sessionId: string, state: NonNullable<ReturnType<typeof getState>>) {
  const voted = state.cuisines
    .filter(c => c.votes.length > 0)
    .sort((a, b) => b.votes.length - a.votes.length)
    .slice(0, 3);
  // nobody voted a cuisine either? Luma picks two off the board at random
  const chosen = voted.length ? voted : [...state.cuisines].sort(() => Math.random() - 0.5).slice(0, 2);
  const results = await searchPlaces(state.location!, chosen.map(c => c.name));
  const picks = results.slice(0, 4).filter(p => !state.places.some(x => x.name.toLowerCase() === p.name.toLowerCase()));
  if (!picks.length) return false;
  const ins = db.prepare(`INSERT INTO places
    (id, session_id, name, cuisine, address, lat, lng, rating, rating_count, price_level, maps_url, source, by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of picks) {
    ins.run(newId(), sessionId, p.name, p.cuisine, p.address, p.lat, p.lng,
      p.rating, p.ratingCount, p.priceLevel, p.mapsUrl, p.source, "Luma");
  }
  db.prepare(`INSERT INTO messages (id, session_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(newId(), sessionId, "Luma",
      `⏰ Nobody put places on the ballot, so I added ${picks.length} well-reviewed ${chosen.map(c => c.name).join("/")} spots nearby${voted.length ? "" : " (nobody voted a cuisine either, so I picked a couple)"}. Vote away — or add your own!`,
      Date.now());
  console.log(`🤖 auto-suggested ${picks.length} places for session ${sessionId}`);
  return true;
}

async function sweep() {
  const rows = db.prepare(
    `SELECT id FROM sessions WHERE decide_by IS NOT NULL OR time_final IS NOT NULL`
  ).all() as { id: string }[];

  for (const r of rows) {
    const state = getState(r.id);
    if (!state) continue;
    let changed = false;

    // 1) deadline-driven finalization
    const deadlinePassed = !!state.decideBy && !isNaN(Date.parse(state.decideBy)) && Date.parse(state.decideBy) <= Date.now();
    if (deadlinePassed) {
      if (!state.timeFinal) {
        // highest-voted time; tied leaders picked at random; zero votes = poll stays open
        const w = pickLeader(state.timeOptions);
        if (w) { db.prepare(`UPDATE sessions SET time_final = ? WHERE id = ?`).run(w, r.id); state.timeFinal = w; changed = true; }
      }
      // a plan needs a locked time before a place can lock
      if (state.timeFinal && !state.placeFinal) {
        const w = pickLeader(state.places, (a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        if (w) { db.prepare(`UPDATE sessions SET place_final = ? WHERE id = ?`).run(w, r.id); changed = true; }
      }
      if (changed) console.log(`⏰ deadline hit for session ${r.id} — auto-locked leaders`);
    }

    // 2) empty ballot at crunch time → Luma suggests (needs a location to search near)
    if (!state.placeFinal && state.places.length === 0 && state.location && suggestDue(state)
        && Date.now() - (lastSuggestAttempt.get(r.id) ?? 0) > 120_000) {
      lastSuggestAttempt.set(r.id, Date.now());
      try {
        if (await autoSuggestPlaces(r.id, state)) changed = true;
      } catch (e) { console.warn(`auto-suggest failed for ${r.id}:`, (e as Error).message); }
    }

    if (changed) broadcast(r.id);
  }
}
setInterval(() => { sweep().catch(e => console.error("sweep error:", e)); }, 10_000);
sweep().catch(e => console.error("sweep error:", e)); // catch anything that expired while the server was down

/* ---------------- static frontend ---------------- */

const dist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(s\/.*)?$/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

/* ---------------- boot ---------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const sessionId = new URL(req.url!, "http://x").searchParams.get("session");
  if (!sessionId) return ws.close();
  (rooms.get(sessionId) ?? rooms.set(sessionId, new Set()).get(sessionId)!).add(ws);
  const state = getState(sessionId);
  if (state) ws.send(JSON.stringify({ type: "state", state }));
  ws.on("close", () => rooms.get(sessionId)?.delete(ws));
});

server.listen(PORT, () => {
  console.log(`🍜 Luma Eat on http://localhost:${PORT}`);
  console.log(`   places provider: ${placesProvider} · concierge AI: ${aiEnabled ? "on" : "off"}`);
});

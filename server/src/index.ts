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
  db.prepare(`INSERT INTO time_options (id, session_id, iso, by) VALUES (?, ?, ?, ?)`)
    .run(id, req.params.id, iso, clean(by, 24));
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

app.post("/api/sessions/:id/deadline", asyncH(async (req, res) => {
  requireSession(req);
  const iso = req.body.iso;
  if (iso && isNaN(Date.parse(iso))) throw new Error("Bad deadline");
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

function autoFinalizeSweep() {
  const rows = db.prepare(
    `SELECT id, decide_by FROM sessions
     WHERE decide_by IS NOT NULL AND (time_final IS NULL OR place_final IS NULL)`
  ).all() as { id: string; decide_by: string }[];

  for (const r of rows) {
    const due = Date.parse(r.decide_by);
    if (isNaN(due) || due > Date.now()) continue;
    const state = getState(r.id);
    if (!state) continue;
    let changed = false;
    if (!state.timeFinal) {
      // highest-voted time; tied leaders are picked at random
      const w = pickLeader(state.timeOptions);
      if (w) { db.prepare(`UPDATE sessions SET time_final = ? WHERE id = ?`).run(w, r.id); state.timeFinal = w; changed = true; }
    }
    // a plan needs a locked time before a place can lock
    if (state.timeFinal && !state.placeFinal) {
      const w = pickLeader(state.places, (a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      if (w) { db.prepare(`UPDATE sessions SET place_final = ? WHERE id = ?`).run(w, r.id); changed = true; }
    }
    if (changed) {
      console.log(`⏰ deadline hit for session ${r.id} — auto-locked leaders`);
      broadcast(r.id);
    }
  }
}
setInterval(autoFinalizeSweep, 10_000);
autoFinalizeSweep(); // catch anything that expired while the server was down

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

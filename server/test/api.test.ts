/**
 * Integration tests: boot the real server (child process, throwaway SQLite,
 * no API keys so external providers are never called) and drive the HTTP API
 * through the product's actual rules.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const B = `http://localhost:${PORT}`;
let child: ChildProcess;

const post = async (url: string, body: object) => {
  const r = await fetch(B + url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() as any };
};
const get = async (url: string) => (await fetch(B + url)).json() as any;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-test-"));
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(dir, "test.db"),
      GOOGLE_CLOUD_API_KEY: "", // force osm provider…
      ANTHROPIC_API_KEY: ""     // …and concierge off
    },
    stdio: "ignore"
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(B + "/api/config")).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("server did not start");
});

after(() => child?.kill());

test("config reflects missing keys: osm provider, AI off", async () => {
  const c = await get("/api/config");
  assert.deepEqual(c, { ai: false, placesProvider: "osm" });
});

test("session lifecycle: create → default South Bay location → join is idempotent", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "test lunch" });
  let s = await get(`/api/sessions/${id}`);
  assert.equal(s.location.label, "South Bay");
  assert.equal(s.cuisines.length > 0, true, "cuisine board is pre-seeded");

  await post(`/api/sessions/${id}/join`, { name: "Ada" });
  await post(`/api/sessions/${id}/join`, { name: "Ada" }); // again
  s = await get(`/api/sessions/${id}`);
  assert.deepEqual(s.members, ["Ada"]);
});

test("time options: proposer auto-votes; voting toggles on/off", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  await post(`/api/sessions/${id}/time-options`, { iso: "2027-01-01T12:00", by: "Ada" });
  let s = await get(`/api/sessions/${id}`);
  assert.deepEqual(s.timeOptions[0].votes, ["Ada"], "proposer auto-vote");

  const opt = s.timeOptions[0].id;
  await post(`/api/sessions/${id}/vote`, { kind: "time", optionId: opt, voter: "Bob" });
  s = await get(`/api/sessions/${id}`);
  assert.equal(s.timeOptions[0].votes.length, 2);
  await post(`/api/sessions/${id}/vote`, { kind: "time", optionId: opt, voter: "Bob" }); // toggle off
  s = await get(`/api/sessions/${id}`);
  assert.deepEqual(s.timeOptions[0].votes, ["Ada"]);
});

test("deadline requires at least one proposed time", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  const r1 = await post(`/api/sessions/${id}/deadline`, { iso: "2027-01-01T12:00:00Z" });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /propose at least one time/i);

  await post(`/api/sessions/${id}/time-options`, { iso: "2027-01-01T12:00", by: "Ada" });
  const r2 = await post(`/api/sessions/${id}/deadline`, { iso: "2027-01-01T10:00:00Z" });
  assert.equal(r2.status, 200);
});

test("when-before-where: place lock gated on locked time, then on gate times", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  await post(`/api/sessions/${id}/ballot`, { place: { name: "Spot", source: "manual" }, by: "Ada" });
  const s = await get(`/api/sessions/${id}`);
  const placeId = s.places[0].id;

  // no locked time → blocked
  const r1 = await post(`/api/sessions/${id}/finalize`, { kind: "place", optionId: placeId });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /lock in a time first/i);

  // lock a PAST meal time → gate passed → allowed
  await post(`/api/sessions/${id}/time-options`, { iso: "2020-01-01T12:00", by: "Ada" });
  const s2 = await get(`/api/sessions/${id}`);
  await post(`/api/sessions/${id}/finalize`, { kind: "time", optionId: s2.timeOptions[0].id });
  const r2 = await post(`/api/sessions/${id}/finalize`, { kind: "place", optionId: placeId });
  assert.equal(r2.status, 200);

  // undo is always allowed
  const r3 = await post(`/api/sessions/${id}/finalize`, { kind: "place", optionId: null });
  assert.equal(r3.status, 200);
});

test("future meal time keeps place lock gated", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  await post(`/api/sessions/${id}/ballot`, { place: { name: "Spot", source: "manual" }, by: "Ada" });
  await post(`/api/sessions/${id}/time-options`, { iso: "2030-01-01T12:00", by: "Ada" });
  const s = await get(`/api/sessions/${id}`);
  await post(`/api/sessions/${id}/finalize`, { kind: "time", optionId: s.timeOptions[0].id });
  const r = await post(`/api/sessions/${id}/finalize`, { kind: "place", optionId: s.places[0].id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /voting stays open/i);
});

test("ballot rejects duplicates by name", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  await post(`/api/sessions/${id}/ballot`, { place: { name: "Napoli", source: "manual" }, by: "Ada" });
  const r = await post(`/api/sessions/${id}/ballot`, { place: { name: "napoli", source: "manual" }, by: "Bob" });
  assert.equal(r.status, 400);
});

test("chat: 280-char cap enforced, empty rejected, oldest-first", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  await post(`/api/sessions/${id}/messages`, { by: "Ada", text: "first" });
  await post(`/api/sessions/${id}/messages`, { by: "Bob", text: "y".repeat(500) });
  const r = await post(`/api/sessions/${id}/messages`, { by: "Ada", text: "   " });
  assert.equal(r.status, 400);

  const s = await get(`/api/sessions/${id}`);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0].text, "first");
  assert.equal(s.messages[1].text.length, 280);
});

test("unknown session → 404; bad vote kind → 400", async () => {
  const r404 = await fetch(B + "/api/sessions/nope");
  assert.equal(r404.status, 404);
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  const r = await post(`/api/sessions/${id}/vote`, { kind: "bogus", optionId: "x", voter: "y" });
  assert.equal(r.status, 400);
});

test("concierge without a key → clean error, not a crash", async () => {
  const { body: { id } } = await post("/api/sessions", { name: "t" });
  const r = await post(`/api/sessions/${id}/concierge`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not configured|at least 2/i);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLeader, placePickUnlocked, suggestDue } from "../src/logic.js";

const HOUR = 3600_000;
const NOW = Date.parse("2026-07-10T12:00:00Z");
const iso = (offsetH: number) => new Date(NOW + offsetH * HOUR).toISOString();

/* ---------------- pickLeader ---------------- */

test("pickLeader: returns null when nothing has votes (poll stays open)", () => {
  assert.equal(pickLeader([{ id: "a", votes: [] }, { id: "b", votes: [] }]), null);
  assert.equal(pickLeader([]), null);
});

test("pickLeader: clear winner by vote count", () => {
  assert.equal(pickLeader([
    { id: "a", votes: ["x"] },
    { id: "b", votes: ["x", "y", "z"] },
    { id: "c", votes: ["x", "y"] }
  ]), "b");
});

test("pickLeader: random tie-break always lands on one of the tied leaders", () => {
  const opts = [
    { id: "a", votes: ["x", "y"] },
    { id: "b", votes: ["p", "q"] },
    { id: "c", votes: ["r"] } // not a leader
  ];
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) seen.add(pickLeader(opts)!);
  assert.ok(!seen.has("c"), "never picks a non-leader");
  assert.ok([...seen].every(id => id === "a" || id === "b"));
});

test("pickLeader: tiebreak comparator wins over insertion order (rating rule)", () => {
  const winner = pickLeader(
    [
      { id: "low", votes: ["x"], rating: 3.9 },
      { id: "high", votes: ["y"], rating: 4.8 }
    ] as any,
    (a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0)
  );
  assert.equal(winner, "high");
});

/* ---------------- placePickUnlocked ---------------- */

const state = (over: object) => ({
  decideBy: null, timeFinal: null, timeOptions: [], ...over
}) as any;

test("placePickUnlocked: no locked time → locked, regardless of deadline", () => {
  assert.equal(placePickUnlocked(state({ decideBy: iso(-2) }), NOW), false);
});

test("placePickUnlocked: locked time, deadline in future, meal in future → locked", () => {
  const s = state({
    decideBy: iso(2), timeFinal: "t1",
    timeOptions: [{ id: "t1", iso: iso(5), votes: [] }]
  });
  assert.equal(placePickUnlocked(s, NOW), false);
});

test("placePickUnlocked: deadline passed → unlocked", () => {
  const s = state({
    decideBy: iso(-1), timeFinal: "t1",
    timeOptions: [{ id: "t1", iso: iso(5), votes: [] }]
  });
  assert.equal(placePickUnlocked(s, NOW), true);
});

test("placePickUnlocked: no deadline, meal time passed → unlocked", () => {
  const s = state({
    timeFinal: "t1",
    timeOptions: [{ id: "t1", iso: iso(-1), votes: [] }]
  });
  assert.equal(placePickUnlocked(s, NOW), true);
});

/* ---------------- suggestDue ---------------- */

test("suggestDue: nothing configured → never", () => {
  assert.equal(suggestDue(state({}), NOW), false);
});

test("suggestDue: fires at the decision deadline", () => {
  assert.equal(suggestDue(state({ decideBy: iso(-0.1) }), NOW), true);
  assert.equal(suggestDue(state({ decideBy: iso(0.1) }), NOW), false);
});

test("suggestDue: fires 1h before the meal when proposed well in advance", () => {
  const s = state({
    timeFinal: "t1",
    timeOptions: [{ id: "t1", iso: iso(0.5), createdAt: NOW - 5 * HOUR, votes: [] }]
  });
  // meal in 30min, proposed 5h ago → meal-1h already passed
  assert.equal(suggestDue(s, NOW), true);
});

test("suggestDue: short-notice meal waits 1h from proposal", () => {
  const s = state({
    timeFinal: "t1",
    // meal in 30min but proposed just 10min ago → trigger = proposal+1h (future)
    timeOptions: [{ id: "t1", iso: iso(0.5), createdAt: NOW - 10 * 60_000, votes: [] }]
  });
  assert.equal(suggestDue(s, NOW), false);
  assert.equal(suggestDue(s, NOW + HOUR), true); // …and fires once the hour is up
});

test("suggestDue: deadline and meal both set → earliest trigger wins", () => {
  const s = state({
    decideBy: iso(-0.1), // already passed
    timeFinal: "t1",
    timeOptions: [{ id: "t1", iso: iso(10), createdAt: NOW, votes: [] }] // meal trigger far off
  });
  assert.equal(suggestDue(s, NOW), true);
});

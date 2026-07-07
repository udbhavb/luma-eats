import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DB_PATH = process.env.DB_PATH || "data/luma.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decide_by TEXT,                -- ISO string, optional deadline
  loc_lat REAL, loc_lng REAL, loc_label TEXT,
  time_final TEXT,               -- time_options.id
  place_final TEXT               -- places.id
);
CREATE TABLE IF NOT EXISTS members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, name)
);
CREATE TABLE IF NOT EXISTS time_options (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  iso TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS cuisines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cuisine TEXT, address TEXT,
  lat REAL, lng REAL,
  rating REAL, rating_count INTEGER, price_level INTEGER,
  maps_url TEXT,
  source TEXT NOT NULL,          -- 'google' | 'osm' | 'manual'
  by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'time' | 'cuisine' | 'place'
  option_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, option_id, voter)
);
`);

// migration for DBs created before time_options.created_at existed
try { db.exec(`ALTER TABLE time_options ADD COLUMN created_at INTEGER`); } catch { /* already there */ }
db.prepare(`UPDATE time_options SET created_at = ? WHERE created_at IS NULL`).run(Date.now());

export const newId = (len = 8) => crypto.randomBytes(len).toString("base64url").slice(0, len);

/* ---------- queries ---------- */

const votesFor = db.prepare(
  `SELECT option_id, voter FROM votes WHERE session_id = ? AND kind = ?`
);

function voteMap(sessionId: string, kind: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const row of votesFor.all(sessionId, kind) as { option_id: string; voter: string }[]) {
    (map[row.option_id] ??= []).push(row.voter);
  }
  return map;
}

export function getState(sessionId: string) {
  const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  const tv = voteMap(sessionId, "time");
  const cv = voteMap(sessionId, "cuisine");
  const pv = voteMap(sessionId, "place");
  return {
    id: s.id,
    name: s.name,
    createdAt: s.created_at,
    decideBy: s.decide_by,
    location: s.loc_lat != null ? { lat: s.loc_lat, lng: s.loc_lng, label: s.loc_label } : null,
    timeFinal: s.time_final,
    placeFinal: s.place_final,
    members: (db.prepare(`SELECT name FROM members WHERE session_id = ? ORDER BY joined_at`).all(sessionId) as any[]).map(m => m.name),
    timeOptions: (db.prepare(`SELECT * FROM time_options WHERE session_id = ?`).all(sessionId) as any[])
      .map(o => ({ id: o.id, iso: o.iso, by: o.by, createdAt: o.created_at, votes: tv[o.id] ?? [] })),
    cuisines: (db.prepare(`SELECT * FROM cuisines WHERE session_id = ?`).all(sessionId) as any[])
      .map(c => ({ id: c.id, name: c.name, emoji: c.emoji, by: c.by, votes: cv[c.id] ?? [] })),
    places: (db.prepare(`SELECT * FROM places WHERE session_id = ?`).all(sessionId) as any[])
      .map(p => ({
        id: p.id, name: p.name, cuisine: p.cuisine, address: p.address,
        lat: p.lat, lng: p.lng, rating: p.rating, ratingCount: p.rating_count,
        priceLevel: p.price_level, mapsUrl: p.maps_url, source: p.source, by: p.by,
        votes: pv[p.id] ?? []
      })),
    // last 200 messages, oldest first — keeps the broadcast payload bounded
    messages: (db.prepare(
      `SELECT id, author, text, created_at FROM messages
       WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
    ).all(sessionId) as any[])
      .reverse()
      .map(m => ({ id: m.id, author: m.author, text: m.text, at: m.created_at }))
  };
}

export type SessionState = NonNullable<ReturnType<typeof getState>>;

export const CUISINE_SEED: [string, string][] = [
  ["Italian", "🍝"], ["Mexican", "🌮"], ["Japanese", "🍣"], ["Indian", "🍛"],
  ["Chinese", "🥡"], ["Thai", "🍜"], ["Burgers", "🍔"], ["Korean", "🍲"]
];

export function createSession(name: string, decideBy?: string | null): string {
  const id = newId(6);
  db.prepare(`INSERT INTO sessions (id, name, created_at, decide_by) VALUES (?, ?, ?, ?)`)
    .run(id, name, Date.now(), decideBy ?? null);
  const ins = db.prepare(`INSERT INTO cuisines (id, session_id, name, emoji, by) VALUES (?, ?, ?, ?, ?)`);
  for (const [n, e] of CUISINE_SEED) ins.run(newId(), id, n, e, "Luma");
  return id;
}

export function toggleVote(sessionId: string, kind: string, optionId: string, voter: string) {
  const del = db.prepare(
    `DELETE FROM votes WHERE session_id = ? AND kind = ? AND option_id = ? AND voter = ?`
  ).run(sessionId, kind, optionId, voter);
  if (del.changes === 0) {
    db.prepare(`INSERT INTO votes (session_id, kind, option_id, voter) VALUES (?, ?, ?, ?)`)
      .run(sessionId, kind, optionId, voter);
  }
}

import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { api } from "./api";
import { MapView } from "./MapView";
import { PollRow, Stars, fmtTime, nameColors, price, toast } from "./ui";
import type { AppConfig, Candidate, Recommendation, SessionState } from "./types";

interface TabProps { s: SessionState; me: string; }

const run = (p: Promise<unknown>) => p.catch(e => toast((e as Error).message));

/* ================= WHEN ================= */

export function WhenTab({ s, me }: TabProps) {
  const [val, setVal] = useState("");
  const [deadline, setDeadline] = useState("");
  const finalOpt = s.timeOptions.find(o => o.id === s.timeFinal);
  const max = Math.max(0, ...s.timeOptions.map(o => o.votes.length));

  return (
    <div className="card">
      <h2>🕐 When are we eating?</h2>
      <p className="sub">Propose times, tap to vote. Anyone can hit “Pick” when there's a clear winner.</p>

      {finalOpt && (
        <div className="banner ok">
          Locked in: <b>{fmtTime(finalOpt.iso)}</b>{" "}
          <a href="#" onClick={e => { e.preventDefault(); run(api.finalize(s.id, "time", null)); }}>undo</a>
        </div>
      )}

      {[...s.timeOptions].sort((a, b) => b.votes.length - a.votes.length).map(o => (
        <PollRow
          key={o.id}
          title={fmtTime(o.iso)}
          meta={`suggested by ${o.by}`}
          votes={o.votes}
          totalMembers={s.members.length}
          mine={o.votes.includes(me)}
          isWinner={s.timeFinal === o.id}
          isLeader={!s.timeFinal && o.votes.length === max && max > 0}
          onToggle={() => run(api.vote(s.id, "time", o.id, me))}
          onPick={s.timeFinal ? undefined : () => run(api.finalize(s.id, "time", o.id))}
        />
      ))}

      <div className="row" style={{ marginTop: 12 }}>
        <input type="datetime-local" value={val} onChange={e => setVal(e.target.value)} />
        <button onClick={() => { if (val) { run(api.addTime(s.id, val, me)); setVal(""); } }}>Add</button>
      </div>

      {s.timeOptions.length === 0 ? (
        <p className="sub" style={{ marginTop: 14 }}>
          ⏳ Propose a time and you'll be able to set a decision deadline.
        </p>
      ) : (
      <details style={{ marginTop: 14 }}>
        <summary className="sub" style={{ cursor: "pointer" }}>
          ⏳ {s.decideBy ? "Change decision deadline" : "Set a decision deadline (optional)"}
        </summary>
        <p className="sub" style={{ marginTop: 8 }}>
          When the deadline hits, the top-voted time and place lock in automatically — no more dithering.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} />
          <button className="sec" onClick={() => { if (deadline) run(api.setDeadline(s.id, new Date(deadline).toISOString())); }}>Set</button>
          {s.decideBy && <button className="ghost" onClick={() => run(api.setDeadline(s.id, null))}>Clear</button>}
        </div>
      </details>
      )}
    </div>
  );
}

/* ================= CUISINE ================= */

const CUISINE_SUGGESTIONS: [string, string][] = [
  ["Thai", "🍜"], ["Pizza", "🍕"], ["Mediterranean", "🥙"], ["Vietnamese", "🍲"],
  ["BBQ", "🍖"], ["Vegan", "🥗"], ["Sushi", "🍱"], ["Breakfast", "🥞"]
];

export function CuisineTab({ s, me }: TabProps) {
  const [val, setVal] = useState("");
  const existing = new Set(s.cuisines.map(c => c.name.toLowerCase()));
  const suggestions = CUISINE_SUGGESTIONS.filter(([n]) => !existing.has(n.toLowerCase()));

  const add = (name: string, emoji = "🍽️") => {
    if (!name.trim()) return;
    const hit = CUISINE_SUGGESTIONS.find(([n]) => n.toLowerCase() === name.trim().toLowerCase());
    run(api.addCuisine(s.id, name.trim(), hit ? hit[1] : emoji, me));
    setVal("");
  };

  return (
    <div className="card">
      <h2>🍜 What are we craving?</h2>
      <p className="sub">Tap to vote — top picks drive the restaurant search. Suggest anything.</p>

      <div className="chips">
        {[...s.cuisines].sort((a, b) => b.votes.length - a.votes.length).map(c => (
          <button
            key={c.id}
            className={`chip ${c.votes.includes(me) ? "on" : ""}`}
            title={c.votes.join(", ")}
            onClick={() => run(api.vote(s.id, "cuisine", c.id, me))}
          >
            {c.emoji} {c.name}
            {c.votes.length > 0 && <span className="n">{c.votes.length}</span>}
          </button>
        ))}
      </div>

      {suggestions.length > 0 && (
        <>
          <p className="sub" style={{ marginTop: 14 }}>Quick add:</p>
          <div className="chips">
            {suggestions.map(([n, e]) => (
              <button key={n} className="chip" style={{ opacity: 0.65 }} onClick={() => add(n, e)}>
                {e} {n} +
              </button>
            ))}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="Suggest a cuisine…"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add(val)}
        />
        <button onClick={() => add(val)}>Add</button>
      </div>
    </div>
  );
}

/* ================= PLACES ================= */

export function PlacesTab({ s, me, config }: TabProps & { config: AppConfig }) {
  const [addr, setAddr] = useState("");
  const [manual, setManual] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Candidate[]>([]);
  const [searchedFor, setSearchedFor] = useState<string[]>([]);

  const topCuisines = s.cuisines
    .filter(c => c.votes.length > 0)
    .sort((a, b) => b.votes.length - a.votes.length)
    .slice(0, 3);

  const search = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.searchPlaces(s.id);
      setResults(r.results);
      setSearchedFor(r.cuisines);
      if (!r.results.length) setError("No matches nearby — try voting for different cuisines or add a place manually.");
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  const useMyLocation = () => {
    navigator.geolocation.getCurrentPosition(
      pos => run(api.setLocation(s.id, { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "shared location" })),
      () => toast("Couldn't get your location — type an address instead")
    );
  };

  const onBallot = new Set(s.places.map(p => p.name.toLowerCase()));

  return (
    <div className="card">
      <h2>📍 Find places nearby</h2>

      {!s.location ? (
        <>
          <p className="sub">Where's the group? Everyone shares this location.</p>
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              placeholder="Address or neighborhood…"
              value={addr}
              onChange={e => setAddr(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addr && run(api.setLocation(s.id, { query: addr }))}
            />
            <button onClick={() => addr && run(api.setLocation(s.id, { query: addr }))}>Set</button>
          </div>
          <button className="sec" onClick={useMyLocation}>📱 Use my location</button>
        </>
      ) : (
        <>
          <p className="sub">
            Near <b>{s.location.label}</b>{" "}
            <a href="#" onClick={e => { e.preventDefault(); run(api.setLocation(s.id, {})); setResults([]); }}>change</a>
          </p>
          <p className="sub">
            {topCuisines.length
              ? <>Top cuisines: {topCuisines.map(c => <b key={c.id}>{c.emoji} {c.name}  </b>)}</>
              : "No cuisine votes yet — searching all restaurants."}
          </p>
          <button onClick={search} disabled={loading}>
            {loading ? <><span className="spin" /> Searching…</> : "🔎 Find restaurants"}
          </button>
        </>
      )}

      {error && <div className="banner warn">{error}</div>}

      {s.location && results.length > 0 && (
        <div style={{ margin: "12px 0" }}>
          <MapView
            center={s.location}
            pins={results.filter(r => r.lat != null).map(r => ({ lat: r.lat!, lng: r.lng!, label: r.name }))}
          />
        </div>
      )}

      {results.map(p => (
        <div className="place-card" key={p.name}>
          <div className="place-head">
            <b>{p.name}</b>
            <Stars rating={p.rating} count={p.ratingCount} />
          </div>
          <div style={{ margin: "4px 0" }}>
            {p.cuisine && <span className="badge">{p.cuisine}</span>}
            {p.priceLevel != null && <span className="badge">{price(p.priceLevel)}</span>}
            {p.distKm != null && <span className="badge">{p.distKm} km</span>}
          </div>
          {p.address && <div className="sub" style={{ margin: 0 }}>{p.address}</div>}
          <div className="place-actions">
            <button
              className="sec pick-btn"
              disabled={onBallot.has(p.name.toLowerCase())}
              onClick={() => run(api.addToBallot(s.id, p, me).then(() => toast("Added to the ballot 🗳️")))}
            >
              {onBallot.has(p.name.toLowerCase()) ? "✓ On ballot" : "+ Add to ballot"}
            </button>
            <a className="sub" style={{ margin: 0 }} href={p.mapsUrl} target="_blank" rel="noopener noreferrer">
              {config.placesProvider === "google" ? "open in Maps ↗" : "check reviews ↗"}
            </a>
          </div>
        </div>
      ))}

      <details style={{ marginTop: 12 }}>
        <summary className="sub" style={{ cursor: "pointer" }}>Add a place manually</summary>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Restaurant name" value={manual} onChange={e => setManual(e.target.value)} />
          <button onClick={() => {
            if (!manual.trim()) return;
            run(api.addToBallot(s.id, { name: manual.trim(), source: "manual" }, me).then(() => toast("Added 🗳️")));
            setManual("");
          }}>Add</button>
        </div>
      </details>

      {searchedFor.length > 0 && config.placesProvider === "osm" && (
        <p className="sub" style={{ marginTop: 10 }}>
          Place data © OpenStreetMap contributors. Ratings need a Google key (see README) — until then, tap “check reviews”.
        </p>
      )}
    </div>
  );
}

/* ================= CHAT ================= */

const MSG_MAX = 280;

export function ChatTab({ s, me }: TabProps) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // stick to the newest message when one arrives
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [s.messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    run(api.postMessage(s.id, t, me));
    setText("");
  };

  const fmtAt = (at: number) => {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  };

  return (
    <div className="card">
      <h2>💬 Discussion</h2>
      <p className="sub">Make your case — “their tacos slap”, “I can't do Thursday”…</p>

      <div className="chat-list">
        {s.messages.length === 0 && <p className="sub" style={{ textAlign: "center" }}>No messages yet — start the debate.</p>}
        {s.messages.map(m => (
          <div key={m.id} className={`msg ${m.author === me ? "mine" : ""}`}>
            <span className="avatar" title={m.author} style={nameColors(m.author)}>
              {m.author.slice(0, 2).toUpperCase()}
            </span>
            <div className="msg-body">
              <div className="msg-head">
                <b>{m.author === me ? "you" : m.author}</b>
                <span>{fmtAt(m.at)}</span>
              </div>
              <div className="msg-text">{m.text}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
        <input
          placeholder="Say something…"
          value={text}
          maxLength={MSG_MAX}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={!text.trim()}>Send</button>
      </div>
      {text.length > MSG_MAX - 60 && (
        <p className="sub" style={{ textAlign: "right", margin: "4px 0 0" }}>{MSG_MAX - text.length} left</p>
      )}
    </div>
  );
}

/** Compact strip of the latest chatter, shown under every non-chat tab so the
 * discussion stays visible while people vote. Click-through opens the chat. */
export function ChatPeek({ s, onOpen }: { s: SessionState; onOpen: () => void }) {
  if (s.messages.length === 0) return null;
  const recent = s.messages.slice(-3);
  return (
    <div className="chat-peek" onClick={onOpen} title="Open the discussion">
      {recent.map(m => (
        <div key={m.id} className="peek-line">
          <span className="avatar" style={nameColors(m.author)}>{m.author.slice(0, 2).toUpperCase()}</span>
          <span className="peek-text"><b>{m.author}</b>  {m.text}</span>
        </div>
      ))}
      <div className="peek-more">💬 {s.messages.length} message{s.messages.length === 1 ? "" : "s"} — join the discussion →</div>
    </div>
  );
}

/* ================= VOTE ================= */

export function VoteTab({ s, me, config }: TabProps & { config: AppConfig }) {
  const finalPlace = s.places.find(p => p.id === s.placeFinal);
  const finalTime = s.timeOptions.find(o => o.id === s.timeFinal);
  const max = Math.max(0, ...s.places.map(p => p.votes.length));
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [thinking, setThinking] = useState(false);
  const celebrated = useRef(false);

  // manual Pick unlocks when the decision deadline or the meal time passes
  // (mirrors the server rule; re-checked every 10s so it flips live)
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const gates = [s.decideBy, finalTime?.iso]
    .filter((x): x is string => !!x).map(x => Date.parse(x)).filter(t => !isNaN(t));
  const pickUnlocked = !!finalTime && gates.some(t => Date.now() >= t);
  const gateLabel = gates.length ? fmtTime(new Date(Math.min(...gates)).toISOString()) : null;

  useEffect(() => {
    if (finalPlace && !celebrated.current) {
      celebrated.current = true;
      confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
    }
    if (!finalPlace) celebrated.current = false;
  }, [finalPlace]);

  const askConcierge = async () => {
    setThinking(true);
    try { setRec(await api.concierge(s.id)); }
    catch (e) { toast((e as Error).message); }
    setThinking(false);
  };

  const recPlace = rec && s.places.find(p => p.id === rec.placeId);

  return (
    <div className="card">
      <h2>🗳️ Final vote</h2>
      <p className="sub">Everything added from the Places tab lands here. Tap to vote.</p>

      {finalPlace && (
        <div className="final-banner">
          🎉 We're eating at
          <div style={{ fontSize: "1.35rem", fontWeight: 800, margin: "4px 0" }}>{finalPlace.name}</div>
          {finalTime && <div>{fmtTime(finalTime.iso)}</div>}
          <div style={{ marginTop: 8 }}>
            <a href={finalPlace.mapsUrl} target="_blank" rel="noopener noreferrer">Open in Maps ↗</a>
            {" · "}
            <a href="#" onClick={e => { e.preventDefault(); run(api.finalize(s.id, "place", null)); }}>undo</a>
          </div>
        </div>
      )}

      {s.places.length === 0 && <p className="sub">Nothing on the ballot yet — head to 📍 Places.</p>}

      {!finalPlace && !pickUnlocked && s.places.length > 0 && (
        <div className="banner warn">
          {finalTime
            ? <>🔒 Voting is open — the winner locks {gateLabel} (or anyone can pick manually after that).</>
            : <>🔒 Plans need a <b>when</b> before a <b>where</b> — lock a time in the 🕐 When tab, or set a deadline and the top-voted time locks itself.</>}
        </div>
      )}

      {[...s.places].sort((a, b) => b.votes.length - a.votes.length).map(p => (
        <PollRow
          key={p.id}
          title={p.name}
          meta={[p.cuisine, p.rating != null ? `★ ${p.rating}` : "", p.address, `added by ${p.by}`]
            .filter(Boolean).join(" · ")}
          votes={p.votes}
          totalMembers={s.members.length}
          mine={p.votes.includes(me)}
          isWinner={s.placeFinal === p.id}
          isLeader={!s.placeFinal && p.votes.length === max && max > 0}
          onToggle={() => run(api.vote(s.id, "place", p.id, me))}
          onPick={s.placeFinal || !pickUnlocked ? undefined : () => run(api.finalize(s.id, "place", p.id))}
        />
      ))}

      {config.ai && s.places.length >= 2 && !finalPlace && (
        <div style={{ marginTop: 14 }}>
          {!rec && (
            <button className="sec" onClick={askConcierge} disabled={thinking}>
              {thinking ? <><span className="spin" /> Luma is weighing the votes…</> : "🤖 Can't decide? Ask Luma to break the tie"}
            </button>
          )}
          {rec && recPlace && (
            <div className="concierge">
              <b>🤖 Luma suggests: {recPlace.name}</b>
              <p style={{ margin: "6px 0" }}>{rec.reasoning}</p>
              <div className="row">
                {pickUnlocked ? (
                  <button onClick={() => { run(api.finalize(s.id, "place", rec.placeId)); setRec(null); }}>
                    Go with it 🎉
                  </button>
                ) : (
                  <button onClick={() => {
                    if (!recPlace.votes.includes(me)) run(api.vote(s.id, "place", rec.placeId, me));
                    setRec(null);
                  }}>
                    Vote for it 👍
                  </button>
                )}
                <button className="ghost" onClick={() => setRec(null)}>Keep voting</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

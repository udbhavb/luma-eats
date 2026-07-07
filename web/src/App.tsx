import { useEffect, useState } from "react";
import { api, useSession } from "./api";
import { CuisineTab, PlacesTab, VoteTab, WhenTab } from "./tabs";
import { Countdown, toast } from "./ui";
import type { AppConfig } from "./types";

const TABS = [
  ["when", "🕐", "When"],
  ["cuisine", "🍜", "Cuisine"],
  ["places", "📍", "Places"],
  ["vote", "🗳️", "Vote"]
] as const;
type TabId = (typeof TABS)[number][0];

const sessionIdFromPath = () => {
  const m = location.pathname.match(/^\/s\/([\w-]+)/);
  return m ? m[1] : null;
};

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(sessionIdFromPath());
  const [me, setMe] = useState<string | null>(sessionId ? localStorage.getItem("luma_nick_" + sessionId) : null);
  const [tab, setTab] = useState<TabId>("when");
  const [config, setConfig] = useState<AppConfig>({ ai: false, placesProvider: "osm" });
  const state = useSession(sessionId);

  useEffect(() => { api.config().then(setConfig).catch(() => {}); }, []);

  const create = async (name: string) => {
    try {
      const { id } = await api.createSession(name);
      history.pushState(null, "", `/s/${id}`);
      setSessionId(id);
    } catch (e) { toast((e as Error).message); }
  };

  const join = async (name: string) => {
    if (!sessionId) return;
    try {
      await api.join(sessionId, name);
      localStorage.setItem("luma_nick_" + sessionId, name);
      setMe(name);
    } catch (e) { toast((e as Error).message); }
  };

  const share = async () => {
    if (!state) return;
    const text = `🍜 Help decide where we eat! Join "${state.name}": ${location.href}`;
    if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(text);
    toast("Invite copied — paste it into WhatsApp or iMessage");
  };

  /* ---- landing ---- */
  if (!sessionId) return <Landing onCreate={create} />;

  /* ---- loading / not found ---- */
  if (state === undefined) return <p className="sub" style={{ marginTop: 60, textAlign: "center" }}><span className="spin" /> Loading…</p>;
  if (state === null) return (
    <div className="card" style={{ marginTop: 60 }}>
      <h2>Session not found 😕</h2>
      <p className="sub">The link may be wrong, or this session was cleaned up.</p>
      <button onClick={() => { history.pushState(null, "", "/"); setSessionId(null); }}>Start a new one</button>
    </div>
  );

  /* ---- join gate ---- */
  if (!me) return <JoinGate name={state.name} memberCount={state.members.length} onJoin={join} />;

  /* ---- main ---- */
  return (
    <>
      <div className="topbar">
        <div>
          <h1>🍜 {state.name}</h1>
          <div className="avatars">
            {state.members.map(m => (
              <span className="avatar" key={m} title={m}>{m.slice(0, 2).toUpperCase()}</span>
            ))}
          </div>
          {state.decideBy && <Countdown iso={state.decideBy} />}
        </div>
        <button className="sec" onClick={share}>📤 Invite</button>
      </div>

      {tab === "when" && <WhenTab s={state} me={me} />}
      {tab === "cuisine" && <CuisineTab s={state} me={me} />}
      {tab === "places" && <PlacesTab s={state} me={me} config={config} />}
      {tab === "vote" && <VoteTab s={state} me={me} config={config} />}

      <footer>Luma Eat · you're {me} · {state.members.length} deciding</footer>

      <nav className="tabs">
        {TABS.map(([id, ico, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <span className="ico">{ico}</span>
            {label}
            {id === "vote" && state.places.length > 0 && <span className="pill">{state.places.length}</span>}
          </button>
        ))}
      </nav>
    </>
  );
}

function Landing({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <>
      <div className="hero">
        <div className="logo">🍜</div>
        <h1>Luma Eat</h1>
        <p className="sub">Decide when, what, and where to eat — together, fast.</p>
      </div>
      <div className="card">
        <h2>Start a food session</h2>
        <div className="row">
          <input
            placeholder='e.g. "Friday team lunch"'
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && name.trim() && onCreate(name.trim())}
          />
          <button onClick={() => name.trim() && onCreate(name.trim())}>Create</button>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          You'll get a link to share over WhatsApp or iMessage — no accounts, just nicknames.
        </p>
      </div>
    </>
  );
}

function JoinGate({ name, memberCount, onJoin }: { name: string; memberCount: number; onJoin: (n: string) => void }) {
  const [nick, setNick] = useState("");
  return (
    <>
      <div className="hero">
        <div className="logo">🍜</div>
        <h1>{name}</h1>
        <p className="sub">{memberCount > 0 ? `${memberCount} deciding where to eat` : "Be the first to join"}</p>
      </div>
      <div className="card">
        <h2>What's your name?</h2>
        <div className="row">
          <input
            placeholder="Nickname"
            maxLength={20}
            value={nick}
            onChange={e => setNick(e.target.value)}
            onKeyDown={e => e.key === "Enter" && nick.trim() && onJoin(nick.trim())}
            autoFocus
          />
          <button onClick={() => nick.trim() && onJoin(nick.trim())}>Join</button>
        </div>
      </div>
    </>
  );
}

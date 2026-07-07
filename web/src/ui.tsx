import { useEffect, useState } from "react";

/* ---- toast ---- */
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(msg: string) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el!.style.opacity = "0"), 2400);
}

/* ---- star rating ---- */
export function Stars({ rating, count }: { rating: number | null; count: number | null }) {
  if (rating == null) return null;
  return (
    <span className="stars">
      ★ {rating.toFixed(1)}
      {count != null && <span style={{ color: "var(--muted)", fontWeight: 500 }}> ({count.toLocaleString()})</span>}
    </span>
  );
}

export const price = (level: number | null) => (level ? "$".repeat(level) : "");

/* ---- countdown chip ---- */
export function Countdown({ iso }: { iso: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Date.parse(iso) - Date.now();
  if (isNaN(ms)) return null;
  const late = ms <= 0;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000), m = Math.floor((abs % 3600000) / 60000), s = Math.floor((abs % 60000) / 1000);
  const txt = h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  return (
    <span className={`countdown ${late ? "late" : ""}`}>
      ⏳ {late ? "time's up — top votes locked in" : `${txt} until top votes lock in`}
    </span>
  );
}

/* ---- generic poll row ---- */
export interface PollRowProps {
  title: string;
  meta?: string;
  votes: string[];
  totalMembers: number;
  mine: boolean;
  isWinner?: boolean;
  isLeader?: boolean;
  onToggle: () => void;
  onPick?: () => void;
  trailing?: React.ReactNode;
}

export function PollRow(p: PollRowProps) {
  return (
    <div className={`opt ${p.mine ? "voted" : ""} ${p.isWinner ? "winner" : ""}`} onClick={p.onToggle}>
      <div className="grow">
        <div className="title">
          {p.isWinner ? "✅ " : p.isLeader ? "⭐ " : ""}
          {p.title}
        </div>
        {p.meta && <div className="meta">{p.meta}</div>}
        {p.votes.length > 0 && <div className="who">{p.votes.join(", ")}</div>}
        <div className="bar" style={{ width: `${(p.votes.length / Math.max(1, p.totalMembers)) * 100}%` }} />
      </div>
      <div className="count">{p.votes.length}</div>
      {p.trailing}
      {p.onPick && (
        <button
          className="sec pick-btn"
          onClick={e => { e.stopPropagation(); p.onPick!(); }}
        >
          Pick
        </button>
      )}
    </div>
  );
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

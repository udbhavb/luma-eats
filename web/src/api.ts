import { useEffect, useRef, useState } from "react";
import type { SessionState, AppConfig } from "./types";

async function req<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error || `Request failed (${r.status})`);
  return j as T;
}

export const api = {
  config: () => req<AppConfig>("/api/config"),
  createSession: (name: string) => req<{ id: string }>("/api/sessions", { name }),
  getSession: (id: string) => req<SessionState>(`/api/sessions/${id}`),
  join: (id: string, name: string) => req(`/api/sessions/${id}/join`, { name }),
  addTime: (id: string, iso: string, by: string) => req(`/api/sessions/${id}/time-options`, { iso, by }),
  addCuisine: (id: string, name: string, emoji: string, by: string) =>
    req(`/api/sessions/${id}/cuisines`, { name, emoji, by }),
  vote: (id: string, kind: string, optionId: string, voter: string) =>
    req(`/api/sessions/${id}/vote`, { kind, optionId, voter }),
  setLocation: (id: string, body: object) => req(`/api/sessions/${id}/location`, body),
  searchPlaces: (id: string) => req<{ results: import("./types").Candidate[]; cuisines: string[]; provider: string }>(
    `/api/sessions/${id}/search-places`, {}),
  addToBallot: (id: string, place: object, by: string) => req(`/api/sessions/${id}/ballot`, { place, by }),
  finalize: (id: string, kind: "time" | "place", optionId: string | null) =>
    req(`/api/sessions/${id}/finalize`, { kind, optionId }),
  setDeadline: (id: string, iso: string | null) => req(`/api/sessions/${id}/deadline`, { iso }),
  concierge: (id: string) => req<import("./types").Recommendation>(`/api/sessions/${id}/concierge`, {})
};

/** Live session state: WebSocket with polling fallback. */
export function useSession(id: string | null) {
  const [state, setState] = useState<SessionState | null | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let poll: ReturnType<typeof setInterval> | null = null;

    api.getSession(id).then(s => alive && setState(s)).catch(() => alive && setState(null));

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?session=${id}`);
      wsRef.current = ws;
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === "state" && alive) setState(msg.state);
      };
      ws.onopen = () => { if (poll) { clearInterval(poll); poll = null; } };
      ws.onclose = () => {
        if (!alive) return;
        poll ??= setInterval(() => api.getSession(id).then(s => alive && setState(s)).catch(() => {}), 4000);
        setTimeout(() => alive && connect(), 3000);
      };
    };
    connect();

    return () => {
      alive = false;
      wsRef.current?.close();
      if (poll) clearInterval(poll);
    };
  }, [id]);

  return state; // undefined = loading, null = not found
}

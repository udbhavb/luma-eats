/**
 * Tie-break concierge: when the group stalls, Claude reads the full session
 * (votes, voters, ratings, distances, the chosen time) and makes one decisive
 * recommendation with reasoning the group can rally behind.
 */
import type { SessionState } from "./db.js";

const KEY = process.env.ANTHROPIC_API_KEY?.trim();
export const aiEnabled = !!KEY && !/^(sk-ant-)?x+$/i.test(KEY ?? "");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export interface Recommendation {
  placeId: string;
  reasoning: string;
  runnerUpId: string | null;
}

/** Best-effort JSON extraction: exact parse, then greedy {...}, then lazy. */
function tryParseJson(text: string): any | null {
  const candidates = [
    text.trim(),
    text.match(/\{[\s\S]*\}/)?.[0],
    text.match(/\{[\s\S]*?\}/)?.[0]
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

export async function recommend(state: SessionState): Promise<Recommendation> {
  if (!aiEnabled) throw new Error("ANTHROPIC_API_KEY not configured");
  if (state.places.length < 2) throw new Error("Need at least 2 places on the ballot");

  const summary = {
    group: state.members,
    decidedTime: state.timeOptions.find(t => t.id === state.timeFinal)?.iso ?? null,
    cuisineVotes: state.cuisines
      .filter(c => c.votes.length)
      .map(c => ({ cuisine: c.name, votes: c.votes })),
    ballot: state.places.map(p => ({
      id: p.id, name: p.name, cuisine: p.cuisine, rating: p.rating,
      ratingCount: p.ratingCount, priceLevel: p.priceLevel,
      votes: p.votes, votedBy: p.votes
    })),
    // recent discussion — often carries the real constraints ("can't do
    // Thursday", "somewhere veg-friendly please") that votes don't capture
    chat: state.messages.slice(-30).map(m => ({ from: m.author, said: m.text }))
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEY!,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system:
        "You are Luma, a warm and decisive food concierge helping a group break a deadlock on where to eat. " +
        "Weigh: vote counts, how many DIFFERENT people are satisfied (breadth beats depth), ratings and review counts, " +
        "and cuisine preferences. The chat messages often carry the real constraints — dietary needs, budget, " +
        "availability, strong feelings — treat a stated constraint as outweighing a vote count, and when chat sways " +
        "your pick, cite the person by name (e.g. \"Priya's veg-friendly ask\"). Be decisive — pick exactly one. " +
        "Keep reasoning to 2-3 sentences, friendly and concrete (mention who gets what they wanted). " +
        "Deliver your answer by calling the recommend_place tool.",
      // forced tool use = structured output without text parsing; works across
      // models (assistant prefill doesn't on the newest ones)
      tools: [{
        name: "recommend_place",
        description: "Deliver the final restaurant recommendation for the group",
        input_schema: {
          type: "object",
          properties: {
            placeId: { type: "string", description: "id of the chosen place from the ballot" },
            reasoning: { type: "string", description: "2-3 friendly, concrete sentences" },
            runnerUpId: { type: "string", description: "id of the second-best ballot place, if any" }
          },
          required: ["placeId", "reasoning"]
        }
      }],
      tool_choice: { type: "tool", name: "recommend_place" },
      messages: [{ role: "user", content: JSON.stringify(summary) }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const j: any = await r.json();
  const parsed = (j.content ?? []).find((b: any) => b.type === "tool_use")?.input
    // fallback: some setups still answer in text — salvage JSON if present
    ?? tryParseJson((j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
  if (!parsed) {
    console.warn("concierge unparseable, raw content:", JSON.stringify(j.content).slice(0, 500),
      "stop_reason:", j.stop_reason);
    throw new Error("The concierge rambled instead of answering — try again");
  }
  if (!state.places.some(p => p.id === parsed.placeId)) {
    throw new Error("Concierge picked an unknown place");
  }
  return {
    placeId: parsed.placeId,
    reasoning: String(parsed.reasoning ?? ""),
    runnerUpId: state.places.some(p => p.id === parsed.runnerUpId) ? parsed.runnerUpId : null
  };
}

/**
 * Pure decision rules — no DB, no clock side effects (callers pass `now`).
 * Extracted from the server so they can be unit-tested directly; these few
 * functions ARE the product's contract:
 *   - pickLeader: who wins a poll (and how ties break)
 *   - placePickUnlocked: when a place may be manually locked
 *   - suggestDue: when Luma should auto-fill an empty ballot
 */

export interface Votable { id: string; votes: string[]; }

export interface TimeOptionLike extends Votable {
  iso: string;
  createdAt?: number | null;
}

export interface DecisionStateLike {
  decideBy: string | null;
  timeFinal: string | null;
  timeOptions: TimeOptionLike[];
}

/** Highest-voted option. Zero votes everywhere → null (a poll nobody voted in
 * stays open). Ties: with a tiebreak comparator, best sorts first; without
 * one, tied leaders are equally good and one is picked at random. */
export function pickLeader<T extends Votable>(
  opts: T[],
  tiebreak?: (a: T, b: T) => number
): string | null {
  const max = Math.max(0, ...opts.map(o => o.votes.length));
  if (max === 0) return null;
  const leaders = opts.filter(o => o.votes.length === max);
  if (tiebreak) leaders.sort(tiebreak);
  return (tiebreak ? leaders[0] : leaders[Math.floor(Math.random() * leaders.length)]).id;
}

/** Plans need a *when* before a *where*: a place can only be locked once a
 * time is locked, and only after the decision deadline or the meal time
 * passes — early "Pick"s would short-circuit the vote. */
export function placePickUnlocked(state: DecisionStateLike, now = Date.now()): boolean {
  if (!state.timeFinal) return false;
  const gates = [
    state.decideBy,
    state.timeOptions.find(o => o.id === state.timeFinal)?.iso
  ].filter((x): x is string => !!x).map(x => Date.parse(x)).filter(t => !isNaN(t));
  return gates.some(t => now >= t);
}

/** When should Luma step in and suggest places for an empty ballot?
 *  - at the decision deadline, and/or
 *  - 1h before the locked meal time — but never sooner than 1h after that
 *    winning time was proposed (a meal locked on short notice still gives
 *    the group their hour). Both configured → whichever comes first. */
export function suggestDue(state: DecisionStateLike, now = Date.now()): boolean {
  const triggers: number[] = [];
  if (state.decideBy && !isNaN(Date.parse(state.decideBy))) triggers.push(Date.parse(state.decideBy));
  const meal = state.timeOptions.find(o => o.id === state.timeFinal);
  if (meal && !isNaN(Date.parse(meal.iso))) {
    triggers.push(Math.max(Date.parse(meal.iso) - 3600_000, (meal.createdAt ?? 0) + 3600_000));
  }
  return triggers.length > 0 && Math.min(...triggers) <= now;
}

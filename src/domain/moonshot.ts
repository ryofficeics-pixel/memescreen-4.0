import type { TokenCandidate } from "./types.js";

/**
 * MOONSHOT POTENTIAL DETECTOR
 *
 * Why this exists: this scanner's own ANSEM case study (see opportunity.ts)
 * documents a token that ran 10-100x liquidity turnover on a sub-$200K pool.
 * A meme coin capable of that kind of move needs to be *flagged* as a
 * different risk/reward category than an ordinary alert-tier token — and a
 * trader riding one of these should not be using the same fixed 50-100%
 * take-profit that makes sense for a normal token, because that caps the
 * trade at a tiny fraction of the coin's realistic upside and guarantees
 * the position gets closed out long before a genuine 50x-100x move plays
 * out.
 *
 * This module does three things:
 *   1. Scores how strongly a candidate matches the "extreme mover" profile
 *      (thin/micro liquidity + explosive turnover + fresh + already moving)
 *      — independent of the normal opportunity/risk scoring, which is
 *      tuned for the median token, not the tail.
 *   2. Weights that profile across the full documented high-probability
 *      window — most meme coin blow-off moves happen within 48h of the
 *      pool going live, not just the first few hours — so a 20h-old token
 *      isn't scored as if its window has already closed.
 *   3. Detects pumps that have *already happened* by comparing the current
 *      price against this scanner's own recorded first-seen price and
 *      running peak (see repository.ts's first_seen_price_usd/peak_price_usd
 *      columns). This matters specifically because of scan cadence: a
 *      1-2h poll interval can land entirely between a pump and its
 *      reversal, and DexScreener's own rolling windows (max 24h) can miss
 *      a move that happened 24-48h before the current scan. Comparing
 *      against our own stored history catches it regardless of when
 *      within the 48h window it happened or how it lines up with our poll
 *      timing.
 *
 * Everything here is a *suggestion* surfaced to the user (dashboard +
 * Telegram) — it never auto-sets a position's TP. See positionsRepository's
 * trailing-stop mechanism for how positions actually ride these moves
 * without needing to guess the exact top in advance.
 */

export interface PriceHistory {
  firstSeenPriceUsd: number | null;
  peakPriceUsd:       number | null;
}

export interface MoonshotResult {
  /** 0-100. How strongly this candidate matches the extreme-mover profile. */
  moonshotScore: number;
  /** score >= MOONSHOT_FLAG_THRESHOLD */
  isMoonshotCandidate: boolean;
  reasons: string[];
  /** Suggested take-profit ceiling, as a multiple of entry price (e.g. 50 = 50x). */
  suggestedTpMultiplier: number;
  /** Same suggestion expressed as a %, for UI fields that expect tp_pct (e.g. 50x = 4900%). */
  suggestedTpPct: number;
  /** Suggested stop-loss %. Wider than the normal default — thin moonshot pools whipsaw harder. */
  suggestedSlPct: number;
  /** age <= PUMP_WINDOW_MINUTES (48h) — still within the documented high-probability window. */
  withinPumpWindow: boolean;
  /** peakPriceUsd / firstSeenPriceUsd, from this scanner's own recorded history. Null if not yet known. */
  cumulativeMultipleFromFirstSeen: number | null;
  /** True once cumulativeMultipleFromFirstSeen crosses PUMP_CONFIRMED_MULTIPLE — a pump has *already* been captured in the data, whether or not it was seen live. */
  pumpAlreadyDetected: boolean;
}

const MOONSHOT_FLAG_THRESHOLD = 55;
/** Meme coin pumps documented empirically to concentrate in the 48h after a pool goes live. */
const PUMP_WINDOW_MINUTES = 48 * 60;
/** Minimum peak/first-seen multiple to count as a confirmed (already-happened) pump. */
const PUMP_CONFIRMED_MULTIPLE = 3;

export function assessMoonshotPotential(
  candidate: TokenCandidate,
  priceHistory?: PriceHistory
): MoonshotResult {
  let score = 0;
  const reasons: string[] = [];

  // Extreme turnover: volume many multiples of the pool's own liquidity in
  // 24h is the single strongest tell for a token capable of a 10-100x move
  // (this is the exact ANSEM mechanic — see opportunity.ts).
  if (candidate.liquidityUsd > 0 && candidate.volume24hUsd > 0) {
    const turnoverRatio = candidate.volume24hUsd / candidate.liquidityUsd;
    if (turnoverRatio >= 30)      { score += 35; reasons.push("turnover_100x_tier"); }
    else if (turnoverRatio >= 15) { score += 25; reasons.push("turnover_extreme"); }
    else if (turnoverRatio >= 8)  { score += 12; reasons.push("turnover_elevated"); }
  }

  // Micro liquidity pools have the most room to run a large multiple —
  // a $2M pool realistically cannot 100x on organic volume, a $20K one can.
  if (candidate.liquidityUsd > 0) {
    if (candidate.liquidityUsd < 30_000)      { score += 20; reasons.push("micro_pool_under_30k"); }
    else if (candidate.liquidityUsd < 100_000){ score += 10; reasons.push("small_pool_under_100k"); }
  }

  // Age scoring across the full 48h documented pump window — front-loaded
  // (most runs happen in the first hours) but never zeroed out just
  // because a token is a day old; a 1-2h scan cadence means a lot of the
  // window is realistically observed for the first time well after t=0.
  const withinPumpWindow = candidate.ageMinutes !== null && candidate.ageMinutes <= PUMP_WINDOW_MINUTES;
  if (candidate.ageMinutes !== null) {
    if (candidate.ageMinutes <= 60)          { score += 20; reasons.push("age_under_1h"); }
    else if (candidate.ageMinutes <= 180)    { score += 10; reasons.push("age_under_3h"); }
    else if (candidate.ageMinutes <= 1440)   { score += 6;  reasons.push("age_under_24h"); }
    else if (candidate.ageMinutes <= PUMP_WINDOW_MINUTES) { score += 3; reasons.push("within_48h_pump_window"); }
  }

  // Already-explosive short-term momentum underway (confirming, not causal).
  if (candidate.priceChange5m >= 15) { score += 8; reasons.push("explosive_5m_move"); }
  if (candidate.priceChange1h >= 50) { score += 7; reasons.push("explosive_1h_move"); }

  // Retrospective pump detection — catches moves that happened between
  // scans or fell outside DexScreener's rolling windows by the time we
  // next looked. This is real evidence a pump occurred, not a prediction,
  // so it's weighted heavily.
  let cumulativeMultipleFromFirstSeen: number | null = null;
  let pumpAlreadyDetected = false;
  if (priceHistory?.firstSeenPriceUsd && priceHistory.firstSeenPriceUsd > 0 && priceHistory.peakPriceUsd) {
    cumulativeMultipleFromFirstSeen = priceHistory.peakPriceUsd / priceHistory.firstSeenPriceUsd;
    if (withinPumpWindow && cumulativeMultipleFromFirstSeen >= PUMP_CONFIRMED_MULTIPLE) {
      pumpAlreadyDetected = true;
      if (cumulativeMultipleFromFirstSeen >= 50)      { score += 30; reasons.push("pump_confirmed_50x_plus"); }
      else if (cumulativeMultipleFromFirstSeen >= 10) { score += 20; reasons.push("pump_confirmed_10x_plus"); }
      else                                             { score += 10; reasons.push("pump_confirmed_3x_plus"); }
    }
  }

  score = Math.min(100, score);
  const isMoonshotCandidate = score >= MOONSHOT_FLAG_THRESHOLD;

  // Adaptive TP ceiling — scales with signal strength instead of a single
  // fixed default. Deliberately conservative below the flag threshold so
  // ordinary tokens aren't nudged toward unrealistic targets.
  let suggestedTpMultiplier: number;
  if (score >= 85)      suggestedTpMultiplier = 100;
  else if (score >= 70) suggestedTpMultiplier = 50;
  else if (score >= MOONSHOT_FLAG_THRESHOLD) suggestedTpMultiplier = 20;
  else if (score >= 35) suggestedTpMultiplier = 10;
  else                  suggestedTpMultiplier = 2; // 2x / +100% — normal-token default

  const suggestedTpPct = (suggestedTpMultiplier - 1) * 100;
  const suggestedSlPct = isMoonshotCandidate ? 35 : 20;

  return {
    moonshotScore: score,
    isMoonshotCandidate,
    reasons,
    suggestedTpMultiplier,
    suggestedTpPct,
    suggestedSlPct,
    withinPumpWindow,
    cumulativeMultipleFromFirstSeen,
    pumpAlreadyDetected,
  };
}

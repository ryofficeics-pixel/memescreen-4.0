/**
 * Pure SL/TP/trailing-stop trigger evaluation — no DB access, so this is
 * directly unit-testable without the native better-sqlite3 binding.
 * positionsRepository.checkTriggers() calls this and only handles I/O
 * (reading current peak, persisting the updated peak, closing positions).
 */

export interface TriggerablePosition {
  entryPrice:      number;
  slPct:           number | null;
  tpPct:           number | null;
  trailingStopPct: number | null;
  peakPrice:       number;
}

export type TriggerReason = "stop-loss" | "take-profit" | "trailing-stop";

export interface TriggerEvaluation {
  reason:  TriggerReason | null;
  newPeak: number;
}

/** Minimum profit (%) before a trailing stop arms — avoids firing on entry noise. */
export const TRAILING_ACTIVATION_PCT = 30;

export function evaluateTrigger(pos: TriggerablePosition, currentPrice: number): TriggerEvaluation {
  const pnlPct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;

  // Hard stop-loss always takes priority.
  if (pos.slPct !== null && pnlPct <= -Math.abs(pos.slPct)) {
    return { reason: "stop-loss", newPeak: pos.peakPrice };
  }

  // Hard TP ceiling — take the win outright if reached, trailing or not.
  if (pos.tpPct !== null && pnlPct >= Math.abs(pos.tpPct)) {
    return { reason: "take-profit", newPeak: pos.peakPrice };
  }

  const newPeak = Math.max(pos.peakPrice, currentPrice);

  if (pos.trailingStopPct !== null) {
    const peakPnlPct  = pos.entryPrice > 0 ? ((newPeak - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    const armed       = peakPnlPct >= TRAILING_ACTIVATION_PCT;
    const retracePct  = newPeak > 0 ? ((newPeak - currentPrice) / newPeak) * 100 : 0;

    if (armed && retracePct >= Math.abs(pos.trailingStopPct)) {
      return { reason: "trailing-stop", newPeak };
    }
  }

  return { reason: null, newPeak };
}

import { describe, it, expect } from "vitest";
import { evaluateTrigger, TRAILING_ACTIVATION_PCT, type TriggerablePosition } from "../src/domain/triggers.js";

function pos(overrides: Partial<TriggerablePosition> = {}): TriggerablePosition {
  return {
    entryPrice: 1,
    slPct: null,
    tpPct: null,
    trailingStopPct: null,
    peakPrice: 1,
    ...overrides,
  };
}

describe("evaluateTrigger — stop-loss", () => {
  it("triggers stop-loss when price drops beyond slPct", () => {
    const r = evaluateTrigger(pos({ slPct: 20 }), 0.79); // -21%
    expect(r.reason).toBe("stop-loss");
  });

  it("does not trigger stop-loss just short of the threshold", () => {
    const r = evaluateTrigger(pos({ slPct: 20 }), 0.81); // -19%
    expect(r.reason).toBeNull();
  });

  it("stop-loss takes priority even if tp is also configured", () => {
    const r = evaluateTrigger(pos({ slPct: 10, tpPct: 500 }), 0.5); // -50%, way past SL
    expect(r.reason).toBe("stop-loss");
  });
});

describe("evaluateTrigger — fixed take-profit (hard ceiling)", () => {
  it("triggers take-profit when price reaches tpPct outright", () => {
    const r = evaluateTrigger(pos({ tpPct: 100 }), 2.0); // +100%
    expect(r.reason).toBe("take-profit");
  });

  it("hard TP ceiling fires even while a trailing stop is armed and not yet retraced", () => {
    // moonshot case: peak already ran to +4000%, trailing not retraced,
    // but price has now hit the configured ceiling outright — take it.
    const r = evaluateTrigger(
      pos({ tpPct: 4900, trailingStopPct: 25, peakPrice: 45 }), // peak = 44x
      50 // now 49x — hits the 4900% (50x) ceiling
    );
    expect(r.reason).toBe("take-profit");
  });
});

describe("evaluateTrigger — adaptive trailing stop", () => {
  it("does NOT trigger while still climbing toward the peak", () => {
    const r = evaluateTrigger(pos({ trailingStopPct: 20, peakPrice: 1 }), 5); // 5x, new peak
    expect(r.reason).toBeNull();
    expect(r.newPeak).toBe(5);
  });

  it("does not arm before reaching TRAILING_ACTIVATION_PCT profit", () => {
    // peak only +10%, well under the 30% activation floor — a 20% dip
    // from a barely-profitable peak should not be treated as a reversal.
    const r = evaluateTrigger(
      pos({ trailingStopPct: 20, peakPrice: 1.10 }),
      1.10 * (1 - 0.21) // retrace > 20% off peak, but peak never armed
    );
    expect(r.reason).toBeNull();
  });

  it("arms once peak profit crosses the activation floor, then fires on retrace", () => {
    const entryPrice = 1;
    const peakPrice  = 1 * (1 + TRAILING_ACTIVATION_PCT / 100 + 0.05); // just past activation
    const retraced    = peakPrice * (1 - 0.26); // > 25% off peak
    const r = evaluateTrigger(pos({ entryPrice, trailingStopPct: 25, peakPrice }), retraced);
    expect(r.reason).toBe("trailing-stop");
  });

  it("rides a 100x-style run without firing early, then locks in on genuine reversal", () => {
    // Simulates a moonshot: price runs from 1 -> 100 across several updates,
    // trailing stop 30%, no hard tp ceiling set (pure adaptive ride).
    let state = pos({ trailingStopPct: 30, peakPrice: 1 });
    const path = [2, 5, 12, 30, 60, 100]; // steady run-up
    for (const price of path) {
      const r = evaluateTrigger(state, price);
      expect(r.reason).toBeNull(); // never sells on the way up
      state = { ...state, peakPrice: r.newPeak };
    }
    expect(state.peakPrice).toBe(100);

    // Now it reverses hard — 35% off the peak of 100x.
    const reversal = evaluateTrigger(state, 65);
    expect(reversal.reason).toBe("trailing-stop");
  });

  it("updates newPeak even when no trailing stop is configured", () => {
    const r = evaluateTrigger(pos({ peakPrice: 1 }), 3);
    expect(r.newPeak).toBe(3);
    expect(r.reason).toBeNull();
  });

  it("never lowers the peak on a dip that doesn't trigger anything", () => {
    const r = evaluateTrigger(pos({ peakPrice: 5, trailingStopPct: 50 }), 4);
    expect(r.newPeak).toBe(5); // max(5, 4) — peak preserved
  });
});

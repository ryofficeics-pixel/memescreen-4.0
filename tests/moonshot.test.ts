import { describe, it, expect } from "vitest";
import { assessMoonshotPotential } from "../src/domain/moonshot.js";
import type { TokenCandidate } from "../src/domain/types.js";

function candidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: "TestAddr111111111111111111111111111111111",
    symbol: "TEST",
    name: "Test Token",
    source: "dexscreener",
    sources: ["dexscreener"],
    priceUsd: 0.001,
    liquidityUsd: 200_000,
    volume24hUsd: 100_000,
    volume1hUsd: 5_000,
    priceChange5m: 1,
    priceChange1h: 5,
    priceChange24h: 10,
    fdvUsd: 1_000_000,
    ageMinutes: 1000,
    txns5m: 5,
    txns1h: 60,
    buys1h: 30,
    sells1h: 30,
    top10HolderPct: 20,
    dexId: "raydium",
    pairAddress: "pair1",
    pairUrl: "https://dexscreener.com/solana/pair1",
    ...overrides,
  };
}

describe("assessMoonshotPotential — ordinary token", () => {
  it("does not flag a normal, established token as a moonshot candidate", () => {
    const r = assessMoonshotPotential(candidate());
    expect(r.isMoonshotCandidate).toBe(false);
    expect(r.suggestedTpMultiplier).toBe(2); // conservative default, not inflated
  });
});

describe("assessMoonshotPotential — ANSEM-style extreme mover profile", () => {
  it("flags a micro-liquidity, high-turnover, very fresh token as a moonshot candidate", () => {
    const r = assessMoonshotPotential(candidate({
      liquidityUsd: 25_000,      // micro pool
      volume24hUsd: 900_000,     // turnover ratio 36x — extreme tier
      ageMinutes: 30,            // very fresh
      priceChange5m: 20,
      priceChange1h: 60,
    }));
    expect(r.isMoonshotCandidate).toBe(true);
    expect(r.moonshotScore).toBeGreaterThanOrEqual(85);
    expect(r.suggestedTpMultiplier).toBe(100); // top tier suggestion
  });

  it("scales the suggested TP multiplier down for weaker (but still flagged) signals", () => {
    const r = assessMoonshotPotential(candidate({
      liquidityUsd: 80_000,
      volume24hUsd: 700_000, // turnover ~8.75x -> elevated, not extreme
      ageMinutes: 150,
    }));
    expect(r.moonshotScore).toBeLessThan(85);
    expect(r.suggestedTpMultiplier).toBeLessThan(100);
  });

  it("never suggests a lower TP ceiling for a higher moonshot score", () => {
    const weak = assessMoonshotPotential(candidate({ liquidityUsd: 80_000, volume24hUsd: 700_000 }));
    const strong = assessMoonshotPotential(candidate({
      liquidityUsd: 25_000, volume24hUsd: 900_000, ageMinutes: 30, priceChange5m: 20, priceChange1h: 60,
    }));
    expect(strong.moonshotScore).toBeGreaterThan(weak.moonshotScore);
    expect(strong.suggestedTpMultiplier).toBeGreaterThanOrEqual(weak.suggestedTpMultiplier);
  });

  it("suggests a wider stop-loss for flagged moonshot candidates than ordinary tokens", () => {
    const ordinary = assessMoonshotPotential(candidate());
    const moonshot = assessMoonshotPotential(candidate({
      liquidityUsd: 20_000, volume24hUsd: 900_000, ageMinutes: 20, priceChange5m: 25, priceChange1h: 70,
    }));
    expect(moonshot.suggestedSlPct).toBeGreaterThan(ordinary.suggestedSlPct);
  });

  it("keeps score within 0-100 bounds even when every signal maxes out", () => {
    const r = assessMoonshotPotential(candidate({
      liquidityUsd: 5_000,
      volume24hUsd: 5_000_000,
      ageMinutes: 5,
      priceChange5m: 100,
      priceChange1h: 500,
      fdvUsd: 50_000,
    }));
    expect(r.moonshotScore).toBeLessThanOrEqual(100);
  });

  it("suggestedTpPct is consistent with suggestedTpMultiplier ((x-1)*100)", () => {
    const r = assessMoonshotPotential(candidate({
      liquidityUsd: 25_000, volume24hUsd: 900_000, ageMinutes: 30, priceChange5m: 20, priceChange1h: 60,
    }));
    expect(r.suggestedTpPct).toBe((r.suggestedTpMultiplier - 1) * 100);
  });
});

describe("assessMoonshotPotential — edge cases", () => {
  it("handles zero liquidity without throwing or producing NaN", () => {
    const r = assessMoonshotPotential(candidate({ liquidityUsd: 0, volume24hUsd: 100_000 }));
    expect(Number.isFinite(r.moonshotScore)).toBe(true);
  });

  it("handles null ageMinutes without throwing", () => {
    const r = assessMoonshotPotential(candidate({ ageMinutes: null }));
    expect(Number.isFinite(r.moonshotScore)).toBe(true);
    expect(r.withinPumpWindow).toBe(false);
  });
});

describe("assessMoonshotPotential — 48h pump window (scan cadence tolerant)", () => {
  it("still credits a token that is within 48h but past the first few hours (1-2h scan cadence gap)", () => {
    const fresh = assessMoonshotPotential(candidate({ ageMinutes: 30 }));
    const aDayOld = assessMoonshotPotential(candidate({ ageMinutes: 30 * 60 })); // 30h
    expect(aDayOld.withinPumpWindow).toBe(true);
    expect(aDayOld.moonshotScore).toBeGreaterThan(0); // not zeroed out just because it's not brand new
    expect(aDayOld.moonshotScore).toBeLessThan(fresh.moonshotScore); // still front-loaded toward freshest
  });

  it("marks a token past 48h as outside the pump window", () => {
    const r = assessMoonshotPotential(candidate({ ageMinutes: 49 * 60 }));
    expect(r.withinPumpWindow).toBe(false);
  });

  it("marks a token exactly at the 48h boundary as within the window", () => {
    const r = assessMoonshotPotential(candidate({ ageMinutes: 48 * 60 }));
    expect(r.withinPumpWindow).toBe(true);
  });
});

describe("assessMoonshotPotential — retrospective pump detection", () => {
  it("flags pumpAlreadyDetected when peak price is 3x+ the first-seen price, within the pump window", () => {
    const r = assessMoonshotPotential(
      candidate({ ageMinutes: 600 }),
      { firstSeenPriceUsd: 0.001, peakPriceUsd: 0.005 } // 5x
    );
    expect(r.pumpAlreadyDetected).toBe(true);
    expect(r.cumulativeMultipleFromFirstSeen).toBeCloseTo(5, 5);
    expect(r.reasons).toContain("pump_confirmed_3x_plus");
  });

  it("does not flag pumpAlreadyDetected below the 3x confirmation threshold", () => {
    const r = assessMoonshotPotential(
      candidate({ ageMinutes: 600 }),
      { firstSeenPriceUsd: 0.001, peakPriceUsd: 0.0025 } // 2.5x
    );
    expect(r.pumpAlreadyDetected).toBe(false);
  });

  it("does not flag pumpAlreadyDetected outside the 48h pump window even with a huge multiple", () => {
    // a token that pumped 50x but that happened well over 48h ago is no
    // longer "the event" this detector is watching for — it's just an
    // old token now, not a fresh moonshot opportunity.
    const r = assessMoonshotPotential(
      candidate({ ageMinutes: 100 * 60 }), // ~4.2 days
      { firstSeenPriceUsd: 0.001, peakPriceUsd: 0.05 } // 50x
    );
    expect(r.pumpAlreadyDetected).toBe(false);
  });

  it("catches a pump that happened entirely between two 1-2h scans (simulated gap)", () => {
    // Simulates exactly the scenario described: scan at t=0 records
    // first_seen_price, token pumps 40x and mostly reverts, next scan at
    // t=90min only sees the aftermath — current price has faded and
    // liquidity has thinned (common after a pump/dump) but the *peak*
    // recorded during that gap still reveals the event happened.
    const firstSeenPriceUsd = 0.0004;
    const peakPriceUsd      = 0.016; // 40x intraday peak, captured between scans
    const r = assessMoonshotPotential(
      candidate({
        ageMinutes: 90, priceUsd: 0.002, // faded to ~5x by the time we scan again
        liquidityUsd: 40_000, volume24hUsd: 800_000, // elevated post-pump turnover
      }),
      { firstSeenPriceUsd, peakPriceUsd }
    );
    expect(r.pumpAlreadyDetected).toBe(true);
    expect(r.cumulativeMultipleFromFirstSeen).toBeCloseTo(40, 5);
    expect(r.reasons).toContain("pump_confirmed_10x_plus");
    expect(r.isMoonshotCandidate).toBe(true);
  });

  it("does not throw when price history is omitted (backward compatible call)", () => {
    expect(() => assessMoonshotPotential(candidate())).not.toThrow();
    const r = assessMoonshotPotential(candidate());
    expect(r.cumulativeMultipleFromFirstSeen).toBeNull();
    expect(r.pumpAlreadyDetected).toBe(false);
  });

  it("does not throw when price history has null fields", () => {
    const r = assessMoonshotPotential(candidate(), { firstSeenPriceUsd: null, peakPriceUsd: null });
    expect(r.pumpAlreadyDetected).toBe(false);
  });
});

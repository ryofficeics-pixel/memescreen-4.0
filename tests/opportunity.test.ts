import { describe, it, expect } from "vitest";
import { computeOpportunity } from "../src/domain/opportunity.js";
import type { TokenCandidate } from "../src/domain/types.js";
import type { AppEnv } from "../src/config/env.js";

const env = {} as AppEnv; // computeOpportunity does not currently read env

function candidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: "Addr1111111111111111111111111111111111111",
    symbol: "ZZQXVOL", // neutral — avoids polluting the narrative-cluster
                        // detector's shared module-level state used by
                        // other tests in this file (see note below)
    name: "Test Token",
    source: "dexscreener",
    sources: ["dexscreener"],
    priceUsd: 0.001,
    liquidityUsd: 150_000,
    volume24hUsd: 200_000,
    volume1hUsd: 10_000,
    priceChange5m: 2,
    priceChange1h: 10,
    priceChange24h: 20,
    fdvUsd: 800_000,
    ageMinutes: 100,
    txns5m: 10,
    txns1h: 120,
    buys1h: 80,
    sells1h: 40,
    top10HolderPct: 30,
    dexId: "raydium",
    pairAddress: "pair1",
    pairUrl: "https://dexscreener.com/solana/pair1",
    ...overrides,
  };
}

describe("computeOpportunity — turnover velocity bonus (ANSEM pattern)", () => {
  it("awards the extreme turnover bonus when 24h volume is 15x+ liquidity", () => {
    const r = computeOpportunity(
      candidate({ liquidityUsd: 100_000, volume24hUsd: 2_000_000 }), // 20x turnover
      env
    );
    expect(r.reasons).toContain("extreme_turnover_vs_liquidity");
  });

  it("does not award the turnover bonus for a normal, low-turnover pool", () => {
    const r = computeOpportunity(
      candidate({ liquidityUsd: 500_000, volume24hUsd: 250_000 }), // 0.5x turnover
      env
    );
    expect(r.reasons).not.toContain("extreme_turnover_vs_liquidity");
    expect(r.reasons).not.toContain("high_turnover_vs_liquidity");
  });
});

describe("computeOpportunity — narrative cluster bonus", () => {
  it("clusters a copycat swarm sharing a 4+ character substring (ANSEM -> ANSEMSTR/ANSEMWORK/etc)", () => {
    // First sighting establishes the root bucket.
    computeOpportunity(candidate({ address: "a1", symbol: "ANSEM" }), env);
    computeOpportunity(candidate({ address: "a2", symbol: "ANSEMSTR" }), env);
    computeOpportunity(candidate({ address: "a3", symbol: "ANSEMWORK" }), env);
    computeOpportunity(candidate({ address: "a4", symbol: "ANSEM ARMY" }), env);
    const r = computeOpportunity(candidate({ address: "a5", symbol: "BABYANSEM" }), env);
    // 5th clone in the swarm should cross the narrative_swarm_detected threshold.
    expect(r.reasons).toContain("narrative_swarm_detected");
  });

  it("documented limitation: does not cluster a name sharing fewer than 4 chars (TROLLSEM vs ANSEM)", () => {
    computeOpportunity(candidate({ address: "b1", symbol: "ANSEMXX" }), env);
    const r = computeOpportunity(candidate({ address: "b2", symbol: "TROLLSEM" }), env);
    expect(r.reasons).not.toContain("narrative_cluster_forming");
    expect(r.reasons).not.toContain("narrative_swarm_detected");
  });
});

describe("computeOpportunity — general bounds", () => {
  it("keeps momentumScore and opportunityScore within 0-100", () => {
    const r = computeOpportunity(
      candidate({
        volume1hUsd: 10_000_000, volume24hUsd: 1_000_000, // absurd velocity
        liquidityUsd: 1_000, priceChange1h: 40, priceChange5m: 10,
      }),
      env
    );
    expect(r.momentumScore).toBeLessThanOrEqual(100);
    expect(r.opportunityScore).toBeLessThanOrEqual(100);
    expect(r.momentumScore).toBeGreaterThanOrEqual(0);
  });

  it("does not throw on zero liquidity/volume/fdv (division-by-zero guards)", () => {
    expect(() =>
      computeOpportunity(candidate({ liquidityUsd: 0, volume24hUsd: 0, volume1hUsd: 0, fdvUsd: 0 }), env)
    ).not.toThrow();
  });
});

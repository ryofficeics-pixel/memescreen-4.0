import type { Tier, TierResult } from "./types.js";

/**
 * Tier classification (from VectorControl, adapted for v3.1)
 *
 * S = elite signal: high final score, low risk, Jupiter routable
 * A = strong signal: good score, acceptable risk
 * B = moderate: worth watching
 * C = weak: marginal
 * REJECT = hard avoid or score too low
 */
export function classifyTier(
  finalScore: number,
  riskScore: number,
  liquidityUsd: number,
  jupiterRoutable: boolean | null,
  hardAvoid: boolean
): TierResult {
  // Confidence: how complete is the data?
  let confidence = 60;
  if (liquidityUsd > 0) confidence += 15;
  if (jupiterRoutable !== null) confidence += 25;

  // Hard rejects first
  if (hardAvoid)               return { tier: "REJECT", finalScore, confidence };
  if (liquidityUsd < 5000)     return { tier: "REJECT", finalScore, confidence };
  if (riskScore >= 75)         return { tier: "REJECT", finalScore, confidence };

  // Tier S — elite
  if (
    finalScore >= 78 &&
    riskScore  <= 30 &&
    (jupiterRoutable === true || jupiterRoutable === null)
  ) return { tier: "S", finalScore, confidence };

  // Tier A — strong
  if (finalScore >= 62 && riskScore <= 45)
    return { tier: "A", finalScore, confidence };

  // Tier B — watch
  if (finalScore >= 45)
    return { tier: "B", finalScore, confidence };

  // Tier C — weak
  if (finalScore >= 28)
    return { tier: "C", finalScore, confidence };

  return { tier: "REJECT", finalScore, confidence };
}

export function tierColor(tier: Tier): string {
  const colors: Record<Tier, string> = {
    S:      "#4DD8E8",  // cyan
    A:      "#3FBF7F",  // green
    B:      "#F0A23C",  // amber
    C:      "#8A93A3",  // muted
    REJECT: "#E5484D",  // red
  };
  return colors[tier];
}

export function tierRank(tier: Tier): number {
  return { S: 4, A: 3, B: 2, C: 1, REJECT: 0 }[tier];
}

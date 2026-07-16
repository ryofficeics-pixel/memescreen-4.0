import { randomUUID } from "node:crypto";
import type { AppEnv } from "../config/env.js";
import { isPumpFunEnabled, isMultiSourceBonus, hasBirdEyeKey } from "../config/env.js";
import type { Repository } from "../db/repository.js";
import { computeRisk } from "../domain/risk.js";
import { computeOpportunity } from "../domain/opportunity.js";
import { assessMoonshotPotential } from "../domain/moonshot.js";
import { classifyTier, tierRank } from "../domain/tier.js";
import { checkJupiterRoutable } from "../sources/jupiterSource.js";
import type {
  ScreenedToken, ScanSummary, SourceStatus,
  TokenCandidate, TokenDecision,
} from "../domain/types.js";
import type { Tier } from "../domain/types.js";
import { DexScreenerSource } from "../sources/dexScreenerSource.js";
import { BirdEyeSource }     from "../sources/birdeyeSource.js";
import { PumpFunSource }     from "../sources/pumpfunSource.js";

export type BroadcastFn      = (type: string, data: unknown) => void;
export type OnAlertFn        = (token: ScreenedTokenV40) => Promise<void>;
export type OnScanCompleteFn = (summary: ScanSummary) => Promise<void>;
export type OnTierChangeFn   = (address: string, symbol: string, from: Tier, to: Tier) => Promise<void>;

export interface ScreenedTokenV40 extends ScreenedToken {
  tier:            Tier;
  tierConfidence:  number;
  jupiterRoutable: boolean | null;
}

/** Backward-compatible alias — any code still referencing V31 keeps working */
export type ScreenedTokenV31 = ScreenedTokenV40;

export class ScreenerService {
  private readonly dex      = new DexScreenerSource();
  private isRunning         = false;
  private lastSummary:        ScanSummary | null = null;
  private broadcast:          BroadcastFn       = () => {};
  private onAlert:            OnAlertFn         = async () => {};
  private onScanComplete:     OnScanCompleteFn  = async () => {};
  private onTierChange:       OnTierChangeFn    = async () => {};

  constructor(
    private readonly repo: Repository,
    private readonly env:  AppEnv
  ) {}

  setBroadcast(fn: BroadcastFn):           void { this.broadcast     = fn; }
  setOnAlert(fn: OnAlertFn):              void { this.onAlert       = fn; }
  setOnScanComplete(fn: OnScanCompleteFn):void { this.onScanComplete = fn; }
  setOnTierChange(fn: OnTierChangeFn):    void { this.onTierChange  = fn; }

  get scanning(): boolean            { return this.isRunning;   }
  get lastScan(): ScanSummary | null { return this.lastSummary; }

  async runScan(): Promise<ScanSummary> {
    if (this.isRunning) throw new Error("Scan already in progress");

    this.isRunning = true;
    const runId    = randomUUID();
    const t0       = Date.now();

    console.log(`\n[SCREENER] ══ SCAN START (${runId.slice(0, 8)}) ══`);
    this.broadcast("SCAN_START", { runId, ts: new Date().toISOString() });

    const summary: ScanSummary = {
      runId, totalCandidates: 0,
      alertsCount: 0, watchCount: 0, avoidCount: 0,
      durationMs: 0, sourceStatuses: [],
    };

    try {
      const { candidates, statuses } = await this.fetchAllCandidates();
      for (const s of statuses) {
        summary.sourceStatuses.push(s);
        this.repo.recordSourceStatus(s);
      }

      if (candidates.length === 0) {
        this.broadcast("SCAN_EMPTY", { runId });
        return summary;
      }

      console.log(`[SCREENER] ${candidates.length} candidates`);
      this.broadcast("SCAN_FETCHED", { runId, count: candidates.length });

      // Collect candidate prices for SL/TP evaluation
      const candidatePrices = new Map<string, number>();

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;

        this.broadcast("SCAN_PROGRESS", {
          runId, current: i + 1, total: candidates.length, symbol: candidate.symbol,
        });

        try {
          const screened = await this.screenOne(candidate);
          summary.totalCandidates++;

          candidatePrices.set(candidate.address, candidate.priceUsd);

          // Tier-change detection
          const prevTier = this.repo.getPreviousTier(candidate.address);
          if (prevTier && prevTier !== screened.tier) {
            const prevRank = tierRank(prevTier as Tier);
            const newRank  = tierRank(screened.tier);
            if (Math.abs(prevRank - newRank) >= 1) {
              await this.onTierChange(
                candidate.address, candidate.symbol,
                prevTier as Tier, screened.tier
              );
            }
          }

          switch (screened.decision) {
            case "alert": summary.alertsCount++; break;
            case "watch": summary.watchCount++;  break;
            case "avoid": summary.avoidCount++;  break;
          }

          this.repo.upsertToken(screened);
          this.broadcast("TOKEN_UPDATE", this.toWireFormat(screened));

          if (screened.decision === "alert") {
            await this.onAlert(screened);

            // ── Auto-trade ───────────────────────────────────────────────
            if (this.repo.getAutoTradeEnabled()) {
              await this.autoTrade(screened);
            }
          }

        } catch (err) {
          console.error(`[SCREENER] Error on ${candidate.symbol}:`, err instanceof Error ? err.message : err);
        }

        await sleep(500);
      }

      summary.durationMs = Date.now() - t0;

      // ── Post-scan SL/TP check for ALL open positions ──────────────────────
      await this.checkSlTp();

      this.repo.saveScan(summary);
      this.lastSummary = summary;

      console.log(
        `[SCREENER] ══ DONE ${(summary.durationMs / 1000).toFixed(1)}s` +
        ` | alerts:${summary.alertsCount} watch:${summary.watchCount} avoid:${summary.avoidCount} ══`
      );

      this.broadcast("SCAN_COMPLETE", { runId, summary });
      await this.onScanComplete(summary);

    } finally {
      this.isRunning = false;
    }

    return summary;
  }

  async screenOne(candidate: TokenCandidate): Promise<ScreenedTokenV40> {
    // 1. Risk
    const risk = await computeRisk(candidate, this.env, this.env.QUICKNODE_RPC_URL);

    // 2. Jupiter check (optional, non-blocking)
    const jupiterKey    = this.repo.getSetting("jupiter_api_key") ?? undefined;
    const jupiterResult = await checkJupiterRoutable(candidate.address, jupiterKey);
    const jupiterRoutable: boolean | null = jupiterResult.checked ? jupiterResult.routable : null;

    // 3. Opportunity — pass previous liquidity for growth proxy (4.0)
    const prevLiquidityUsd = this.repo.getPreviousLiquidity(candidate.address);
    const opportunity = computeOpportunity(candidate, this.env, prevLiquidityUsd);

    // 3b. Moonshot potential — separate from opportunity/risk scoring;
    // flags candidates that match the extreme-mover (10-100x) profile,
    // weighted across the documented 48h post-release pump window, and
    // cross-checks against this scanner's own recorded price history to
    // catch pumps that happened between scans (see moonshot.ts).
    const priceHistory = this.repo.getPriceHistory(candidate.address);
    const moonshot = assessMoonshotPotential(candidate, priceHistory);

    // 4. Final score
    const riskPenalty = Math.round(risk.riskScore * 0.4);
    const finalScore  = Math.max(0, Math.min(100,
      Math.round(opportunity.opportunityScore * 0.90 + (100 - risk.riskScore) * 0.10) - riskPenalty
    ));

    // 5. Decision
    let decision: TokenDecision = "avoid";
    if (!risk.hardAvoid) {
      if (finalScore >= this.env.STRONG_BUY_SCORE && risk.riskScore <= this.env.MAX_RISK_SCORE) {
        decision = "alert";
      } else if (finalScore >= this.env.MIN_OPPORTUNITY_SCORE && risk.riskScore <= this.env.MAX_RISK_SCORE + 10) {
        decision = "watch";
      }
    }

    // 6. Tier
    const tierResult = classifyTier(
      finalScore, risk.riskScore,
      candidate.liquidityUsd,
      jupiterRoutable,
      risk.hardAvoid
    );

    // 7. Evidence — include source confirmation for multi-source tokens
    const sourceEvidence = candidate.sources.length >= 2
      ? [`⭐ ${candidate.sources.join("+")} confirm`]
      : [];

    const evidence: string[] = [
      ...opportunity.reasons.slice(0, 4),
      ...sourceEvidence,
      ...(risk.flags.length > 0 ? risk.flags.slice(0, 2).map(f => `⚠ ${f}`) : []),
      ...(jupiterResult.checked ? [jupiterRoutable ? "✓ Jupiter routable" : "✗ Jupiter not routable"] : []),
      ...(moonshot.isMoonshotCandidate ? [`🚀 moonshot candidate (up to ${moonshot.suggestedTpMultiplier}x suggested TP)`] : []),
      ...(moonshot.pumpAlreadyDetected ? [`⚡ pump already detected: ${moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x since first seen`] : []),
    ];

    return {
      ...candidate, risk, opportunity, decision, finalScore, evidence, moonshot,
      tier:           tierResult.tier,
      tierConfidence: tierResult.confidence,
      jupiterRoutable,
    };
  }

  async checkAddress(address: string): Promise<ScreenedTokenV31 | null> {
    const candidate = await this.dex.fetchByTokenAddress(address);
    if (!candidate) return null;
    return this.screenOne(candidate);
  }

  toWireFormat(t: ScreenedTokenV40): Record<string, unknown> {
    return {
      address: t.address, symbol: t.symbol, name: t.name,
      dexId: t.dexId, pairUrl: t.pairUrl,
      source: t.source, sources: t.sources,
      priceUsd: t.priceUsd, volume1hUsd: t.volume1hUsd, volume24hUsd: t.volume24hUsd,
      priceChange1h: t.priceChange1h, priceChange5m: t.priceChange5m,
      liquidityUsd: t.liquidityUsd, fdvUsd: t.fdvUsd, ageMinutes: t.ageMinutes,
      riskScore: t.risk.riskScore, opportunityScore: t.opportunity.opportunityScore,
      finalScore: t.finalScore, decision: t.decision,
      tier: t.tier, tierConfidence: t.tierConfidence,
      jupiterRoutable: t.jupiterRoutable,
      evidence: t.evidence, checks: t.risk.checks,
      components: t.opportunity.components,
      flags: t.risk.flags, hardAvoid: t.risk.hardAvoid,
      moonshot: {
        score: t.moonshot.moonshotScore,
        isMoonshotCandidate: t.moonshot.isMoonshotCandidate,
        suggestedTpMultiplier: t.moonshot.suggestedTpMultiplier,
        suggestedTpPct: t.moonshot.suggestedTpPct,
        suggestedSlPct: t.moonshot.suggestedSlPct,
        withinPumpWindow: t.moonshot.withinPumpWindow,
        cumulativeMultipleFromFirstSeen: t.moonshot.cumulativeMultipleFromFirstSeen,
        pumpAlreadyDetected: t.moonshot.pumpAlreadyDetected,
      },
    };
  }

  // ── Multi-source fetch (4.0) ──────────────────────────────────────────────
  // Runs all enabled sources concurrently. Each source maps to the common
  // TokenCandidate shape. Results are merged by token address: highest
  // liquidity wins as the canonical record, and the `sources` array on the
  // merged token lists every source that found it (for cross-source scoring).
  private async fetchAllCandidates(): Promise<{ candidates: TokenCandidate[]; statuses: SourceStatus[] }> {
    const limit = this.env.MAX_TOKENS_PER_SOURCE ?? this.env.DEXSCREENER_MAX_TOKENS;

    // Build source list dynamically based on env flags
    type NamedSource = { name: string; fetch: () => Promise<TokenCandidate[]> };
    const sources: NamedSource[] = [
      { name: "dexscreener", fetch: () => this.dex.fetchCandidates(limit) },
    ];

    if (hasBirdEyeKey(this.env)) {
      const birdeye = new BirdEyeSource(this.env.BIRDEYE_API_KEY);
      sources.push({ name: "birdeye", fetch: () => birdeye.fetchCandidates(limit) });
    }

    if (isPumpFunEnabled(this.env)) {
      const pump = new PumpFunSource();
      sources.push({ name: "pumpfun", fetch: () => pump.fetchCandidates(limit) });
    }

    // Fire all sources concurrently — one slow/dead source doesn't block others
    const t0 = Date.now();
    const results = await Promise.allSettled(sources.map(s => s.fetch()));

    const statuses: SourceStatus[] = [];
    // address → best TokenCandidate so far (highest liquidity)
    const byAddress = new Map<string, TokenCandidate>();

    for (let i = 0; i < sources.length; i++) {
      const result = results[i]!;
      const sourceName = sources[i]!.name;

      if (result.status === "rejected") {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[SCREENER] Source ${sourceName} failed: ${error}`);
        statuses.push({ name: sourceName, ok: false, count: 0, latencyMs: Date.now() - t0, error });
        continue;
      }

      const tokens = result.value;
      statuses.push({ name: sourceName, ok: true, count: tokens.length, latencyMs: Date.now() - t0 });

      for (const token of tokens) {
        if (!token.address) continue;
        const existing = byAddress.get(token.address);
        if (!existing) {
          // First time seeing this token — initialise sources array
          byAddress.set(token.address, { ...token, sources: [sourceName] });
        } else {
          // Already seen — merge: keep higher liquidity, union sources list
          const merged: TokenCandidate = {
            ...(token.liquidityUsd > existing.liquidityUsd ? token : existing),
            source:  existing.source,               // keep primary (first found)
            sources: Array.from(new Set([...existing.sources, sourceName])),
            // Prefer non-zero values from whichever source has them
            buys1h:  token.buys1h  || existing.buys1h,
            sells1h: token.sells1h || existing.sells1h,
            txns1h:  token.txns1h  || existing.txns1h,
            txns5m:  token.txns5m  || existing.txns5m,
          };
          byAddress.set(token.address, merged);
        }
      }
    }

    const candidates = Array.from(byAddress.values());
    const multiCount = candidates.filter(c => c.sources.length >= 2).length;
    console.log(`[SCREENER] Fetched ${candidates.length} unique tokens (${multiCount} multi-source confirmed) from ${sources.length} source(s)`);

    return { candidates, statuses };
  }

  // ── Standalone SL/TP check (runs between scans) ──────────────────────────
  /** Fetches fresh prices for all open positions and closes triggered ones. */
  async checkSlTp(): Promise<void> {
    const openPositions = this.repo.positions.listOpenPositions();
    if (openPositions.length === 0) return;

    const prices = new Map<string, number>();
    for (const pos of openPositions) {
      try {
        const candidate = await this.dex.fetchByTokenAddress(pos.address);
        if (candidate && candidate.priceUsd > 0) {
          prices.set(candidate.address, candidate.priceUsd);
        }
        await sleep(500);
      } catch {
        // skip — next cycle will retry
      }
    }
    const triggered = this.repo.positions.checkTriggers(prices);
    for (const closed of triggered) {
      this.repo.creditWallet(closed.amount_sol);
      this.broadcast("POSITION_CLOSED", closed);
      console.log(`[SL/TP] ${closed.symbol} closed: ${closed.reason} @ $${closed.exit_price}`);
    }
  }

  // ── Auto-trade: paper-buy alert tokens automatically ─────────────────────
  private async autoTrade(screened: ScreenedTokenV40): Promise<void> {
    const tierRank: Record<string, number> = { S: 4, A: 3, B: 2, C: 1, REJECT: 0 };
    const minRank = tierRank[this.env.AUTO_TRADE_MIN_TIER] ?? 3;
    const tokRank = tierRank[screened.tier] ?? 0;
    if (tokRank < minRank) return;

    if (screened.finalScore < this.env.AUTO_TRADE_MIN_SCORE) return;

    const openPositions = this.repo.positions.listOpenPositions();
    if (openPositions.length >= this.env.AUTO_TRADE_MAX_POSITIONS) return;

    // Scale trade size by score: 0.1 SOL (min score) → 0.3 SOL (100)
    const minScore = this.env.AUTO_TRADE_MIN_SCORE;
    const score = screened.finalScore;
    const ratio = Math.min(1, Math.max(0, (score - minScore) / (100 - minScore)));
    const amountSol = +(0.1 + ratio * 0.2).toFixed(2);
    if (!this.repo.deductWallet(amountSol)) return;

    try {
      const pos = this.repo.positions.openPosition({
        address:    screened.address,
        symbol:     screened.symbol,
        entryPrice: screened.priceUsd,
        amountSol,
        slPct: screened.moonshot.suggestedSlPct ?? 25,
        tpPct: 20, // fixed 20% take-profit for compounding
        trailingStopPct: null,
      });
      this.broadcast("POSITION_OPENED", pos);
      console.log(`[AUTO] Bought $${screened.symbol} ${amountSol} SOL @ $${screened.priceUsd}`);
    } catch (e) {
      this.repo.creditWallet(amountSol);
      console.error(`[AUTO] Buy failed for ${screened.symbol}:`, e);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

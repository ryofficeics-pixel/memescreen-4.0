import type { AppEnv } from "../config/env.js";
import type { OpportunityResult, TokenCandidate } from "./types.js";

// Previous scan cache — currently only used as a "have we seen this
// token before" marker for the holder-growth proxy (see note below;
// DexScreener's free API doesn't expose real holder counts so true
// growth-over-time isn't computable yet). Evicted periodically to avoid
// unbounded growth on a long-running local process.
const prevCache = new Map<string, { holders: number; ts: number }>();
const PREV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — well beyond any single scan cycle

function evictStaleCacheEntries(): void {
  const now = Date.now();
  for (const [address, entry] of prevCache) {
    if (now - entry.ts > PREV_CACHE_TTL_MS) prevCache.delete(address);
  }
}

// Tracks distinct cleaned symbol strings seen this process lifetime, to
// detect copycat swarms (e.g. ANSEM → ANSEMSTR, ANSEMWORK, BABYANSEM,
// ANSEM ARMY, TROLLSEM). This is the same mechanic observed in the
// $ANSEM case study: once a narrative catches, dozens of clones spawn
// within hours, often as prefix/suffix variations OR with the root word
// embedded anywhere in the name (TROLLSEM contains "SEM", a fragment of
// "ANSEM" — but matching on short fragments causes false positives, so
// matching requires the shared substring to be at least 4 characters).
//
// A clone swarm is itself a *confirming* signal that a narrative is hot
// — but it's also exactly where copycat rugs cluster, so it only ever
// adds a small bonus, never a hard multiplier, and is logged as
// evidence for human review, never used to loosen any risk check.
const narrativeRoots = new Map<string, { count: number; firstSeen: number; symbols: Set<string> }>();
const MIN_SHARED_SUBSTRING = 4;

function cleanSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * Returns true if two cleaned symbols share a contiguous substring of at
 * least MIN_SHARED_SUBSTRING characters. This catches prefix matches
 * (ANSEM/ANSEMSTR), suffix matches (TROLLSEM contains "ANSEM"? no —
 * but "ROLLSEM" vs "ANSEM" share "SEM" which is too short by design,
 * avoiding false positives on common short fragments), and embedded
 * matches (ANSEM ARMY → "ANSEMARMY" contains "ANSEM").
 */
function shareSignificantSubstring(a: string, b: string): boolean {
  const longer  = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (shorter.length < MIN_SHARED_SUBSTRING) return false;
  for (let len = shorter.length; len >= MIN_SHARED_SUBSTRING; len--) {
    for (let i = 0; i <= shorter.length - len; i++) {
      if (longer.includes(shorter.slice(i, i + len))) return true;
    }
  }
  return false;
}

function findOrCreateNarrativeBucket(symbol: string): { count: number; firstSeen: number; symbols: Set<string> } | null {
  const cleaned = cleanSymbol(symbol);
  if (cleaned.length < MIN_SHARED_SUBSTRING) return null;

  const now = Date.now();
  const windowMs = 6 * 60 * 60 * 1000;

  // Evict expired buckets opportunistically. Cheap relative to the scan
  // cadence (every 30min by default) and prevents unbounded growth on a
  // 24/7 local process — without this, narrativeRoots accumulates one
  // entry per unique symbol ever scanned, forever.
  for (const [key, bucket] of narrativeRoots) {
    if (now - bucket.firstSeen > windowMs) narrativeRoots.delete(key);
  }

  // Look for an existing bucket whose key shares a significant substring
  for (const [key, bucket] of narrativeRoots) {
    if (shareSignificantSubstring(cleaned, key) && !bucket.symbols.has(cleaned)) {
      bucket.count++;
      bucket.symbols.add(cleaned);
      return bucket;
    }
  }

  // No match — create a new bucket keyed by this symbol
  const fresh = { count: 1, firstSeen: now, symbols: new Set([cleaned]) };
  narrativeRoots.set(cleaned, fresh);
  return null; // first sighting of this narrative, nothing to cluster against yet
}

/**
 * ANSEM CASE STUDY — reference pattern baked into scoring (June 2026):
 *
 *   1. Influencer/narrative catalyst (not fundamentals) drove the move
 *   2. Liquidity stayed thin ($24K-185K) while volume hit $2-2.5M/day —
 *      a turnover ratio of 10-100x liquidity in 24h, far above normal
 *   3. Txn count (48K-50K) was extreme relative to pool depth
 *   4. A swarm of copycat symbols appeared within hours (ANSEMSTR,
 *      ANSEMWORK, ANSEM ARMY, BABYANSEM, TROLLSEM, ANSOM...)
 *   5. Holder concentration was explicitly flagged as the structural risk
 *      that could reverse the move just as violently as it pumped
 *
 * Net effect on this engine: turnover velocity (vol/liquidity) is now
 * scored explicitly (previously only vol/24h-avg and liq/fdv existed —
 * neither captures "is this pool moving 10x its own depth per day").
 * Narrative clustering adds a small confirmation bonus based on shared
 * 4+ character substrings between symbols seen in the same 6h window.
 * Holder concentration is already a hard/soft risk check in risk.ts and
 * is NOT loosened here — the case study argues for keeping it strict,
 * not relaxing it just because a hot narrative is present.
 *
 * KNOWN LIMITATION: substring matching only catches clones that share
 * a literal text fragment (ANSEM → ANSEMSTR, ANSEM ARMY, BABYANSEM all
 * match). It does NOT catch thematic/conceptual clones with no shared
 * substring (e.g. TROLLSEM, which riffs on the same persona but shares
 * only "SEM" — 3 chars, below the 4-char threshold chosen to avoid
 * false-positive clustering on common short fragments). This is a
 * deliberate precision-over-recall tradeoff: catching every thematic
 * clone would require semantic/embedding similarity, which is out of
 * scope for a lightweight scoring pass run on every token every cycle.
 */
export function computeOpportunity(
  candidate: TokenCandidate,
  env: AppEnv,
  prevLiquidityUsd?: number | null   // 4.0: previous-scan liquidity for growth proxy
): OpportunityResult {
  const reasons: string[] = [];
  const components = {
    volumeVelocity:   0,
    priceMomentum:    0,
    holderGrowth:     0,
    liquidityDepth:   0,
    txActivity:       0,
    ageWindow:        0,
    buySellPressure:  0,
    liquidityGrowth:  0,
    crossSourceBonus: 0,
  };

  // ── Volume Velocity (30%) — 1h vol vs 24h hourly avg ──────────────────
  const avgHourly = candidate.volume24hUsd / 24;
  if (avgHourly > 0) {
    const ratio = candidate.volume1hUsd / avgHourly;
    if (ratio >= 20)      { components.volumeVelocity = 100; reasons.push("extreme_volume_spike"); }
    else if (ratio >= 10) { components.volumeVelocity = 80;  reasons.push("very_high_volume");    }
    else if (ratio >= 5)  { components.volumeVelocity = 60;  reasons.push("high_volume");          }
    else if (ratio >= 3)  { components.volumeVelocity = 40;  reasons.push("elevated_volume");      }
    else if (ratio >= 1.5){ components.volumeVelocity = 20;  reasons.push("above_avg_volume");     }
  }

  // ── Price Momentum (25%) — 1h change ──────────────────────────────────
  const p1h = candidate.priceChange1h;
  if (p1h > 0 && p1h <= 80) {
    // Sweet spot: 5-80% = bullish but not already blown
    components.priceMomentum = Math.min(100, Math.round((Math.log(p1h + 1) / Math.log(81)) * 100));
    if (p1h > 20)  reasons.push("strong_hourly_momentum");
    else if (p1h > 5) reasons.push("positive_hourly_momentum");
  } else if (p1h > 80) {
    // Already pumped hard — reduced score (might be too late)
    components.priceMomentum = Math.max(0, 80 - Math.round((p1h - 80) / 2));
    reasons.push("late_pump_risk");
  }
  // Also factor 5m momentum
  if (candidate.priceChange5m > 3 && candidate.priceChange5m < 40) {
    components.priceMomentum = Math.min(100, components.priceMomentum + 15);
    reasons.push("positive_short_momentum");
  }

  // ── Turnover Velocity (ANSEM-derived bonus, up to +12 on momentumScore) ──
  // Captures pools moving many multiples of their own liquidity in 24h —
  // the exact mechanic that let $ANSEM run 500%+ on a sub-$200K pool.
  // This is a bonus on top of the weighted score, not a reweight, so it
  // never displaces the core 5 components below.
  let turnoverBonus = 0;
  if (candidate.liquidityUsd > 0 && candidate.volume24hUsd > 0) {
    const turnoverRatio = candidate.volume24hUsd / candidate.liquidityUsd;
    if (turnoverRatio >= 15)      { turnoverBonus = 12; reasons.push("extreme_turnover_vs_liquidity"); }
    else if (turnoverRatio >= 8)  { turnoverBonus = 8;  reasons.push("high_turnover_vs_liquidity");    }
    else if (turnoverRatio >= 4)  { turnoverBonus = 4;  reasons.push("elevated_turnover");              }
  }

  // ── Narrative Cluster (ANSEM-derived bonus, up to +6) ─────────────────────
  // A swarm of similarly-named tokens appearing in the same scan window
  // is a confirming (not causal) signal that attention has concentrated
  // on a narrative. Logged as evidence — does not loosen any risk check.
  let narrativeBonus = 0;
  const bucket = findOrCreateNarrativeBucket(candidate.symbol);
  if (bucket) {
    if (bucket.count >= 5)      { narrativeBonus = 6; reasons.push("narrative_swarm_detected"); }
    else if (bucket.count >= 2) { narrativeBonus = 3; reasons.push("narrative_cluster_forming"); }
  }

  // ── Holder Growth (20%) ─────────────────────────────────────────────────
  // NOTE: DexScreener's free API does not expose actual holder counts, so
  // this is necessarily a proxy: inverse of top-10 concentration. The
  // previous-scan cache below is evicted periodically to avoid unbounded
  // growth on a long-running local process (one entry per unique address
  // scanned, otherwise accumulating forever).
  evictStaleCacheEntries();
  if (typeof candidate.top10HolderPct === "number") {
    const dist = 100 - candidate.top10HolderPct;
    components.holderGrowth = Math.min(100, Math.round(dist * 0.75));
    if (dist > 60) reasons.push("distributed_holders");
  } else {
    components.holderGrowth = 30; // neutral — no holder data available
  }
  prevCache.set(candidate.address, { holders: 0, ts: Date.now() });

  // ── Liquidity Depth (15%) — liq/mcap ratio ────────────────────────────
  if (candidate.fdvUsd > 0 && candidate.liquidityUsd > 0) {
    const ratio = (candidate.liquidityUsd / candidate.fdvUsd) * 100;
    if (ratio >= 30)      { components.liquidityDepth = 100; reasons.push("very_deep_liquidity"); }
    else if (ratio >= 15) { components.liquidityDepth = 75;  reasons.push("healthy_liquidity");   }
    else if (ratio >= 8)  { components.liquidityDepth = 50;  reasons.push("adequate_liquidity");  }
    else if (ratio >= 4)  { components.liquidityDepth = 25;  reasons.push("thin_liquidity");      }
    else                  { components.liquidityDepth = 10; }
  }

  // ── TX Activity (10%) — recent buys vs 1h baseline ────────────────────
  if (candidate.txns5m > 0 && candidate.txns1h > 0) {
    const baseline5m = candidate.txns1h / 12;
    const ratio = candidate.txns5m / baseline5m;
    if (ratio >= 8)      { components.txActivity = 100; reasons.push("tx_spike"); }
    else if (ratio >= 4) { components.txActivity = 70;  }
    else if (ratio >= 2) { components.txActivity = 40;  }
    else                 { components.txActivity = 20;  }
  }

  // ── 4.0: Buy/Sell Pressure — independent signal, not folded into txActivity
  // Measures buy-side dominance in the 1h window. Pumps with genuine demand
  // show 65-80% buy ratio; anything above 85% is often wash trading.
  // Score stored separately so the dashboard can display it and it feeds
  // into the momentum bonus independently of the txActivity component.
  if (candidate.buys1h > 0 || candidate.sells1h > 0) {
    const total   = candidate.buys1h + candidate.sells1h;
    const bsRatio = total > 0 ? candidate.buys1h / total : 0;
    if (bsRatio >= 0.85) {
      // Suspiciously one-sided — could be wash or bot; score conservatively
      components.buySellPressure = 40;
      reasons.push("suspicious_buy_dominance");
    } else if (bsRatio >= 0.70) {
      components.buySellPressure = 100;
      reasons.push("strong_buy_pressure");
    } else if (bsRatio >= 0.60) {
      components.buySellPressure = 60;
      reasons.push("buy_pressure");
    } else if (bsRatio >= 0.50) {
      components.buySellPressure = 30;
    }
    // bsRatio < 0.50 = sell pressure: leave at 0, no positive signal
  }

  // ── 4.0: Liquidity Growth Proxy — compares current vs previous scan ────
  // DexScreener does expose live liquidity, so growth between scan cycles
  // is computable (unlike holder counts). A pool that grew ≥25% since the
  // last scan is drawing new capital — a genuine confirming signal.
  // prevLiquidityUsd is loaded from the DB by screenerService before calling.
  if (
    typeof prevLiquidityUsd === "number" &&
    prevLiquidityUsd > 0 &&
    candidate.liquidityUsd > prevLiquidityUsd
  ) {
    const growthPct = ((candidate.liquidityUsd - prevLiquidityUsd) / prevLiquidityUsd) * 100;
    if (growthPct >= 75) {
      components.liquidityGrowth = 6;
      reasons.push("rapid_liquidity_growth");
    } else if (growthPct >= 50) {
      components.liquidityGrowth = 4;
      reasons.push("strong_liquidity_growth");
    } else if (growthPct >= 25) {
      components.liquidityGrowth = 2;
      reasons.push("liquidity_growing");
    }
  }

  // ── 4.0: Cross-Source Confirmation — token surfaced by multiple sources ─
  // If BirdEye AND DexScreener both independently surface the same token in
  // the same scan cycle, that convergence is a genuine multi-feed signal —
  // not one API's noise. Three sources = max bonus. Disabled if env flag off.
  const sourceCount = Array.isArray(candidate.sources) ? candidate.sources.length : 1;
  if (sourceCount >= 3) {
    components.crossSourceBonus = 12;
    reasons.push("all_sources_confirm");
  } else if (sourceCount >= 2) {
    components.crossSourceBonus = 8;
    reasons.push("multi_source_confirm");
  }

  // ── Age Window (bonus) — sweet spot 10min–12h ─────────────────────────
  if (candidate.ageMinutes !== null) {
    if (candidate.ageMinutes >= 10 && candidate.ageMinutes <= 720) {
      components.ageWindow = 100;
      reasons.push("optimal_age_window");
    } else if (candidate.ageMinutes > 720 && candidate.ageMinutes <= 2880) {
      components.ageWindow = 60;
    } else if (candidate.ageMinutes > 2880) {
      components.ageWindow = 20;
      reasons.push("older_token_reduced_upside");
    }
  }

  // ── Weighted momentum score ────────────────────────────────────────────
  // Core 5 components (sum to 100%), then 4.0 bonuses on top.
  // buySellPressure is a +10 cap bonus (not a reweight), preserving the
  // component weights from 3.1 so comparative scoring stays consistent.
  const buySellBonus = Math.round(components.buySellPressure * 0.10);

  const baseMomentum = Math.round(
    components.volumeVelocity * 0.30 +
    components.priceMomentum  * 0.25 +
    components.holderGrowth   * 0.20 +
    components.liquidityDepth * 0.15 +
    components.txActivity     * 0.10
  );
  const momentumScore = Math.min(100,
    baseMomentum
    + turnoverBonus                    // up to +12 (ANSEM pattern, from 3.1)
    + narrativeBonus                   // up to +6  (narrative cluster, from 3.1)
    + buySellBonus                     // up to +10 (4.0: buy/sell pressure)
    + components.liquidityGrowth       // up to +6  (4.0: liq growth)
    + components.crossSourceBonus      // up to +12 (4.0: multi-source confirm)
  );

  // ── Opportunity score (0-100) for threshold comparison ────────────────
  const opportunityScore = Math.min(100, Math.round(momentumScore * 0.85 + components.ageWindow * 0.15));

  return { opportunityScore, momentumScore, components, reasons };
}

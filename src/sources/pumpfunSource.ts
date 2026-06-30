import type { TokenCandidate } from "../domain/types.js";

// Pump.fun tokens via DexScreener — searches specifically for pairs
// originating from pump.fun. These are typically <2h old with sub-$100K
// liquidity, so the risk engine's strict checks are critical here.
// No API key required — uses the same free DexScreener endpoint.

interface DexPair {
  chainId?:       string;
  dexId?:         string;
  pairAddress?:   string;
  url?:           string;
  baseToken?:     { address?: string; symbol?: string; name?: string };
  pairCreatedAt?: number;
  priceUsd?:      string;
  fdv?:           number;
  marketCap?:     number;
  liquidity?:     { usd?: number };
  volume?:        { h24?: number; h1?: number };
  priceChange?:   { m5?: number; h1?: number; h24?: number };
  txns?:          { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
}

// Shared rate limiter state with dexScreenerSource — both use the same
// DexScreener free tier (30 req/min). We keep a module-level timestamp
// so the two sources cooperate even if instantiated separately.
let lastFetchTime = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now  = Date.now();
  const wait = Math.max(0, 2200 - (now - lastFetchTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetchTime = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "memescreener/4.0" },
    signal:  AbortSignal.timeout(10000),
  });
}

export class PumpFunSource {
  readonly name = "pumpfun";

  async fetchCandidates(limit: number): Promise<TokenCandidate[]> {
    // "raydium-clmm pump" surfaces most pump.fun-graduated pairs; we also
    // try the pump-specific search term. Both are free DexScreener calls.
    const [r1, r2] = await Promise.allSettled([
      rateLimitedFetch("https://api.dexscreener.com/latest/dex/search?q=pump+sol"),
      rateLimitedFetch("https://api.dexscreener.com/latest/dex/search?q=pumpfun"),
    ]);

    const pairs: DexPair[] = [];

    for (const result of [r1, r2]) {
      if (result.status === "rejected") continue;
      const resp = result.value;
      if (!resp.ok) continue;
      const body = await resp.json() as { pairs?: DexPair[] };
      if (Array.isArray(body.pairs)) pairs.push(...body.pairs);
    }

    // Deduplicate by pairAddress, keep Solana only, filter pump.fun dex
    const seen = new Set<string>();
    return pairs
      .filter(p => p.chainId === "solana")
      .filter(p => {
        const key = p.pairAddress ?? "";
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // Accept pump dex id or very new pairs with "pump" in the url
      .filter(p =>
        p.dexId === "pump" ||
        p.dexId === "pumpfun" ||
        (p.url ?? "").toLowerCase().includes("pump")
      )
      .filter(p => Number(p.liquidity?.usd ?? 0) >= 3000) // lower floor for pump.fun
      .sort((a, b) => Number(b.volume?.h1 ?? 0) - Number(a.volume?.h1 ?? 0))
      .slice(0, limit)
      .map(p => this.mapPair(p))
      .filter(t => t.address.length > 0);
  }

  private mapPair(p: DexPair): TokenCandidate {
    const createdAt  = typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null;
    const ageMinutes = createdAt
      ? Math.max(0, Math.floor((Date.now() - createdAt) / 60000))
      : null;

    const buys1h  = p.txns?.h1?.buys  ?? 0;
    const sells1h = p.txns?.h1?.sells ?? 0;

    return {
      address:        p.baseToken?.address  ?? "",
      symbol:         p.baseToken?.symbol   ?? "UNKNOWN",
      name:           p.baseToken?.name     ?? "",
      source:         "pumpfun",
      sources:        ["pumpfun"],
      priceUsd:       parseFloat(p.priceUsd ?? "0") || 0,
      liquidityUsd:   p.liquidity?.usd      ?? 0,
      volume24hUsd:   p.volume?.h24         ?? 0,
      volume1hUsd:    p.volume?.h1          ?? 0,
      priceChange5m:  p.priceChange?.m5     ?? 0,
      priceChange1h:  p.priceChange?.h1     ?? 0,
      priceChange24h: p.priceChange?.h24    ?? 0,
      fdvUsd:         p.fdv ?? p.marketCap  ?? 0,
      ageMinutes,
      txns5m:         (p.txns?.m5?.buys ?? 0) + (p.txns?.m5?.sells ?? 0),
      txns1h:         buys1h + sells1h,
      buys1h,
      sells1h,
      top10HolderPct: null,
      dexId:          p.dexId             ?? "pumpfun",
      pairAddress:    p.pairAddress       ?? "",
      pairUrl:        p.url               ?? "",
    };
  }
}

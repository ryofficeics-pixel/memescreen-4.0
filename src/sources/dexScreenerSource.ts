import type { TokenCandidate } from "../domain/types.js";

interface DexPair {
  chainId?:        string;
  dexId?:          string;
  pairAddress?:    string;
  url?:            string;
  baseToken?:      { address?: string; symbol?: string; name?: string };
  pairCreatedAt?:  number;
  priceUsd?:       string;
  fdv?:            number;
  marketCap?:      number;
  liquidity?:      { usd?: number };
  volume?:         { h24?: number; h1?: number };
  priceChange?:    { m5?: number; h1?: number; h24?: number };
  txns?:           { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
}

// Simple rate limiter: max 30 req/min = 1 per 2.1s
let lastFetchTime = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, 2100 - (now - lastFetchTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetchTime = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "memescreener/3.0" },
    signal: AbortSignal.timeout(10000)
  });
}

export class DexScreenerSource {
  readonly name = "dexscreener";

  async fetchCandidates(limit: number): Promise<TokenCandidate[]> {
    const resp = await rateLimitedFetch("https://api.dexscreener.com/latest/dex/search?q=SOL");
    if (!resp.ok) throw new Error(`DexScreener status ${resp.status}`);

    const body = await resp.json() as { pairs?: DexPair[] };
    const pairs = Array.isArray(body.pairs) ? body.pairs : [];

    return pairs
      .filter(p => p.chainId === "solana")
      .filter(p => Number(p.liquidity?.usd ?? 0) > 10000)
      .sort((a, b) => Number(b.volume?.h1 ?? 0) - Number(a.volume?.h1 ?? 0))
      .slice(0, limit)
      .map(p => this.mapPair(p))
      .filter(t => t.address.length > 0);
  }

  async fetchByTokenAddress(tokenAddress: string): Promise<TokenCandidate | null> {
    const resp = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!resp.ok) return null;

    const body = await resp.json() as { pairs?: DexPair[] };
    const pairs = (body.pairs ?? []).filter(p => p.chainId === "solana");
    if (pairs.length === 0) return null;

    const best = pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
    return this.mapPair(best);
  }

  private mapPair(p: DexPair): TokenCandidate {
    const createdAt  = typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null;
    const ageMinutes = createdAt ? Math.max(0, Math.floor((Date.now() - createdAt) / 60000)) : null;

    return {
      address:       p.baseToken?.address ?? "",
      symbol:        p.baseToken?.symbol  ?? "UNKNOWN",
      name:          p.baseToken?.name    ?? "Unknown",
      source:        this.name,
      priceUsd:      Number(p.priceUsd ?? 0),
      liquidityUsd:  Number(p.liquidity?.usd ?? 0),
      volume24hUsd:  Number(p.volume?.h24 ?? 0),
      volume1hUsd:   Number(p.volume?.h1  ?? 0),
      priceChange5m: Number(p.priceChange?.m5  ?? 0),
      priceChange1h: Number(p.priceChange?.h1  ?? 0),
      priceChange24h:Number(p.priceChange?.h24 ?? 0),
      fdvUsd:        Number(p.fdv ?? p.marketCap ?? 0),
      ageMinutes,
      txns5m:   (p.txns?.m5?.buys ?? 0) + (p.txns?.m5?.sells ?? 0),
      txns1h:   (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0),
      buys1h:   p.txns?.h1?.buys  ?? 0,
      sells1h:  p.txns?.h1?.sells ?? 0,
      top10HolderPct: null, // enriched via RPC if available
      dexId:       p.dexId       ?? "",
      pairAddress: p.pairAddress ?? "",
      pairUrl:     p.url         ?? "",
    };
  }
}

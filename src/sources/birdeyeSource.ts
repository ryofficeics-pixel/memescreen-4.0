import type { TokenCandidate } from "../domain/types.js";

// BirdEye free-tier endpoint — sorted by 24h volume change % to catch
// early breakouts before they show up on DexScreener's trending list.
// Docs: https://docs.birdeye.so/reference/get_defi-tokenlist
const BIRDEYE_BASE = "https://public-api.birdeye.so";

interface BirdEyeToken {
  address?:           string;
  symbol?:            string;
  name?:              string;
  liquidity?:         number;
  volume24h?:         number;
  volume1h?:          number;
  price?:             number;
  priceChange24h?:    number;
  priceChange1h?:     number;
  fdv?:               number;
  mc?:                number;
  buy24h?:            number;
  sell24h?:           number;
  buy1h?:             number;
  sell1h?:            number;
  lastTradeUnixTime?: number;
}

interface BirdEyeResponse {
  data?: {
    tokens?: BirdEyeToken[];
    total?:  number;
  };
  success?: boolean;
}

export class BirdEyeSource {
  readonly name = "birdeye";

  constructor(private readonly apiKey: string) {}

  async fetchCandidates(limit: number): Promise<TokenCandidate[]> {
    // Sort by v24hChangePercent — surfaces tokens whose volume is
    // accelerating, not just already-high, giving earlier entry signals
    const url = `${BIRDEYE_BASE}/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=${limit}&min_liquidity=10000`;

    const resp = await fetch(url, {
      headers: {
        "X-API-KEY":   this.apiKey,
        "x-chain":     "solana",
        "User-Agent":  "memescreener/4.0",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!resp.ok) {
      throw new Error(`BirdEye HTTP ${resp.status}: ${resp.statusText}`);
    }

    const body = await resp.json() as BirdEyeResponse;

    if (!body.success || !Array.isArray(body.data?.tokens)) {
      throw new Error("BirdEye: unexpected response shape");
    }

    return body.data!.tokens!
      .filter(t => t.address && t.address.length > 0)
      .map(t => this.mapToken(t));
  }

  private mapToken(t: BirdEyeToken): TokenCandidate {
    // BirdEye doesn't expose pair creation time directly — derive a rough
    // age proxy from lastTradeUnixTime; treat as null if unavailable
    const ageMinutes = t.lastTradeUnixTime
      ? Math.max(0, Math.floor((Date.now() / 1000 - t.lastTradeUnixTime) / 60))
      : null;

    const buys1h  = t.buy1h  ?? 0;
    const sells1h = t.sell1h ?? 0;

    return {
      address:        t.address       ?? "",
      symbol:         t.symbol        ?? "UNKNOWN",
      name:           t.name          ?? "",
      source:         "birdeye",
      sources:        ["birdeye"],
      priceUsd:       t.price         ?? 0,
      liquidityUsd:   t.liquidity     ?? 0,
      volume24hUsd:   t.volume24h     ?? 0,
      volume1hUsd:    t.volume1h      ?? 0,
      priceChange5m:  0,               // not in BirdEye free tokenlist
      priceChange1h:  t.priceChange1h ?? 0,
      priceChange24h: t.priceChange24h ?? 0,
      fdvUsd:         t.fdv           ?? t.mc ?? 0,
      ageMinutes,
      txns5m:         0,               // not in BirdEye free tokenlist
      txns1h:         buys1h + sells1h,
      buys1h,
      sells1h,
      top10HolderPct: null,            // requires separate BirdEye endpoint
      dexId:          "birdeye",
      pairAddress:    t.address       ?? "",
      pairUrl:        `https://birdeye.so/token/${t.address ?? ""}?chain=solana`,
    };
  }
}

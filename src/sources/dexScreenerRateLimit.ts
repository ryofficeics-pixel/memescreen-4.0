// Shared rate limiter for all DexScreener API calls across sources.
// DexScreener free tier: ~30 req/min = 1 per 2s minimum.
// Both dexScreenerSource and pumpfunSource import from here so they
// cooperate on the same token bucket rather than racing independently.

let lastFetchTime = 0;
const MIN_INTERVAL_MS = 2200; // slightly over 2s for safety margin

export async function dexScreenerFetch(url: string): Promise<Response> {
  const now  = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastFetchTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetchTime = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "memescreener/4.0" },
    signal:  AbortSignal.timeout(10000),
  });
}

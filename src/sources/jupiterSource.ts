import type { JupiterCheckResult } from "../domain/types.js";

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const SOL_MINT          = "So11111111111111111111111111111111111111112";

/**
 * Check if a token is routable on Jupiter (i.e. can be swapped/sold).
 * Requires a free API key from portal.jup.ag
 * If no API key provided, returns { routable: null, checked: false }
 */
export async function checkJupiterRoutable(
  tokenAddress: string,
  apiKey: string | undefined
): Promise<JupiterCheckResult> {
  if (!apiKey) {
    return { routable: false, checked: false };
  }

  try {
    const url = `${JUPITER_PRICE_URL}?ids=${tokenAddress}&vsToken=${SOL_MINT}`;
    const res = await fetch(url, {
      headers: {
        "Accept":    "application/json",
        "x-api-key": apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { routable: false, checked: true, error: `HTTP ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;

    // Jupiter returns data keyed by token address if routable
    const tokenData = (data as Record<string, Record<string, unknown>>)[tokenAddress];
    const routable  = !!tokenData && typeof tokenData["price"] !== "undefined";

    return { routable, checked: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { routable: false, checked: false, error };
  }
}

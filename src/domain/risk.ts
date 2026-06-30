import type { AppEnv } from "../config/env.js";
import type { RiskResult, TokenCandidate } from "./types.js";

export async function computeRisk(
  candidate: TokenCandidate,
  env: AppEnv,
  rpcUrl: string
): Promise<RiskResult> {
  let riskScore = 0;
  const flags: string[] = [];
  const hardAvoidReasons: string[] = [];

  // ── CHECK 1: Address validity ──────────────────────────────────────────
  const addressOk = isValidSolanaAddress(candidate.address);
  if (!addressOk) hardAvoidReasons.push("invalid_solana_address");

  // ── CHECK 2: Token age ────────────────────────────────────────────────
  let ageCheck = { passed: false, value: "unknown" };
  if (candidate.ageMinutes === null) {
    riskScore += 10;
    flags.push("unknown_age");
    ageCheck = { passed: false, value: "unknown" };
  } else if (candidate.ageMinutes < 3) {
    hardAvoidReasons.push("too_new_under_3m");
    ageCheck = { passed: false, value: `${candidate.ageMinutes}m` };
  } else if (candidate.ageMinutes < env.MIN_TOKEN_AGE_MINUTES) {
    riskScore += 12;
    flags.push("young_token");
    ageCheck = { passed: false, value: `${candidate.ageMinutes}m` };
  } else {
    ageCheck = { passed: true, value: `${Math.floor(candidate.ageMinutes / 60)}h ${candidate.ageMinutes % 60}m` };
  }

  // ── CHECK 3: Liquidity ────────────────────────────────────────────────
  let liqCheck = { passed: false, value: "" };
  const liqFmt = `$${(candidate.liquidityUsd / 1000).toFixed(1)}K`;
  if (candidate.liquidityUsd < env.MIN_LIQUIDITY_USD / 2) {
    hardAvoidReasons.push("critical_low_liquidity");
    liqCheck = { passed: false, value: liqFmt };
  } else if (candidate.liquidityUsd < env.MIN_LIQUIDITY_USD) {
    riskScore += 20;
    flags.push("low_liquidity");
    liqCheck = { passed: false, value: liqFmt };
  } else {
    liqCheck = { passed: true, value: liqFmt };
  }

  // ── CHECK 4: Volume 24h ───────────────────────────────────────────────
  let volCheck = { passed: false, value: "" };
  const volFmt = `$${(candidate.volume24hUsd / 1000).toFixed(1)}K`;
  if (candidate.volume24hUsd < env.MIN_VOLUME_24H_USD / 3) {
    hardAvoidReasons.push("critical_low_volume");
    volCheck = { passed: false, value: volFmt };
  } else if (candidate.volume24hUsd < env.MIN_VOLUME_24H_USD) {
    riskScore += 15;
    flags.push("low_volume");
    volCheck = { passed: false, value: volFmt };
  } else {
    volCheck = { passed: true, value: volFmt };
  }

  // ── CHECK 5: Volatility (extreme = likely pump-dump already done) ─────
  let volatCheck = { passed: true, value: "" };
  const abs5m = Math.abs(candidate.priceChange5m);
  const abs1h = Math.abs(candidate.priceChange1h);
  if (abs5m > 80) {
    hardAvoidReasons.push("extreme_5m_volatility");
    volatCheck = { passed: false, value: `5m:${candidate.priceChange5m.toFixed(0)}%` };
  } else if (abs5m > 40) {
    riskScore += 14;
    flags.push("high_5m_volatility");
    volatCheck = { passed: false, value: `5m:${candidate.priceChange5m.toFixed(0)}%` };
  }
  if (abs1h > 150) {
    riskScore += 18;
    flags.push("extreme_1h_move");
    volatCheck = { passed: false, value: `1h:${candidate.priceChange1h.toFixed(0)}%` };
  }
  if (volatCheck.passed) {
    volatCheck.value = `5m:${candidate.priceChange5m.toFixed(1)}% 1h:${candidate.priceChange1h.toFixed(1)}%`;
  }

  // ── CHECK 6: FDV / Liquidity ratio ───────────────────────────────────
  let fdvCheck = { passed: true, value: "—" };
  if (candidate.fdvUsd > 0 && candidate.liquidityUsd > 0) {
    const ratio = candidate.fdvUsd / candidate.liquidityUsd;
    fdvCheck.value = `${ratio.toFixed(0)}x`;
    if (ratio > 300) {
      riskScore += 16;
      flags.push("fdv_liquidity_extreme");
      fdvCheck.passed = false;
    } else if (ratio > 150) {
      riskScore += 10;
      flags.push("fdv_liquidity_imbalance");
      fdvCheck.passed = false;
    }
  }

  // ── CHECK 7: Top-10 holder concentration ─────────────────────────────
  let holderCheck = { passed: true, value: "—" };
  if (typeof candidate.top10HolderPct === "number") {
    holderCheck.value = `${candidate.top10HolderPct.toFixed(1)}%`;
    if (candidate.top10HolderPct > 85) {
      hardAvoidReasons.push("extreme_holder_concentration");
      holderCheck.passed = false;
    } else if (candidate.top10HolderPct > env.MAX_TOP10_HOLDER_PCT) {
      riskScore += 18;
      flags.push("holder_concentration");
      holderCheck.passed = false;
    }
  }

  // ── CHECK 8: Honeypot — RPC simulate sell ────────────────────────────
  const honeypotResult = await checkHoneypot(candidate.address, rpcUrl);
  if (!honeypotResult.passed) {
    if (honeypotResult.hardBlock) {
      hardAvoidReasons.push("honeypot_detected");
    } else {
      riskScore += 25;
      flags.push("honeypot_risk");
    }
  }

  // ── CHECK 9: Mint authority ───────────────────────────────────────────
  const mintResult = await checkMintAuthority(candidate.address, rpcUrl);
  if (!mintResult.passed) {
    riskScore += 8;
    flags.push("mint_authority_active");
  }

  // Symbol quality
  if (!candidate.symbol || candidate.symbol.length > 16) {
    riskScore += 5;
    flags.push("symbol_quality_risk");
  }

  riskScore = Math.max(0, Math.min(100, riskScore));

  return {
    riskScore,
    flags,
    hardAvoid: hardAvoidReasons.length > 0,
    hardAvoidReasons,
    checks: {
      age:        ageCheck,
      liquidity:  liqCheck,
      volume:     volCheck,
      volatility: volatCheck,
      fdvRatio:   fdvCheck,
      holderConc: holderCheck,
      honeypot:   { passed: honeypotResult.passed, value: honeypotResult.value },
      mintAuth:   { passed: mintResult.passed, value: mintResult.value },
    }
  };
}

// ─── Honeypot check via QuickNode RPC ─────────────────────────────────────
async function checkHoneypot(
  tokenAddress: string,
  rpcUrl: string
): Promise<{ passed: boolean; hardBlock: boolean; value: string }> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [tokenAddress, { encoding: "jsonParsed" }]
      }),
      signal: AbortSignal.timeout(6000)
    });

    const data = await res.json() as {
      result?: { value?: { data?: { parsed?: { info?: {
        extensions?: Array<{ extension: string; state?: { newerTransferFee?: { transferFeeBasisPoints?: number } } }>;
        mintAuthority?: string | null;
      } } } } }
    };

    const info = data?.result?.value?.data?.parsed?.info;
    if (!info) return { passed: true, value: "unverified", hardBlock: false };

    const extensions = info.extensions ?? [];
    const feeExt = extensions.find(e => e.extension === "transferFeeConfig");
    if (feeExt) {
      const bps = feeExt.state?.newerTransferFee?.transferFeeBasisPoints ?? 0;
      const pct = bps / 100;
      if (pct > 10) return { passed: false, hardBlock: true,  value: `${pct}% fee` };
      if (pct > 5)  return { passed: false, hardBlock: false, value: `${pct}% fee` };
    }

    return { passed: true, value: "OK", hardBlock: false };
  } catch {
    return { passed: false, hardBlock: false, value: "rpc_error" };
  }
}

// ─── Mint authority check via QuickNode RPC ────────────────────────────────
async function checkMintAuthority(
  tokenAddress: string,
  rpcUrl: string
): Promise<{ passed: boolean; value: string }> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [tokenAddress, { encoding: "jsonParsed" }]
      }),
      signal: AbortSignal.timeout(6000)
    });

    const data = await res.json() as {
      result?: { value?: { data?: { parsed?: { info?: { mintAuthority?: string | null } } } } }
    };

    const mintAuth = data?.result?.value?.data?.parsed?.info?.mintAuthority;
    const revoked  = mintAuth === null || mintAuth === undefined;
    return { passed: revoked, value: revoked ? "REVOKED" : "ACTIVE" };
  } catch {
    return { passed: false, value: "rpc_error" };
  }
}

// ─── Solana address validation ─────────────────────────────────────────────
export function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

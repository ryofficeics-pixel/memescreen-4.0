// ─── Token from data sources ───────────────────────────────────────────────
export interface TokenCandidate {
  address:        string;
  symbol:         string;
  name:           string;
  source:         string;    // primary source (first to surface this token)
  sources:        string[];  // all sources that found this token in the same scan cycle
  priceUsd:       number;
  liquidityUsd:   number;
  volume24hUsd:   number;
  volume1hUsd:    number;
  priceChange5m:  number;
  priceChange1h:  number;
  priceChange24h: number;
  fdvUsd:         number;
  ageMinutes:     number | null;
  txns5m:         number;
  txns1h:         number;
  buys1h:         number;
  sells1h:        number;
  top10HolderPct: number | null;
  dexId:          string;
  pairAddress:    string;
  pairUrl:        string;
}

// ─── Anti-scam result ──────────────────────────────────────────────────────
export interface CheckResult {
  passed: boolean;
  value:  string;
}

export interface RiskResult {
  riskScore:        number;
  flags:            string[];
  hardAvoid:        boolean;
  hardAvoidReasons: string[];
  checks: {
    age:         CheckResult;
    liquidity:   CheckResult;
    volume:      CheckResult;
    volatility:  CheckResult;
    fdvRatio:    CheckResult;
    holderConc:  CheckResult;
    honeypot:    CheckResult;
    mintAuth:    CheckResult;
  };
}

// ─── Opportunity result ────────────────────────────────────────────────────
export interface OpportunityComponents {
  volumeVelocity:   number;
  priceMomentum:    number;
  holderGrowth:     number;
  liquidityDepth:   number;
  txActivity:       number;
  ageWindow:        number;
  // ── 4.0 additions ────────────────────────────────────────────────────────
  buySellPressure:  number;  // 0-100: buy-side dominance signal
  liquidityGrowth:  number;  // 0-6: liq grew vs previous scan cycle
  crossSourceBonus: number;  // 0-12: token confirmed across multiple sources
}

export interface OpportunityResult {
  opportunityScore: number;
  momentumScore:    number;
  components:       OpportunityComponents;
  reasons:          string[];
}

// ─── Final screened token ──────────────────────────────────────────────────
export type TokenDecision = "alert" | "watch" | "avoid";

export interface ScreenedToken extends TokenCandidate {
  risk:        RiskResult;
  opportunity: OpportunityResult;
  decision:    TokenDecision;
  finalScore:  number;
  evidence:    string[];
}

// ─── Scan summary ──────────────────────────────────────────────────────────
export interface ScanSummary {
  runId:           string;
  totalCandidates: number;
  alertsCount:     number;
  watchCount:      number;
  avoidCount:      number;
  durationMs:      number;
  sourceStatuses:  SourceStatus[];
}

export interface SourceStatus {
  name:       string;
  ok:         boolean;
  count:      number;
  latencyMs:  number;
  error?:     string;
}

// ─── DB rows (snake_case from SQLite) ─────────────────────────────────────
export interface AlertRow {
  id:               number;
  token_address:    string;
  symbol:           string;
  final_score:      number;
  risk_score:       number;
  opportunity_score:number;
  tier:             string | null;
  price_usd:        number;
  volume_1h:        number;
  liquidity_usd:    number;
  decision:         string;
  evidence:         string;
  telegram_sent:    number;
  user_action:      string | null;
  created_at:       string;
}

export interface TokenRow {
  address:          string;
  symbol:           string;
  name:             string;
  dex_id:           string;
  pair_url:         string;
  price_usd:        number;
  volume_1h:        number;
  volume_24h:       number;
  price_change_1h:  number;
  price_change_5m:  number;
  liquidity_usd:    number;
  fdv_usd:          number;
  age_minutes:      number | null;
  risk_score:       number;
  opportunity_score:number;
  final_score:      number;
  tier:             string;
  tier_confidence:  number;
  jupiter_routable: number | null;
  decision:         string;
  flags:            string;
  hard_avoid:       number;
  honeypot_ok:      number;
  mint_auth_ok:     number;
  top10_holder_pct: number | null;
  evidence:         string;
  last_scanned:     string;
}

export interface ScanRow {
  id:               number;
  run_id:           string;
  total_candidates: number;
  alerts_count:     number;
  watch_count:      number;
  avoid_count:      number;
  duration_ms:      number;
  created_at:       string;
}

// ─── Tier system (from VectorControl) ─────────────────────────────────────
export type Tier = "S" | "A" | "B" | "C" | "REJECT";

export interface TierResult {
  tier:           Tier;
  finalScore:     number;
  confidence:     number;
}

// ─── Paper trading (from VectorControl) ───────────────────────────────────
export interface Position {
  id:          string;
  address:     string;
  symbol:      string;
  entryPrice:  number;
  amountSol:   number;
  slPct:       number | null;
  tpPct:       number | null;
  openedAt:    string;
  status:      "open";
}

export interface ClosedPosition {
  id:          string;
  positionId:  string;
  address:     string;
  symbol:      string;
  entryPrice:  number;
  exitPrice:   number;
  amountSol:   number;
  pnlPct:      number | null;
  pnlSol:      number | null;
  reason:      "manual" | "stop-loss" | "take-profit" | "partial";
  openedAt:    string;
  closedAt:    string;
}

// ─── Jupiter check ─────────────────────────────────────────────────────────
export interface JupiterCheckResult {
  routable:   boolean;
  checked:    boolean;
  error?:     string;
}

// ─── DB rows for positions ─────────────────────────────────────────────────
export interface PositionRow {
  id:           string;
  address:      string;
  symbol:       string;
  entry_price:  number;
  amount_sol:   number;
  sl_pct:       number | null;
  tp_pct:       number | null;
  opened_at:    string;
  status:       string;
}

export interface ClosedPositionRow {
  id:           string;
  position_id:  string;
  address:      string;
  symbol:       string;
  entry_price:  number;
  exit_price:   number;
  amount_sol:   number;
  pnl_pct:      number | null;
  pnl_sol:      number | null;
  reason:       string;
  opened_at:    string;
  closed_at:    string;
}

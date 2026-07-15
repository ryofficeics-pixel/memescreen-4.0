import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  AlertRow, ScreenedToken, ScanSummary, SourceStatus,
  TokenRow, ScanRow
} from "../domain/types.js";
import { PositionsRepository } from "./positionsRepository.js";

export class Repository {
  readonly db: BetterSqlite3.Database;
  readonly positions: PositionsRepository;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.positions = new PositionsRepository(this.db);
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        address           TEXT PRIMARY KEY,
        symbol            TEXT NOT NULL,
        name              TEXT,
        dex_id            TEXT,
        pair_url          TEXT,
        price_usd         REAL,
        volume_1h         REAL,
        volume_24h        REAL,
        price_change_1h   REAL,
        price_change_5m   REAL,
        liquidity_usd     REAL,
        fdv_usd           REAL,
        age_minutes       INTEGER,
        risk_score        INTEGER,
        opportunity_score INTEGER,
        final_score       INTEGER,
        tier              TEXT DEFAULT 'C',
        tier_confidence   INTEGER DEFAULT 0,
        jupiter_routable  INTEGER,
        decision          TEXT,
        flags             TEXT,
        hard_avoid        INTEGER DEFAULT 0,
        honeypot_ok       INTEGER DEFAULT 0,
        mint_auth_ok      INTEGER DEFAULT 0,
        top10_holder_pct  REAL,
        evidence          TEXT,
        moonshot_score    INTEGER DEFAULT 0,
        moonshot_flag     INTEGER DEFAULT 0,
        first_seen_price_usd REAL,
        first_seen_at         TEXT,
        peak_price_usd        REAL,
        peak_liquidity_usd    REAL,
        last_scanned      TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address     TEXT NOT NULL,
        symbol            TEXT,
        final_score       INTEGER,
        risk_score        INTEGER,
        opportunity_score INTEGER,
        tier              TEXT,
        price_usd         REAL,
        volume_1h         REAL,
        liquidity_usd     REAL,
        decision          TEXT,
        evidence          TEXT,
        telegram_sent     INTEGER DEFAULT 0,
        user_action       TEXT,
        created_at        TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS scans (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT,
        total_candidates INTEGER,
        alerts_count     INTEGER,
        watch_count      INTEGER,
        avoid_count      INTEGER,
        duration_ms      INTEGER,
        created_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS source_status (
        name            TEXT PRIMARY KEY,
        last_ok         INTEGER DEFAULT 0,
        last_count      INTEGER DEFAULT 0,
        last_latency_ms INTEGER DEFAULT 0,
        last_error      TEXT,
        last_success_at TEXT,
        last_failure_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tokens_score    ON tokens(final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_tokens_tier     ON tokens(tier);
      CREATE INDEX IF NOT EXISTS idx_tokens_decision ON tokens(decision);
      CREATE INDEX IF NOT EXISTS idx_alerts_created  ON alerts(created_at DESC);
    `);

    // ── 4.0 migration: add new columns to existing DBs without data loss ──
    const tokenCols = (this.db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[]).map(r => r.name);
    if (!tokenCols.includes("sources")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN sources TEXT`);
    }
    if (!tokenCols.includes("liquidity_prev")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN liquidity_prev REAL`);
    }
    if (!tokenCols.includes("moonshot_score")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN moonshot_score INTEGER DEFAULT 0`);
    }
    if (!tokenCols.includes("moonshot_flag")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN moonshot_flag INTEGER DEFAULT 0`);
    }
    // Pump-window history: tracks each token's first-seen price and the
    // running peak price/liquidity across every scan, independent of
    // DexScreener's fixed 5m/1h/24h rolling windows and independent of the
    // scanner's own poll interval. A 1-2h scan cadence can miss a pump that
    // happens between two scans; DexScreener's h24 field can also miss one
    // that happened 24-48h ago by the time you next look. Comparing current
    // price to the price the very first time this scanner saw the token
    // catches it regardless of when the pump actually happened within the
    // documented 48h post-release window.
    if (!tokenCols.includes("first_seen_price_usd")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN first_seen_price_usd REAL`);
      this.db.exec(`UPDATE tokens SET first_seen_price_usd = price_usd WHERE first_seen_price_usd IS NULL`);
    }
    if (!tokenCols.includes("first_seen_at")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN first_seen_at TEXT`);
      this.db.exec(`UPDATE tokens SET first_seen_at = last_scanned WHERE first_seen_at IS NULL`);
    }
    if (!tokenCols.includes("peak_price_usd")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN peak_price_usd REAL`);
      this.db.exec(`UPDATE tokens SET peak_price_usd = price_usd WHERE peak_price_usd IS NULL`);
    }
    if (!tokenCols.includes("peak_liquidity_usd")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN peak_liquidity_usd REAL`);
      this.db.exec(`UPDATE tokens SET peak_liquidity_usd = liquidity_usd WHERE peak_liquidity_usd IS NULL`);
    }

    this.positions.init();

    // Paper wallet: seed 1 SOL on first run
    if (this.getSetting("paper_wallet_balance") === null) {
      this.setWalletBalance(1);
      console.log("[WALLET] Seeded paper wallet with 1 SOL");
    }

    console.log("[DB] Schema ready (v4.0)");
  }

  // ── Tokens ──────────────────────────────────────────────────────────────
  upsertToken(t: ScreenedToken & {
    tier: string;
    tierConfidence: number;
    jupiterRoutable: boolean | null;
  }): void {
    // Pre-fetch previous liquidity so we can pass it as a plain bind param.
    // SQLite doesn't allow subqueries inside VALUES() with better-sqlite3.
    const prevLiq = (this.db.prepare(
      `SELECT liquidity_usd FROM tokens WHERE address = ?`
    ).get(t.address) as { liquidity_usd: number | null } | undefined)?.liquidity_usd ?? null;

    this.db.prepare(`
      INSERT INTO tokens (
        address, symbol, name, dex_id, pair_url,
        price_usd, volume_1h, volume_24h, price_change_1h, price_change_5m,
        liquidity_usd, liquidity_prev, fdv_usd, age_minutes,
        risk_score, opportunity_score, final_score,
        tier, tier_confidence, jupiter_routable,
        decision, flags, hard_avoid, honeypot_ok, mint_auth_ok,
        top10_holder_pct, evidence, sources, moonshot_score, moonshot_flag,
        first_seen_price_usd, first_seen_at, peak_price_usd, peak_liquidity_usd,
        last_scanned
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,datetime('now'))
      ON CONFLICT(address) DO UPDATE SET
        symbol            = excluded.symbol,
        price_usd         = excluded.price_usd,
        volume_1h         = excluded.volume_1h,
        volume_24h        = excluded.volume_24h,
        price_change_1h   = excluded.price_change_1h,
        price_change_5m   = excluded.price_change_5m,
        liquidity_prev    = tokens.liquidity_usd,
        liquidity_usd     = excluded.liquidity_usd,
        fdv_usd           = excluded.fdv_usd,
        age_minutes       = excluded.age_minutes,
        risk_score        = excluded.risk_score,
        opportunity_score = excluded.opportunity_score,
        final_score       = excluded.final_score,
        tier              = excluded.tier,
        tier_confidence   = excluded.tier_confidence,
        jupiter_routable  = excluded.jupiter_routable,
        decision          = excluded.decision,
        flags             = excluded.flags,
        hard_avoid        = excluded.hard_avoid,
        honeypot_ok       = excluded.honeypot_ok,
        mint_auth_ok      = excluded.mint_auth_ok,
        top10_holder_pct  = excluded.top10_holder_pct,
        evidence          = excluded.evidence,
        sources           = excluded.sources,
        moonshot_score    = excluded.moonshot_score,
        moonshot_flag     = excluded.moonshot_flag,
        first_seen_price_usd = COALESCE(tokens.first_seen_price_usd, excluded.first_seen_price_usd),
        first_seen_at         = COALESCE(tokens.first_seen_at, excluded.first_seen_at),
        peak_price_usd         = MAX(COALESCE(tokens.peak_price_usd, 0), excluded.price_usd),
        peak_liquidity_usd     = MAX(COALESCE(tokens.peak_liquidity_usd, 0), excluded.liquidity_usd),
        last_scanned      = datetime('now')
    `).run(
      t.address, t.symbol, t.name, t.dexId, t.pairUrl,
      t.priceUsd, t.volume1hUsd, t.volume24hUsd, t.priceChange1h, t.priceChange5m,
      t.liquidityUsd,
      prevLiq,   // previous liquidity for growth proxy
      t.fdvUsd, t.ageMinutes,
      t.risk.riskScore, t.opportunity.opportunityScore, t.finalScore,
      t.tier, t.tierConfidence,
      t.jupiterRoutable === null ? null : (t.jupiterRoutable ? 1 : 0),
      t.decision, JSON.stringify(t.risk.flags),
      t.risk.hardAvoid ? 1 : 0,
      t.risk.checks.honeypot.passed ? 1 : 0,
      t.risk.checks.mintAuth.passed ? 1 : 0,
      t.top10HolderPct,
      JSON.stringify(t.evidence),
      Array.isArray(t.sources) ? t.sources.join(",") : (t.source ?? ""),
      t.moonshot.moonshotScore,
      t.moonshot.isMoonshotCandidate ? 1 : 0,
      t.priceUsd, // first_seen_price_usd (only used if this is a new row)
      t.priceUsd, // peak_price_usd (only used if this is a new row)
      t.liquidityUsd // peak_liquidity_usd (only used if this is a new row)
    );
  }

  // ── 4.0: Previous liquidity for growth proxy ────────────────────────────
  getPreviousLiquidity(address: string): number | null {
    const row = this.db.prepare(
      `SELECT liquidity_prev FROM tokens WHERE address = ?`
    ).get(address) as { liquidity_prev: number | null } | undefined;
    return row?.liquidity_prev ?? null;
  }

  // Pump-window history for the moonshot detector — see migration comment
  // above for why this exists (DexScreener's rolling windows + a 1-2h scan
  // cadence can both individually miss a pump within the 48h window; this
  // catches it regardless, by comparing against this scanner's own record).
  getPriceHistory(address: string): {
    firstSeenPriceUsd: number | null;
    firstSeenAt:       string | null;
    peakPriceUsd:       number | null;
    peakLiquidityUsd:   number | null;
  } {
    const row = this.db.prepare(
      `SELECT first_seen_price_usd, first_seen_at, peak_price_usd, peak_liquidity_usd FROM tokens WHERE address = ?`
    ).get(address) as {
      first_seen_price_usd: number | null;
      first_seen_at:        string | null;
      peak_price_usd:        number | null;
      peak_liquidity_usd:    number | null;
    } | undefined;

    return {
      firstSeenPriceUsd: row?.first_seen_price_usd ?? null,
      firstSeenAt:       row?.first_seen_at ?? null,
      peakPriceUsd:       row?.peak_price_usd ?? null,
      peakLiquidityUsd:   row?.peak_liquidity_usd ?? null,
    };
  }

  // ── 4.0: Source statuses for /sources command ────────────────────────────
  getAllSourceStatuses() {
    return this.db.prepare(`SELECT * FROM source_status ORDER BY name`).all() as {
      name: string;
      last_ok: number;
      last_count: number;
      last_latency_ms: number;
      last_error: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
    }[];
  }

  listTokens(limit = 100, filter?: { decision?: string; tier?: string }): TokenRow[] {
    if (filter?.tier) {
      return this.db.prepare(
        `SELECT * FROM tokens WHERE tier = ? ORDER BY final_score DESC LIMIT ?`
      ).all(filter.tier, limit) as TokenRow[];
    }
    if (filter?.decision) {
      return this.db.prepare(
        `SELECT * FROM tokens WHERE decision = ? ORDER BY final_score DESC LIMIT ?`
      ).all(filter.decision, limit) as TokenRow[];
    }
    return this.db.prepare(
      `SELECT * FROM tokens WHERE decision != 'avoid' ORDER BY final_score DESC LIMIT ?`
    ).all(limit) as TokenRow[];
  }

  listTokensByTiers(tiers: string[]): TokenRow[] {
    const placeholders = tiers.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM tokens WHERE tier IN (${placeholders}) ORDER BY final_score DESC LIMIT 200`
    ).all(...tiers) as TokenRow[];
  }

  getToken(address: string): TokenRow | undefined {
    return this.db.prepare(
      `SELECT * FROM tokens WHERE address = ?`
    ).get(address) as TokenRow | undefined;
  }

  getPreviousTier(address: string): string | null {
    const row = this.db.prepare(
      `SELECT tier FROM tokens WHERE address = ?`
    ).get(address) as { tier: string } | undefined;
    return row?.tier ?? null;
  }

  // ── Alerts ──────────────────────────────────────────────────────────────
  saveAlert(t: ScreenedToken & { tier: string }, telegramSent: boolean): number {
    const res = this.db.prepare(`
      INSERT INTO alerts (
        token_address, symbol, final_score, risk_score, opportunity_score,
        tier, price_usd, volume_1h, liquidity_usd, decision, evidence, telegram_sent
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      t.address, t.symbol, t.finalScore,
      t.risk.riskScore, t.opportunity.opportunityScore,
      t.tier, t.priceUsd, t.volume1hUsd, t.liquidityUsd,
      t.decision, JSON.stringify(t.evidence),
      telegramSent ? 1 : 0
    );
    return res.lastInsertRowid as number;
  }

  markTelegramSent(alertId: number): void {
    this.db.prepare(`UPDATE alerts SET telegram_sent = 1 WHERE id = ?`).run(alertId);
  }

  listAlerts(limit = 50): AlertRow[] {
    return this.db.prepare(
      `SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as AlertRow[];
  }

  updateAlertAction(id: number, action: string): void {
    this.db.prepare(`UPDATE alerts SET user_action = ? WHERE id = ?`).run(action, id);
  }

  countAlertsLastHour(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as c FROM alerts WHERE created_at > datetime('now', '-1 hour')`
    ).get() as { c: number };
    return row.c;
  }

  // ── Scans ───────────────────────────────────────────────────────────────
  saveScan(s: ScanSummary): void {
    this.db.prepare(`
      INSERT INTO scans (run_id, total_candidates, alerts_count, watch_count, avoid_count, duration_ms)
      VALUES (?,?,?,?,?,?)
    `).run(s.runId, s.totalCandidates, s.alertsCount, s.watchCount, s.avoidCount, s.durationMs);
  }

  getLastScan(): ScanRow | undefined {
    return this.db.prepare(`SELECT * FROM scans ORDER BY id DESC LIMIT 1`).get() as ScanRow | undefined;
  }

  // ── Source status ────────────────────────────────────────────────────────
  recordSourceStatus(s: SourceStatus): void {
    this.db.prepare(`
      INSERT INTO source_status (name, last_ok, last_count, last_latency_ms, last_error, last_success_at, last_failure_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET
        last_ok         = excluded.last_ok,
        last_count      = excluded.last_count,
        last_latency_ms = excluded.last_latency_ms,
        last_error      = excluded.last_error,
        last_success_at = CASE WHEN excluded.last_ok = 1 THEN datetime('now') ELSE last_success_at END,
        last_failure_at = CASE WHEN excluded.last_ok = 0 THEN datetime('now') ELSE last_failure_at END
    `).run(
      s.name, s.ok ? 1 : 0, s.count, s.latencyMs,
      s.error ?? null,
      s.ok ? new Date().toISOString() : null,
      s.ok ? null : new Date().toISOString()
    );
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  setSetting(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // ── Dashboard snapshot ───────────────────────────────────────────────────
  getDashboardSnapshot() {
    const pnlStats = this.positions.getPnlStats();
    return {
      alertTokens:    this.listTokensByTiers(["S", "A"]),
      watchTokens:    this.listTokensByTiers(["B", "C"]),
      allTiers:       {
        S:      this.listTokensByTiers(["S"]),
        A:      this.listTokensByTiers(["A"]),
        B:      this.listTokensByTiers(["B"]),
        C:      this.listTokensByTiers(["C"]),
        REJECT: [],
      },
      recentAlerts:   this.listAlerts(20),
      openPositions:  this.positions.listOpenPositions(),
      closedPositions:this.positions.listClosedPositions(30),
      pnlStats,
      lastScan:       this.getLastScan(),
      alertsLastHour: this.countAlertsLastHour(),
    };
  }

  // ── Paper wallet ──────────────────────────────────────────────────────────
  getWalletBalance(): number {
    const bal = this.getSetting("paper_wallet_balance");
    return bal !== null ? parseFloat(bal) : 0;
  }

  setWalletBalance(amount: number): void {
    this.setSetting("paper_wallet_balance", amount.toFixed(6));
  }

  deductWallet(amount: number): boolean {
    const bal = this.getWalletBalance();
    if (bal < amount) return false;
    this.setWalletBalance(bal - amount);
    return true;
  }

  creditWallet(amount: number): void {
    const bal = this.getWalletBalance();
    this.setWalletBalance(bal + amount);
  }

  // ── Auto-trade config (runtime toggleable) ──────────────────────────────
  getAutoTradeEnabled(): boolean {
    return this.getSetting("auto_trade_enabled") === "true";
  }

  setAutoTradeEnabled(enabled: boolean): void {
    this.setSetting("auto_trade_enabled", enabled ? "true" : "false");
  }

  close(): void { this.db.close(); }
}

# ⚡ MemeScreener 4.0 — Solana Multi-Source Meme Detector

TypeScript · Fastify · Telegraf · SQLite · BetterSqlite3

Early-entry Solana meme token screener with **3 concurrent data sources**, 9-component
momentum scoring (6 base + 3 new 4.0 signals), 8-check anti-scam engine, paper trading
with live P&L dashboard, and full Telegram two-way control.

**Designed to run locally on your laptop first.** No VPS required — paper trading,
dashboard, and Telegram bot all run from `npm run dev` on `localhost:3001`.

---

## What's new in 4.0

| Feature | Detail |
|---------|--------|
| **3 data sources** | DexScreener + BirdEye (volume breakouts) + Pump.fun feed, concurrent |
| **Multi-source dedup** | All sources run in `Promise.allSettled`, merged by address, highest-liquidity wins |
| **Cross-source bonus** | +8 pts if 2 sources confirm, +12 pts if all 3 confirm same token |
| **Buy/sell pressure** | Up to +10 pts: >70% buy-side dominance in 1h txns (>85% flagged as suspicious) |
| **Liquidity growth** | Up to +6 pts: current liq grew ≥25% vs previous scan cycle |
| **Paper trading first** | Portfolio header always visible, live P&L cards, trade journal, quick-buy bar |
| **`/sources` command** | Telegram health report: count, latency, last success per source |
| **Rich `/pnl`** | Best/worst trade %, avg hold time, SOL at risk, realized + unrealized |
| **DB migration** | Zero data loss upgrade from 3.1 — `ALTER TABLE` guard adds new columns |
| **User-Agent 4.0** | All HTTP sources identify as `memescreener/4.0` |

---

## Architecture

```
src/
├── config/env.ts               Zod-validated env — exits with clear error on bad config
├── domain/
│   ├── types.ts                All interfaces (TokenCandidate, RiskResult, etc.)
│   ├── risk.ts                 Anti-scam engine (8 checks, hard-block + soft-flag tiers)
│   ├── opportunity.ts          Momentum scoring (9 signals: 6 base + 3 new 4.0)
│   └── tier.ts                 S/A/B/C/REJECT classification
├── sources/
│   ├── dexScreenerSource.ts    DexScreener API (rate-limited, 30 req/min)
│   ├── birdeyeSource.ts        BirdEye free tier (sorted by v24hChangePercent) ← 4.0
│   └── pumpfunSource.ts        Pump.fun feed via DexScreener filter          ← 4.0
├── db/
│   ├── repository.ts           SQLite WAL (tokens, alerts, scans, source_status)
│   └── positionsRepository.ts  Paper trading (positions, closed_positions, stats)
├── services/
│   ├── screenerService.ts      Multi-source fetch, dedup, scan loop
│   ├── telegramService.ts      Telegraf bot (15 commands + inline approve/reject)
│   ├── alertService.ts         Alert bridge (save → telegram → mark sent)
│   └── jupiterSource.ts        Optional Jupiter routability check
├── server/
│   └── api.ts                  Fastify REST + WS + static dashboard (v4.0.0)
└── index.ts                    Entrypoint, DI wiring, cron
```

---

## Scan flow

```
Every SCAN_INTERVAL_MINUTES (default 30):

1. fetchAllCandidates() — concurrent:
   ├── DexScreenerSource  → top N Solana pairs by 1h volume
   ├── BirdEyeSource      → top N by v24hChangePercent (early breakouts)
   └── PumpFunSource      → pump.fun originated pairs (very new, high risk)
   Dedup by address (highest liquidity wins), sources[] array populated

2. Per token — computeRisk() — 8 checks:
   HARD BLOCK (any = skip token entirely):
   ├── Age < 3 minutes
   ├── Liquidity < $25K
   ├── Volume24h < $8K
   ├── 5m price change > ±80%
   ├── Top-10 holders > 85%
   └── Honeypot: transfer fee > 10% via RPC

   SOFT FLAGS (add risk score, don't block):
   ├── Age < MIN_TOKEN_AGE_MINUTES        +12
   ├── Liquidity < MIN_LIQUIDITY_USD      +20
   ├── Volume < MIN_VOLUME_24H_USD        +15
   ├── Volatility 5m > 40%               +14
   ├── FDV/liquidity > 150x              +10
   ├── FDV/liquidity > 300x              +16
   ├── Top-10 > MAX_TOP10_HOLDER_PCT     +18
   ├── Honeypot: fee 5–10%               +25
   └── Mint authority active              +8

3. Per token — computeOpportunity() — 9 signals:
   BASE (weighted, sum to 100%):
   ├── Volume Velocity   30%  (1h vol / 24h hourly avg, log scale)
   ├── Price Momentum    25%  (1h change, sweet spot 5–80%)
   ├── Holder Spread     20%  (inverse of top10 concentration)
   ├── Liquidity Depth   15%  (liq/fdv ratio)
   └── TX Activity       10%  (5m spike vs 1h baseline)

   BONUS (additive, 4.0):
   ├── Buy/sell pressure  +0–10  (>70% buy-side in 1h txns)
   ├── Liquidity growth   +0–6   (liq grew ≥25% since last scan)
   └── Cross-source bonus +0–12  (2 sources=+8, all 3=+12)

   + turnoverBonus +0–12  ($ANSEM pattern: vol/liq ratio)
   + narrativeBonus +0–6  (symbol cluster detection)
   + ageWindow bonus 15%  (optimal window: 10min–12h)

4. Final score = (opportunityScore × 0.90 + (100 − riskScore) × 0.10) − (riskScore × 0.40)

5. Decision:
   ALERT: finalScore ≥ STRONG_BUY_SCORE (75) AND riskScore ≤ MAX_RISK_SCORE (45)
   WATCH: finalScore ≥ MIN_OPPORTUNITY_SCORE (55) AND riskScore ≤ 55
   AVOID: hardAvoid OR neither threshold met

6. ALERT → AlertService → DB save → Telegram → markTelegramSent
   ALL → Repository.upsertToken → SQLite
   ALL → WS broadcast → Dashboard
   SL/TP check → PositionsRepository.checkTriggers()
```

---

## Quick start

```bash
git clone <this repo>
cd memescreener-4.0
cp .env.example .env
# Fill in: QUICKNODE_RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Optional: BIRDEYE_API_KEY for the BirdEye source
npm install
npm run dev
```

Dashboard: `http://localhost:3001`

---

## Environment variables

| Variable | Required | Default | Notes |
|----------|:--------:|---------|-------|
| `QUICKNODE_RPC_URL` | ✅ | — | Solana mainnet RPC |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Your numeric Telegram ID |
| `BIRDEYE_API_KEY` | — | `""` | BirdEye source skipped if absent |
| `PUMPFUN_ENABLED` | — | `true` | Toggle pump.fun source |
| `MULTI_SOURCE_BONUS` | — | `true` | Cross-source confirmation bonus |
| `MAX_TOKENS_PER_SOURCE` | — | `100` | Per-source fetch limit |
| `SCAN_INTERVAL_MINUTES` | — | `30` | Scan frequency |
| `DEXSCREENER_MAX_TOKENS` | — | `100` | Fallback if MAX_TOKENS_PER_SOURCE not set |
| `MIN_LIQUIDITY_USD` | — | `50000` | Hard + soft filter |
| `MIN_VOLUME_24H_USD` | — | `25000` | Hard + soft filter |
| `MIN_TOKEN_AGE_MINUTES` | — | `60` | Soft flag threshold |
| `MAX_TOP10_HOLDER_PCT` | — | `65` | Soft flag threshold |
| `MAX_RISK_SCORE` | — | `45` | Max risk to trigger ALERT |
| `STRONG_BUY_SCORE` | — | `75` | Min final score for ALERT |
| `MIN_OPPORTUNITY_SCORE` | — | `55` | Min score for WATCH |
| `MAX_ALERTS_PER_HOUR` | — | `10` | Telegram rate limit |
| `ENABLE_TELEGRAM` | — | `true` | Toggle Telegram alerts |
| `PORT` | — | `3001` | Dashboard port |
| `LOG_LEVEL` | — | `info` | pino log level |
| `DATABASE_PATH` | — | `./data/screener.db` | SQLite file |

---

## Telegram commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + command list |
| `/status` | System health + last scan stats |
| `/top` | Top 5 ALERT tokens from last scan |
| `/sources` | Data source health (count, latency, last ok) ← 4.0 |
| `/check <addr>` | Deep-scan a specific token live |
| `/scan` | Force immediate scan |
| `/setjupiter <key>` | Set Jupiter API key at runtime |
| `/buy <addr> <sol> [sl%] [tp%]` | Open paper position |
| `/sell <id> [fraction]` | Close paper position (default: full) |
| `/positions` | List open paper positions |
| `/pnl` | Rich paper trading summary ← 4.0 |
| `/pause` | Pause Telegram alerts |
| `/resume` | Resume Telegram alerts |
| `/alerts` | Last 10 alerts |
| `/approve <id>` | Mark alert approved |
| `/reject <id>` | Mark alert rejected |
| `/help` | Full command list |

---

## Paper trading

Positions and PnL live in SQLite — no real funds, no wallet.

**Dashboard** (Positions tab is default on load):
- Portfolio header: realized P&L, SOL at risk, live unrealized P&L, win rate, avg hold
- Open position cards: entry, size, SL/TP, hold time, live P&L (polls every 30s)
- Quick Buy bar: paste any address, set SOL + SL%/TP%, one-click open
- Trade journal: full history with hold time, reason badge, P&L

**Automatic SL/TP:** checked every scan cycle. Auto-closes when thresholds hit.

---

## $ANSEM pattern — baked into scoring

In late June 2026, `$ANSEM` ran 500–800%+ on thin pools ($24K–$185K liq).
Key signals that MemeScreener now detects:

- **Turnover velocity** (`volume24h / liquidity`): +0–12 bonus if pool turns over 10–100× its depth per day
- **Narrative cluster**: multiple related tickers in same scan window → +0–6 bonus
- **Holder concentration check deliberately NOT loosened**: whale dominance reverses pumps as fast as it builds them

---

## VPS deployment

```bash
npm run build
npm install -g pm2
pm2 start dist/src/index.js --name memescreener
pm2 save && pm2 startup
```

---

## Roadmap

| Version | Feature | Status |
|---------|---------|--------|
| v3.0 | Scan + score + alert + dashboard | ✅ |
| v3.1 | Tier system, paper trading, Jupiter, turnover scoring | ✅ |
| v4.0 | Multi-source (BirdEye + Pump.fun), 3 new signals, paper trading first-class | ✅ |
| v4.1 | Manual watchlist add via dashboard | ⏳ |
| v4.1 | Telegram inline buy from alert message | ⏳ |
| v4.2 | Sparkline price charts in dashboard | ⏳ |
| v4.2 | Kanban queue (SPOTTED → WATCHING → READY → IN → CLOSED) | ⏳ |


**Designed to run locally on your laptop first.** No VPS required — paper
trading, dashboard, and Telegram bot all run from `npm run dev` on
`localhost:3001`.

---

## $ANSEM Case Study — Reference Pattern Baked Into Scoring

In late June 2026, `$ANSEM` (Ansem's Army, Solana/PumpSwap) ran 500-800%+
on liquidity pools as thin as $24K–$185K. The pattern, confirmed via
DexScreener data and independent analysis:

1. **Narrative catalyst, not fundamentals** — tied to Solana KOL "Ansem"
   and Pump.fun creator-fee airdrop speculation, not utility
2. **Extreme turnover vs liquidity** — $2-2.5M daily volume against a
   sub-$200K pool (10-100x liquidity turnover in 24h)
3. **Extreme txn density** — 48K-50K transactions on a thin pool
4. **Copycat swarm within hours** — ANSEMSTR, ANSEMWORK, ANSEM ARMY,
   BABYANSEM, TROLLSEM, ANSOM all appeared once the narrative caught
5. **Holder concentration was the structural risk** — analysts flagged
   whale dominance as exactly what could reverse the move as violently
   as it pumped

**What changed in the engine because of this** (`src/domain/opportunity.ts`):

- **Turnover velocity bonus** (new) — explicitly scores `volume24h / liquidity`.
  Previously the engine only had vol-vs-24h-avg and liq-vs-fdv ratios, neither
  of which captures "is this pool moving many multiples of its own depth
  per day." Adds up to +12 to momentum score.
- **Narrative cluster bonus** (new) — detects symbol-name clustering
  (e.g. multiple ANSEM-rooted tickers in the same scan window) as a
  confirming signal that attention is concentrating on a theme. Adds up
  to +6, logged as evidence, never loosens any risk check.
- **Holder concentration check was deliberately NOT loosened.** The case
  study argues for keeping `risk.ts`'s top-10-holder check strict — a hot
  narrative does not make whale concentration safer, it's the same
  mechanic that can reverse a pump just as fast as it built.

These are additive bonuses on top of the existing 6-component weighted
score, not a reweight — so the original momentum math (volume velocity,
price momentum, holder spread, liquidity depth, TX activity, age window)
is unchanged and still does the bulk of the work.

---

## What's New in v3.1

| Feature | Source | Status |
|---------|--------|--------|
| Tier system (S/A/B/C/REJECT) | VectorControl | ✅ Shipped |
| Paper trading (buy/sell/SL/TP/PnL) | VectorControl | ✅ Shipped |
| Jupiter routability check | VectorControl | ✅ Shipped (optional, runtime-configurable) |
| Turnover velocity scoring | $ANSEM case study | ✅ Shipped |
| Narrative cluster detection | $ANSEM case study | ✅ Shipped |
| Tier-change alerting | VectorControl | ✅ Shipped |
| Dashboard positions tab + PnL bar | New for v3.1 | ✅ Shipped |
| Telegram `/buy /sell /positions /pnl` | New for v3.1 | ✅ Shipped |
| Manual watchlist add | VectorControl | ⏳ v3.2 |
| Kanban queue (SPOTTED→WATCHING→READY→IN→CLOSED) | VectorControl | ⏳ v3.2 |

## 3-Way Comparison

| Feature | VectorControl | memscreen-2.0 | Achilles | **v3.1 (final)** |
|---------|:---:|:---:|:---:|:---:|
| **Architecture** | Single HTML file (browser) | Node.js backend | Node.js backend | **Node.js + TypeScript** |
| **Language** | JavaScript | TypeScript | JavaScript | **TypeScript (strict)** |
| **No install needed** | ✅ | ❌ | ❌ | ❌ |
| **Runs offline** | ✅ | ❌ | ❌ | ❌ |
| **Zod env validation** | ❌ | ✅ | ❌ | ✅ |
| **Fastify server** | ❌ | ✅ | ❌ | ✅ |
| **Rate limiting** | ❌ | ✅ | ❌ | ✅ |
| **Structured logging (pino)** | ❌ | ✅ | ❌ | ✅ |
| **Telegraf two-way bot** | ❌ | ✅ | ❌ | ✅ |
| **/check /pause /approve /reject** | ❌ | ✅ | ❌ | ✅ |
| **Alert rate limit (max/hour)** | ❌ | ✅ | ❌ | ✅ |
| **Paper trading (P&L tracking)** | ✅ | ❌ | ❌ | ✅ |
| **Tier system (S/A/B/C/REJECT)** | ❌ | ❌ | ❌ | ✅ |
| **Manual watchlist add** | ✅ | ❌ | ❌ | ⏳ v3.2 |
| **Jupiter tradability check** | ✅ | ❌ | ❌ | ✅ |
| **Social score (Twitter/TG links)** | ✅ | ❌ | ❌ | ❌ |
| **S/A/B/C/REJECT tier badges** | ✅ | ❌ | ❌ | ❌ |
| **Risk score (4-factor)** | ✅ | ✅ | ❌ | ✅ **(8-factor)** |
| **Momentum score** | ✅ | ✅ | ✅ | ✅ **(6-component)** |
| **FDV/liquidity ratio** | ✅ | ✅ | ❌ | ✅ |
| **5m extreme volatility check** | ❌ | ✅ | ❌ | ✅ |
| **Honeypot RPC simulate sell** | ❌ | ❌ | ✅ | ✅ |
| **Mint authority revoke check** | ❌ | ❌ | ✅ | ✅ |
| **Top-10 holder concentration** | ❌ | ✅ | ✅ | ✅ |
| **Token age hard block** | ✅ (10m) | ✅ | ✅ | ✅ **(3m hard / 60m soft)** |
| **Volume velocity (1h vs 24h)** | ❌ | ❌ | ✅ | ✅ |
| **TX activity + buy/sell ratio** | ✅ | ❌ | ✅ | ✅ |
| **Tokens scanned per run** | 18 (watchlist) | default 10 | 100 | **100** |
| **Scan frequency** | 30s (auto-refresh) | configurable | 30min | **30min** |
| **WebSocket realtime dashboard** | ❌ (polling) | ❌ | ✅ | ✅ |
| **SQLite persistence** | ❌ (localStorage) | ✅ | ✅ | ✅ **(WAL mode)** |
| **Graceful shutdown** | ❌ | ✅ | ❌ | ✅ |
| **VPS-ready** | ❌ | ✅ | ✅ | ✅ |

---

### What v3.0 took from each

**From VectorControl:**
- FDV/liquidity ratio in risk scoring (already done, confirmed correct threshold: >100x = high risk)
- TX acceleration vs 6h baseline concept (adapted to 5m vs 1h in v3.0)
- Buy/sell ratio in momentum scoring
- Social/website presence as soft risk flag
- Age hard block concept (v3.0 uses 3m hard, 60m soft)

**From memscreen-2.0:**
- TypeScript + Zod env validation
- Fastify + rate limit plugin
- Telegraf two-way bot (/check, /pause, /approve, /reject)
- Structured pino logging
- 5m extreme volatility hard block (>80% = skip)
- Alert rate limiting per hour
- Graceful shutdown handler

**From Achilles:**
- 100 token scan per cycle
- Honeypot detection via QuickNode RPC simulate
- Mint authority revoke check via RPC
- Volume velocity (1h vs 24h hourly avg)
- WebSocket realtime push to dashboard
- SQLite WAL persistence

---

## Stack

| Layer | Tech |
|-------|------|
| Language | TypeScript (strict) |
| Server | Fastify + WebSocket |
| Bot | Telegraf (two-way Telegram) |
| DB | better-sqlite3 (WAL mode) |
| Validation | Zod env schema |
| Logging | pino-pretty |
| Scheduler | node-cron |

---

## Setup

### 1. QuickNode (RPC)
- [quicknode.com](https://quicknode.com) → free account
- Create endpoint → **Solana Mainnet**
- Copy HTTPS URL → paste into `.env`

### 2. Telegram Bot
- Chat **@BotFather** → `/newbot` → copy token
- Chat **@userinfobot** → `/start` → copy your numeric ID

### 3. Install & run

```bash
chmod +x setup.sh && ./setup.sh

# Edit config (fill 3 values)
nano .env

# Validate
npm run check:env

# Test Telegram connection
npm run test:tg

# Start
npm run dev

# Dashboard
open http://localhost:3001
```

---

## Architecture

```
src/
├── config/env.ts              Zod-validated env (fails fast on bad config)
├── domain/
│   ├── types.ts               All interfaces (TokenCandidate, RiskResult, etc.)
│   ├── risk.ts                Anti-scam engine (8 checks, 2 hard-block tiers)
│   └── opportunity.ts         Momentum scoring (6 weighted components)
├── sources/
│   └── dexScreenerSource.ts   DexScreener API fetch (rate-limited 30 req/min)
├── db/
│   └── repository.ts          SQLite WAL (tokens, alerts, scans, source_status)
├── services/
│   ├── screenerService.ts     Main scan loop + setOnAlert callback
│   ├── telegramService.ts     Telegraf bot (10 commands + inline approve/reject)
│   └── alertService.ts        Alert bridge (save → telegram → mark sent)
├── server/
│   └── api.ts                 Fastify REST + WebSocket + static dashboard
└── index.ts                   Entrypoint, DI wiring, cron
```

---

## Scan Flow

```
Every 30 minutes:

1. DexScreener → top 100 Solana pairs by 1h volume

2. Per token — computeRisk() — 8 checks:

   HARD BLOCK (any = skip token entirely):
   ├── Age < 3 minutes
   ├── Liquidity < $25K (half of MIN_LIQUIDITY)
   ├── Volume24h < $8K (third of MIN_VOLUME)
   ├── 5m price change > ±80% (pump already blown)
   ├── Top-10 holders > 85% (extreme rug risk)
   └── Honeypot: transfer fee > 10% via QuickNode RPC

   SOFT FLAGS (add risk score, don't block):
   ├── Age < MIN_TOKEN_AGE_MINUTES (default 60m)    +12
   ├── Liquidity < MIN_LIQUIDITY_USD                +20
   ├── Volume < MIN_VOLUME_24H_USD                  +15
   ├── Volatility 5m > 40%                          +14
   ├── FDV/liquidity > 150x                         +10
   ├── FDV/liquidity > 300x                         +16
   ├── Top-10 > MAX_TOP10_HOLDER_PCT (65%)          +18
   ├── Honeypot: fee 5–10%                          +25
   └── Mint authority active                        +8

3. Per token — computeOpportunity() — 6 components:
   ├── Volume Velocity  30%  (1h vol / 24h hourly avg, log scale)
   ├── Price Momentum   25%  (1h change sweet spot 5-80%, reduced if >80%)
   ├── Holder Spread    20%  (inverse of top10 concentration)
   ├── Liquidity Depth  15%  (liq/fdv ratio)
   ├── TX Activity      10%  (5m spike vs 1h baseline + buy/sell ratio bonus)
   └── Age Window bonus      (optimal window: 10min–12h)

4. Final score:
   finalScore = (opportunityScore × 0.90 + (100 - riskScore) × 0.10) - (riskScore × 0.40)
   Range: 0–100

5. Decision:
   ALERT: finalScore ≥ STRONG_BUY_SCORE (75) AND riskScore ≤ MAX_RISK_SCORE (45)
   WATCH: finalScore ≥ MIN_OPPORTUNITY_SCORE (55) AND riskScore ≤ 55
   AVOID: hardAvoid = true OR neither threshold met

6. ALERT tokens → AlertService → DB save → Telegram → markTelegramSent
```

---

## Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome + command list |
| `/status` | System health, last scan stats, alert count |
| `/top` | Top 5 ALERT tokens from last scan |
| `/check <address>` | Deep-scan any token live |
| `/scan` | Trigger immediate scan |
| `/setjupiter <key>` | Set Jupiter API key for routability checks |
| `/buy <addr> <sol> [sl%] [tp%]` | Open paper position |
| `/sell <id> [fraction]` | Close paper position (default: full) |
| `/positions` | List open paper positions |
| `/pnl` | Paper trading PnL summary |
| `/pause` | Pause all Telegram alerts |
| `/resume` | Resume alerts |
| `/alerts` | Last 10 alerts with IDs |
| `/approve <id>` | Mark alert as approved |
| `/reject <id>` | Mark alert as rejected |

Inline buttons on each alert: **✅ Approve** / **❌ Reject** / **📊 DexScreener**

---

## Paper Trading — Local Workflow

Paper trading is fully local: positions and PnL live in your SQLite DB
(`./data/screener.db`), no real funds or wallet ever touch the system.

**From the dashboard** (recommended for visual review):
1. Open `http://localhost:3001`, click any token row to expand detail
2. Fill in SOL amount, optional SL%/TP%, click **Open Paper Position**
3. Go to the **💼 Positions** tab to see open/closed positions and live PnL
4. Click **Sell 50%** or **Sell 100%** on any open position

**From Telegram** (recommended for on-the-go monitoring):
```
/buy 8a5bn...pump 0.5 20 50
```
Opens a 0.5 SOL paper position with -20% stop-loss and +50% take-profit.

```
/positions
/pnl
/sell <position_id> 1
```

**Automatic SL/TP execution:** every scan cycle (default 30 min) checks
all open positions against current prices and auto-closes any that hit
their stop-loss or take-profit threshold. You'll get a dashboard toast
and the position moves to "closed" with the trigger reason recorded
(`stop-loss`, `take-profit`, or `manual`).

**Note on price source:** position open/close prices come from the same
DexScreener feed the screener uses — there's a 30-minute scan cadence
between automatic SL/TP checks, so on fast-moving tokens your actual
fill price would differ from a real-time exchange. This is intentional
for the local-first / paper-trading-only design; tightening the check
interval is a config change (`SCAN_INTERVAL_MINUTES`) if you want finer
granularity, at the cost of more DexScreener/RPC calls.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `QUICKNODE_RPC_URL` | ✅ | — | Solana RPC (honeypot + mint checks) |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Your numeric Telegram ID |
| `PORT` | | 3001 | Dashboard port |
| `SCAN_INTERVAL_MINUTES` | | 30 | Scan frequency |
| `DEXSCREENER_MAX_TOKENS` | | 100 | Tokens per scan |
| `MIN_LIQUIDITY_USD` | | 50000 | Soft block threshold |
| `MIN_VOLUME_24H_USD` | | 25000 | Soft block threshold |
| `MIN_TOKEN_AGE_MINUTES` | | 60 | Soft block threshold |
| `MAX_TOP10_HOLDER_PCT` | | 65 | Soft flag threshold |
| `MAX_RISK_SCORE` | | 45 | Max risk to trigger ALERT |
| `STRONG_BUY_SCORE` | | 75 | Min final score for ALERT |
| `MIN_OPPORTUNITY_SCORE` | | 55 | Min score for WATCH |
| `MAX_ALERTS_PER_HOUR` | | 10 | Telegram rate limit |
| `ENABLE_TELEGRAM` | | true | Toggle Telegram alerts |
| `LOG_LEVEL` | | info | pino log level |
| `DATABASE_PATH` | | ./data/screener.db | SQLite file path |

---

## VPS Deployment (after local testing)

```bash
npm run build
npm install -g pm2
pm2 start dist/src/index.js --name memescreener
pm2 save && pm2 startup
```

---

## Roadmap

| Version | Feature | Status |
|---------|---------|--------|
| v3.0 | Scan + score + alert + dashboard | ✅ Shipped |
| v3.1 | Tier system (S/A/B/C/REJECT) | ✅ Shipped |
| v3.1 | Paper trading with SL/TP + PnL tracking | ✅ Shipped |
| v3.1 | Jupiter routability check (optional, runtime key) | ✅ Shipped |
| v3.1 | Turnover velocity + narrative cluster scoring ($ANSEM case study) | ✅ Shipped |
| v3.1 | Tier-change alerting | ✅ Shipped |
| v3.1 | Dashboard positions tab, PnL bar, paper buy/sell UI | ✅ Shipped |
| v3.2 | Manual watchlist add via dashboard | ⏳ Planned |
| v3.2 | Kanban queue (SPOTTED → WATCHING → READY → IN → CLOSED) | ⏳ Planned |
| v4.0 | VPS deployment + PM2 config (after local validation) | ⏳ Planned |


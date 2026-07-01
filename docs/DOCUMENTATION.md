# MemeScreener 4.0 — Documentation

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration](#configuration)
3. [Architecture](#architecture)
4. [Data Sources](#data-sources)
5. [Scoring Engine](#scoring-engine)
6. [Anti-Scam Engine](#anti-scam-engine)
7. [Paper Trading](#paper-trading)
8. [Dashboard](#dashboard)
9. [Telegram Bot](#telegram-bot)
10. [Deployment](#deployment)
11. [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
git clone <repo>
cd memescreener-4.0
cp .env.example .env
# Edit .env with your credentials
npm install
npm run dev
```

Open **http://localhost:3002**

---

## Configuration

All config is validated at startup via Zod. Missing required values exit with a clear error.

### Required

| Variable | Description |
|----------|-------------|
| `QUICKNODE_RPC_URL` | Solana mainnet RPC — get free at quicknode.com |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your numeric Telegram ID from @userinfobot |

### Optional — Data Sources

| Variable | Default | Description |
|----------|---------|-------------|
| `BIRDEYE_API_KEY` | `""` | BirdEye free tier — source skipped if blank |
| `PUMPFUN_ENABLED` | `true` | Toggle pump.fun source on/off |
| `MULTI_SOURCE_BONUS` | `true` | Enable cross-source confirmation bonus |
| `MAX_TOKENS_PER_SOURCE` | `100` | Per-source fetch limit (total = up to 3×) |

### Optional — Scan

| Variable | Default | Description |
|----------|---------|-------------|
| `SCAN_INTERVAL_MINUTES` | `30` | How often to scan |
| `DEXSCREENER_MAX_TOKENS` | `100` | Fallback token limit |

### Optional — Filters

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_LIQUIDITY_USD` | `50000` | Hard floor — tokens below this are skipped |
| `MIN_VOLUME_24H_USD` | `25000` | Hard floor |
| `MIN_TOKEN_AGE_MINUTES` | `60` | Soft flag threshold |
| `MAX_TOP10_HOLDER_PCT` | `65` | Soft flag threshold |

### Optional — Scoring

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RISK_SCORE` | `45` | Max risk score allowed for ALERT |
| `STRONG_BUY_SCORE` | `75` | Min final score for ALERT |
| `MIN_OPPORTUNITY_SCORE` | `55` | Min score for WATCH |
| `MAX_ALERTS_PER_HOUR` | `10` | Telegram rate limit |

---

## Architecture

```
src/
├── config/
│   └── env.ts                 Zod-validated environment
├── domain/
│   ├── types.ts               All shared interfaces
│   ├── risk.ts                Anti-scam engine (8 checks)
│   ├── opportunity.ts         Momentum scoring (9 signals)
│   └── tier.ts                S/A/B/C/REJECT classification
├── sources/
│   ├── dexScreenerSource.ts   DexScreener (primary, rate-limited)
│   ├── birdeyeSource.ts       BirdEye free tier (breakouts)
│   ├── pumpfunSource.ts       Pump.fun feed via DexScreener
│   └── jupiterSource.ts       Optional routability check
├── db/
│   ├── repository.ts          SQLite (tokens, alerts, scans, source_status)
│   └── positionsRepository.ts Paper trading positions & PnL
├── services/
│   ├── screenerService.ts     Multi-source fetch, dedup, scan loop
│   ├── alertService.ts        Alert → DB → Telegram bridge
│   └── telegramService.ts     Telegraf bot (15 commands)
├── server/
│   └── api.ts                 Fastify REST + WebSocket + static files
└── index.ts                   Entrypoint, DI wiring, cron
```

### Scan cycle

```
Every SCAN_INTERVAL_MINUTES:

1. fetchAllCandidates()
   ├── DexScreenerSource.fetchCandidates(N)
   ├── BirdEyeSource.fetchCandidates(N)      [if BIRDEYE_API_KEY set]
   └── PumpFunSource.fetchCandidates(N)      [if PUMPFUN_ENABLED=true]
   → Promise.allSettled (concurrent, non-blocking)
   → Dedup by address (highest liquidity wins)
   → sources[] array populated on each token

2. Per token:
   computeRisk(token)           → RiskResult
   checkJupiterRoutable(addr)   → boolean | null
   computeOpportunity(token)    → OpportunityResult
   classifyTier(scores)         → S/A/B/C/REJECT

3. finalScore = (opp × 0.90 + (100 - risk) × 0.10) - (risk × 0.40)

4. Decision:
   ALERT  → finalScore ≥ STRONG_BUY_SCORE AND risk ≤ MAX_RISK_SCORE
   WATCH  → finalScore ≥ MIN_OPPORTUNITY_SCORE AND risk ≤ 55
   AVOID  → hardAvoid OR neither threshold met

5. ALERT  → AlertService → DB → Telegram → markSent
   ALL    → Repository.upsertToken → SQLite
   ALL    → WebSocket broadcast → Dashboard
   OPEN   → PositionsRepository.checkTriggers() [SL/TP]
```

---

## Data Sources

### DexScreener (primary)

- **Endpoint:** `GET /latest/dex/search?q=SOL`
- **Rate limit:** 30 req/min → enforced with 2.1s delay between calls
- **Filter:** Solana chain only, `liquidity.usd > 10000`
- **Sort:** 1h volume descending
- **Key signals:** price, volume 1h/24h, liquidity, age, tx counts

### BirdEye (optional, requires API key)

- **Endpoint:** `GET /defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc`
- **Why:** Sorted by 24h volume *change* percent — surfaces tokens whose volume is accelerating, not just already-high. Earlier signal than DexScreener trending.
- **Get key:** birdeye.so → free tier → API Key
- **Set:** `BIRDEYE_API_KEY=your_key` in `.env`

### Pump.fun (free, no key)

- **Endpoint:** DexScreener search filtered to `dexId === "pump"`
- **Why:** Dedicated feed for pump.fun-originated tokens. Typically <2h old, sub-$100K liquidity. Very high risk — the anti-scam engine filters most out.
- **Toggle:** `PUMPFUN_ENABLED=true/false`

### Multi-source dedup

When the same token appears in multiple sources:
- The record with the **highest liquidity** becomes the canonical entry
- The **`sources` array** lists all sources that found it (e.g. `["dexscreener", "birdeye"]`)
- A **cross-source bonus** is added to the opportunity score

---

## Scoring Engine

### Final score formula

```
finalScore = (opportunityScore × 0.90 + (100 − riskScore) × 0.10) − (riskScore × 0.40)
```

Clamped to 0–100.

### Opportunity score (9 signals)

#### Base components (weighted, sum to 100%)

| Component | Weight | Signal |
|-----------|--------|--------|
| Volume Velocity | 30% | 1h vol / 24h hourly avg — detects acceleration |
| Price Momentum | 25% | 1h price change (sweet spot 5–80%) |
| Holder Distribution | 20% | Inverse of top-10 concentration |
| Liquidity Depth | 15% | liq/fdv ratio |
| TX Activity | 10% | 5m tx spike vs 1h baseline |

#### 4.0 Bonus signals (additive)

| Signal | Max Bonus | Logic |
|--------|-----------|-------|
| **Buy/Sell Pressure** | +10 pts | `buys1h / (buys1h + sells1h)` > 70% = full bonus; > 85% = suspicious (capped at +4) |
| **Liquidity Growth** | +6 pts | Liq grew ≥75% vs prev scan = +6, ≥50% = +4, ≥25% = +2 |
| **Cross-Source Confirm** | +12 pts | 2 sources = +8, all 3 sources = +12 |

#### Legacy bonuses (from 3.1, preserved)

| Signal | Max Bonus | Logic |
|--------|-----------|-------|
| Turnover Velocity | +12 pts | `volume24h / liquidity` — $ANSEM pattern |
| Narrative Cluster | +6 pts | Multiple related tickers in same scan window |

#### Age window (15% of final)

| Age | Score |
|-----|-------|
| 10min – 12h | 100 (optimal) |
| 12h – 48h | 60 |
| > 48h | 20 |

### Tier classification

| Tier | Criteria |
|------|----------|
| **S** | finalScore ≥ 85, risk ≤ 20, Jupiter routable |
| **A** | finalScore ≥ 70, risk ≤ 35 |
| **B** | finalScore ≥ 55, risk ≤ 45 |
| **C** | finalScore ≥ 40 |
| **REJECT** | hardAvoid = true, or score too low |

---

## Anti-Scam Engine

8 checks run on every token. Any **hard block** skips the token entirely.

### Hard blocks

| Check | Threshold | Reason |
|-------|-----------|--------|
| Age | < 3 minutes | Too new to have any signal |
| Liquidity | < $25K | Trivially manipulable |
| Volume | < $8K / 24h | No real activity |
| Volatility | 5m change > ±80% | Likely pump or dump in progress |
| Honeypot | Transfer fee > 10% via RPC | Non-tradeable |
| Top-10 holders | > 85% | Extreme whale concentration |

### Soft flags (add to risk score)

| Flag | Risk Added |
|------|-----------|
| Age < MIN_TOKEN_AGE_MINUTES | +12 |
| Liquidity < MIN_LIQUIDITY_USD | +20 |
| Volume < MIN_VOLUME_24H_USD | +15 |
| 5m volatility > 40% | +14 |
| FDV / liquidity > 150x | +10 |
| FDV / liquidity > 300x | +16 |
| Top-10 > MAX_TOP10_HOLDER_PCT | +18 |
| Honeypot fee 5–10% | +25 |
| Mint authority active | +8 |

Risk score is capped at 100.

---

## Paper Trading

Paper trading tracks simulated positions in SQLite — no real funds, no wallet required.

### Opening a position

**Via Telegram:**
```
/buy <token_address> <sol_amount> [sl_percent] [tp_percent]
# Example:
/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.5 20 50
```

**Via Dashboard Quick Buy bar:**
1. Paste token address (or click a token row to auto-fill)
2. Set SOL amount, SL%, TP%
3. Click ⚡ Buy

### Live P&L

Open position cards poll `GET /api/positions/:id/pnl` every 30 seconds. This fetches the current price from DexScreener and calculates:

```
pnlPct = (currentPrice - entryPrice) / entryPrice × 100
pnlSol = amountSol × (pnlPct / 100)
```

### SL/TP auto-trigger

Checked every scan cycle. If `pnlPct ≤ -slPct` → auto-close as `stop-loss`. If `pnlPct ≥ tpPct` → auto-close as `take-profit`.

### Closing a position

**Via Telegram:**
```
/sell <position_id>           # full close
/sell <position_id> 0.5       # close 50%
```

**Via Dashboard:** 25% / 50% / 100% buttons on each position card.

### Stats

```
/pnl  →  Realized P&L | Win rate | SOL at risk | Avg hold | Best/worst trade
```

---

## Dashboard

Live at **http://localhost:3002**

### Portfolio header (always visible)

| Stat | Description |
|------|-------------|
| Realized P&L | Closed trade profits/losses in SOL |
| SOL at Risk | Total SOL across open positions |
| Unrealized P&L | Live estimate from price polling |
| Total Trades | Closed position count + best trade % |
| Avg Hold | Average position hold time |
| Alerts/hr | Alert rate from last scan |

### Tabs

| Tab | Content |
|-----|---------|
| 💼 **Positions** (default) | Open cards + quick buy + trade journal |
| 🚀 **Alerts** | Tokens with decision=ALERT, sorted by score |
| 👀 **Watch** | Tokens with decision=WATCH |
| 📋 **All** | All scanned tokens |

### Source badges

Each token row shows source icons:
- 📈 DexScreener
- 🦅 BirdEye
- 🎰 Pump.fun
- ⭐ Multi-source confirmed (2+ sources)

### Token detail panel

Click any row to open the detail panel:
- Anti-scam check results (8 checks with pass/fail)
- Momentum component breakdown (9 signals with scores)
- Paper trade form (SOL amount, SL%, TP%)
- Copy address button
- DexScreener link

### WebSocket events

The dashboard maintains a persistent WebSocket connection to `ws://localhost:3002/ws`.

| Event | Trigger |
|-------|---------|
| `INITIAL_STATE` | On connect — sends all tokens, positions, last scan |
| `SCAN_COMPLETE` | After each scan cycle |
| `NEW_ALERT` | When a new ALERT token is found |
| `POSITION_OPENED` | After paper buy |
| `POSITION_CLOSED` | After paper sell or SL/TP trigger |
| `TIER_CHANGE` | When a token's tier changes between scans |

---

## Telegram Bot

Bot: **@Memebot4bot**

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + command list |
| `/status` | Scan stats, uptime, last scan time |
| `/top` | Top 5 ALERT tokens from last scan |
| `/sources` | Data source health: count, latency, last success |
| `/check <address>` | Deep-scan any token live |
| `/scan` | Force immediate scan |
| `/setjupiter <key>` | Set Jupiter API key at runtime |
| `/buy <addr> <sol> [sl%] [tp%]` | Open paper position |
| `/sell <id> [fraction]` | Close position (default: 100%) |
| `/positions` | List all open positions |
| `/pnl` | Rich PnL summary |
| `/pause` | Pause Telegram alerts |
| `/resume` | Resume Telegram alerts |
| `/alerts` | Last 10 alerts |
| `/approve <id>` | Mark alert approved |
| `/reject <id>` | Mark alert rejected |
| `/help` | Full command reference |

### Alert message format

```
🚀🟢 STRONG BUY: $SYMBOL  🟩 Tier A
Token Name

📊 Score: 82/100  (confidence 78%)
████████████████░░░░
Risk: 23/100 | Opp: 71/100
Jupiter: ✅ routable
🌐 Sources: 📈 dexscreener + 🦅 birdeye ⭐ multi-source

💰 Price: $0.00001234
📈 Vol 1h: $245,000 (+34.2%)
💧 Liquidity: $128,000
🏪 FDV: $1,200,000
🏦 DEX: RAYDIUM
⏰ Age: 2h 14m

Momentum:
• Vol Velocity:   95/100
• Price Momentum: 78/100
...

Anti-Scam (8 checks):
✅ Age: 134m
✅ Liquidity: $128K
...

🔗 EPjFWdd...
```

---

## Deployment

### Local (development)

```bash
npm run dev        # tsx watch — auto-restarts on file changes
```

### Production build

```bash
npm run build      # tsc → dist/
npm start          # node dist/src/index.js
```

### VPS with PM2 (recommended for 24/7)

```bash
# On your VPS (Ubuntu 22.04)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
npm install -g pm2

git clone <your-repo> memescreener-4.0
cd memescreener-4.0
cp .env.example .env
nano .env   # fill in credentials

npm install
npm run build
pm2 start dist/src/index.js --name memescreener
pm2 save
pm2 startup   # auto-start on reboot
```

### Nginx reverse proxy (HTTPS)

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # required for WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
# Let's Encrypt SSL
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Quick tunnel (temporary, no VPS)

```bash
winget install ngrok
ngrok config add-authtoken YOUR_TOKEN   # from ngrok.com
ngrok http 3002
# → https://abc123.ngrok.io
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
RUN npm rebuild better-sqlite3
COPY . .
RUN npm run build
EXPOSE 3002
CMD ["node", "dist/src/index.js"]
```

```bash
docker build -t memescreener .
docker run -d \
  --name memescreener \
  -p 3002:3002 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  memescreener
```

---

## Troubleshooting

### Server won't start — `better-sqlite3` binary error

Node v24 requires `better-sqlite3` v12.11.1+. This project already pins that version.

```bash
npm install better-sqlite3@12.11.1
```

If it still fails to build from source, you need VS Build Tools + Windows SDK on Windows, or `build-essential` on Linux.

### Telegram bot not responding

1. Verify `TELEGRAM_BOT_TOKEN` is correct
2. Make sure no other process is polling the same bot token
3. Send `/start` to the bot — if no response, the token is wrong

### Port conflict

If port 3002 is taken, change `PORT=3003` in `.env` and restart.

### First scan shows no results

DexScreener may return empty on the first call. Run `/scan` again. If still empty, check your RPC URL is valid — the honeypot check requires a working Solana RPC.

### BirdEye returns 401

Your `BIRDEYE_API_KEY` is invalid. Get a free key at birdeye.so. The source is gracefully skipped if the key is blank.

### High memory usage

`better-sqlite3` keeps the DB in WAL mode which is efficient. If memory grows over time, check for large `tokens` table — the scan loop upserts (not inserts) so the table stays bounded.

### `tsc --noEmit` type errors after pulling

Run `npm install` first — the type definitions may be out of date.

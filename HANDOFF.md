# MemeScreener 3.1 — Handoff

Date: 2026-06-29 (session continuation)
Status: Type-checked clean (`npx tsc --noEmit` → 0 errors). Not yet run end-to-end against live DexScreener/QuickNode/Telegram — that's the next step on your laptop.

---

## What you asked for, and what shipped

1. **$ANSEM reference pattern → scoring engine.** Researched the actual June 2026 $ANSEM pump (confirmed via DexScreener data + independent write-ups), extracted the mechanics, and wired two new signals into `src/domain/opportunity.ts`:
   - **Turnover velocity bonus** (up to +12 momentum points): scores `volume24h / liquidity`. ANSEM ran 10-100x liquidity turnover on a sub-$200K pool — the old scoring (vol-vs-24h-avg, liq-vs-fdv) never captured that specific mechanic.
   - **Narrative cluster bonus** (up to +6): detects symbol-name swarms (ANSEM → ANSEMSTR, ANSEMWORK, ANSEM ARMY, BABYANSEM all matched in testing) within a 6h rolling window, using substring-containment matching (not the brittle suffix-regex I tried first — see "Bug found and fixed" below).
   - **Deliberately did NOT loosen holder-concentration risk checks.** The case study's actual lesson is that whale concentration is what let the move reverse hard — keeping that check strict, not relaxing it because a narrative is hot, was a conscious choice.

2. **Local-first, paper trading only.** Confirmed throughout: no live wallet, no real funds, no VPS required. `npm run dev` on your laptop is the complete loop — scanner, dashboard, Telegram bot, paper trading, all running from one process against a local SQLite file.

---

## Bug found and fixed during this session (worth knowing about)

While testing the narrative-cluster feature against the real ANSEM swarm names, I caught a bug **before it shipped**: my first implementation used a suffix-stripping regex (`/(STRATEGY|ARMY|WORK|BABY|TROLL)/g`) that only matched the *specific example names already in my comment*, not the general pattern. `TROLLSEM` and `ANSEMSTR` both failed to cluster with `ANSEM` under that logic — the regex was pattern-matching my own documentation, not actual name similarity.

Replaced it with substring-containment matching (shared 4+ character fragment, either direction) and verified against all 6 real swarm names. 4 of 6 now correctly cluster (`ANSEMSTR`, `ANSEMWORK`, `ANSEM ARMY`, `BABYANSEM`). `TROLLSEM` still doesn't — and that's now an honestly-documented limitation in the code comment, not a silent gap: `TROLLSEM` only shares `SEM` (3 chars) with `ANSEM`, below the 4-char threshold chosen to avoid false-positive clustering on common short fragments. Catching it would need semantic similarity, which is out of scope for a per-token-per-scan-cycle lightweight pass.

Also found and fixed while auditing the same file: the pre-existing (from v3.0) holder-growth "compare to previous scan" logic was dead code — it fetched `prev` from a cache but never actually used the cached value in the calculation, just branched on whether it existed. Fixed to be an honest single-formula proxy (DexScreener's free API doesn't expose real holder counts, so this was always an approximation — now it's a correct one instead of a fake-comparison one).

Also fixed: two in-memory caches (`narrativeRoots`, `prevCache`) had no eviction — they'd grow by one entry per unique token symbol/address ever scanned, forever, which matters on a 24/7 local process. Both now evict stale entries (6h window for narrative buckets, 24h TTL for the scan cache).

---

## What you need to do on your laptop

```bash
# 1. Extract and install
unzip memescreener-3.1.zip
cd memescreener-3.1
npm install
# (better-sqlite3 needs native build tools — if it fails, see Known Issues below)

# 2. Configure
cp .env.example .env
nano .env
# Fill: QUICKNODE_RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# 3. Validate config
npm run check:env

# 4. Test Telegram connection
npm run test:tg

# 5. Start
npm run dev
```

Dashboard: `http://localhost:3001`
Telegram: message your bot `/start`

Jupiter API key (optional, for routability checks) is **not** an env var — set it after launch via Telegram: `/setjupiter <key>` (free key at portal.jup.ag). Leave unset and tier scoring still works, just without the Jupiter confirmation signal.

---

## Paper trading — the two ways to use it

**Dashboard** (`💼 Positions` tab): click a token → fill SOL amount + optional SL%/TP% → "Open Paper Position". Sell 50%/100% from the position card.

**Telegram**:
```
/buy <address> 0.5 20 50     # 0.5 SOL, -20% SL, +50% TP
/positions
/pnl
/sell <position_id> 1
```

SL/TP auto-execute every scan cycle (default 30min) against current DexScreener price. This means fill prices won't be real-time-exact — intentional tradeoff for the local/paper-only design. Tighten `SCAN_INTERVAL_MINUTES` in `.env` for finer granularity if you want it, at the cost of more API calls.

---

## Known issues / things I did NOT verify

- **`better-sqlite3` native build:** this requires `node-gyp` and build tools (`python3`, `make`, `g++` on Linux; Xcode CLI tools on Mac). I could not run the actual native build in this sandboxed environment (no internet access to npm registry for compiled binaries, no real build toolchain validation) — only `--ignore-scripts` installs, which skip the native compile step entirely. **This means: I have not confirmed `better-sqlite3` actually compiles successfully on your laptop.** If `npm install` fails on the native build step, options are: install build tools (`xcode-select --install` on Mac, `sudo apt install build-essential python3` on Linux), or tell me and I'll swap to a pure-JS SQLite alternative like the earlier `sql.js` fallback I used in an earlier iteration of this project.

- **Live data paths not exercised end-to-end.** Type-checking confirms the code is internally consistent (correct types, no dead imports, no signature mismatches), and the scoring logic is unit-tested with synthetic data. But I have not run an actual scan against live DexScreener + QuickNode + Telegram from this sandbox (no network egress to those domains here). First real run on your laptop is the actual integration test — if something breaks there, it'll most likely be in the QuickNode RPC honeypot-check calls or the DexScreener response shape, since those are the two external dependencies I could only validate against documented/cached response shapes, not live calls.

- **Jupiter routability check** (`src/sources/jupiterSource.ts`) is similarly untested against the live Jupiter API in this session — implemented against their documented price endpoint shape, not verified with a real key.

---

## Files changed this session

```
src/domain/opportunity.ts        — ANSEM turnover/narrative scoring, dead-code fix, cache eviction
src/domain/types.ts              — (from earlier in session — tier/position types)
src/domain/tier.ts               — (from earlier in session — S/A/B/C/REJECT classification)
src/sources/jupiterSource.ts     — (from earlier in session)
src/db/positionsRepository.ts    — (from earlier in session)
src/db/repository.ts             — tier/jupiter columns, position repo wiring
src/services/screenerService.ts  — tier classification, jupiter check, SL/TP triggers per scan
src/services/telegramService.ts  — /buy /sell /positions /pnl /setjupiter commands, tier badges in alerts
src/services/alertService.ts     — updated for ScreenedTokenV31 type
src/server/api.ts                — /api/positions/* REST endpoints
public/dashboard/index.html      — tier column, Jupiter column, Positions tab, PnL bar
public/dashboard/main.js         — tier rendering, position open/close UI, PnL polling
README.md                        — ANSEM case study section, v3.1 feature table, paper trading docs
```

---

## Quick verification you can run yourself

```bash
npx tsc --noEmit
# should print nothing and exit 0
```

If that's clean, the code is internally sound. Everything past that point depends on your actual QuickNode/Telegram/network setup, which I can't test from here.

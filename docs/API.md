# MemeScreener 4.0 — API Reference

Base URL: `http://localhost:3002`

---

## REST Endpoints

### System

#### GET /api/health
Server health check.

**Response:**
```json
{
  "status": "ok",
  "version": "4.0.0",
  "uptime": 3600,
  "lastScan": "2026-07-01T09:00:00.000Z"
}
```

---

### Tokens

#### GET /api/tokens
All scanned tokens from the last scan cycle.

**Response:**
```json
{
  "tokens": [
    {
      "address": "EPjFWdd5...",
      "symbol": "MEME",
      "name": "Meme Token",
      "source": "dexscreener",
      "sources": ["dexscreener", "birdeye"],
      "priceUsd": 0.00001234,
      "liquidityUsd": 128000,
      "volume1hUsd": 245000,
      "volume24hUsd": 1200000,
      "priceChange1h": 34.2,
      "priceChange5m": 4.1,
      "fdvUsd": 1200000,
      "ageMinutes": 134,
      "riskScore": 23,
      "opportunityScore": 71,
      "finalScore": 82,
      "decision": "alert",
      "tier": "A",
      "tierConfidence": 78,
      "jupiterRoutable": true,
      "evidence": ["strong_buy_pressure", "multi_source_confirm", "✓ Jupiter routable"],
      "components": {
        "volumeVelocity": 95,
        "priceMomentum": 78,
        "holderGrowth": 60,
        "liquidityDepth": 55,
        "txActivity": 70,
        "ageWindow": 100,
        "buySellPressure": 100,
        "liquidityGrowth": 4,
        "crossSourceBonus": 8
      },
      "flags": [],
      "hardAvoid": false
    }
  ]
}
```

#### GET /api/tokens/:address
Single token by address.

---

### Alerts

#### GET /api/alerts
Recent alerts (last 50).

**Response:**
```json
{
  "alerts": [
    {
      "id": 1,
      "token_address": "EPjFWdd5...",
      "symbol": "MEME",
      "final_score": 82,
      "risk_score": 23,
      "tier": "A",
      "price_usd": 0.00001234,
      "decision": "alert",
      "telegram_sent": 1,
      "user_action": null,
      "created_at": "2026-07-01T09:00:00.000Z"
    }
  ]
}
```

---

### Paper Trading

#### GET /api/positions
Full portfolio snapshot.

**Response:**
```json
{
  "open": [
    {
      "id": "uuid",
      "address": "EPjFWdd5...",
      "symbol": "MEME",
      "entry_price": 0.00001234,
      "amount_sol": 0.5,
      "sl_pct": 20,
      "tp_pct": 50,
      "notes": null,
      "opened_at": "2026-07-01T09:00:00.000Z",
      "status": "open"
    }
  ],
  "closed": [...],
  "stats": {
    "totalPnlSol": 0.042,
    "realizedPnlSol": 0.042,
    "winRate": 66.7,
    "totalTrades": 3,
    "bestTradePct": 48.2,
    "worstTradePct": -18.4,
    "avgHoldMinutes": 94,
    "solAtRisk": 0.5
  }
}
```

#### GET /api/positions/:id/pnl
Live unrealized P&L for one open position. Fetches current price from DexScreener.

**Response:**
```json
{
  "id": "uuid",
  "symbol": "MEME",
  "currentPrice": 0.00001850,
  "pnlPct": 49.9,
  "pnlSol": 0.2495,
  "holdMin": 94
}
```

#### POST /api/positions/buy
Open a new paper position.

**Request:**
```json
{
  "address": "EPjFWdd5...",
  "amountSol": 0.5,
  "slPct": 20,
  "tpPct": 50,
  "notes": "Strong buy signal, multi-source confirm"
}
```

**Response:** `201`
```json
{
  "position": {
    "id": "uuid",
    "address": "EPjFWdd5...",
    "symbol": "MEME",
    "entry_price": 0.00001234,
    "amount_sol": 0.5,
    "sl_pct": 20,
    "tp_pct": 50,
    "opened_at": "2026-07-01T09:00:00.000Z",
    "status": "open"
  }
}
```

#### POST /api/positions/:id/sell
Close a position (full or partial).

**Request:**
```json
{
  "fraction": 0.5
}
```

`fraction` is 0.01–1.0. Default: `1` (full close).

**Response:**
```json
{
  "closed": {
    "id": "uuid",
    "symbol": "MEME",
    "entry_price": 0.00001234,
    "exit_price": 0.00001850,
    "amount_sol": 0.25,
    "pnl_pct": 49.9,
    "pnl_sol": 0.1248,
    "reason": "manual",
    "closed_at": "2026-07-01T10:34:00.000Z"
  }
}
```

---

### Sources

#### GET /api/sources
Data source health statuses.

**Response:**
```json
{
  "sources": [
    {
      "name": "dexscreener",
      "last_ok": 1,
      "last_count": 97,
      "last_latency_ms": 1240,
      "last_error": null,
      "last_success_at": "2026-07-01T09:00:00.000Z",
      "last_failure_at": null
    },
    {
      "name": "pumpfun",
      "last_ok": 1,
      "last_count": 43,
      "last_latency_ms": 890,
      "last_error": null,
      "last_success_at": "2026-07-01T09:00:00.000Z",
      "last_failure_at": null
    }
  ]
}
```

---

### Scan

#### POST /api/scan
Trigger an immediate scan (same as `/scan` in Telegram).

**Response:**
```json
{
  "started": true,
  "runId": "uuid"
}
```

---

## WebSocket

Connect to: `ws://localhost:3002/ws`

The server sends JSON messages on connection and on events.

### Message format

```json
{
  "type": "EVENT_TYPE",
  "data": { ... },
  "ts": 1751360400000
}
```

### Events

#### INITIAL_STATE
Sent immediately on WebSocket connect.

```json
{
  "type": "INITIAL_STATE",
  "data": {
    "tokens": [...],
    "alerts": [...],
    "lastScan": { "totalCandidates": 198, "alertsCount": 3, ... },
    "alertsLastHour": 3,
    "nextScanMs": 1740000,
    "telegramEnabled": true,
    "paused": false
  }
}
```

#### SCAN_START
```json
{ "type": "SCAN_START", "data": { "runId": "uuid" } }
```

#### SCAN_FETCHED
```json
{ "type": "SCAN_FETCHED", "data": { "runId": "uuid", "count": 198 } }
```

#### SCAN_COMPLETE
```json
{
  "type": "SCAN_COMPLETE",
  "data": {
    "runId": "uuid",
    "totalCandidates": 198,
    "alertsCount": 3,
    "watchCount": 12,
    "avoidCount": 183,
    "durationMs": 4200,
    "sourceStatuses": [...]
  }
}
```

#### NEW_ALERT
```json
{
  "type": "NEW_ALERT",
  "data": { /* ScreenedTokenV40 wire format */ }
}
```

#### TIER_CHANGE
```json
{
  "type": "TIER_CHANGE",
  "data": {
    "address": "EPjFWdd5...",
    "symbol": "MEME",
    "from": "B",
    "to": "A"
  }
}
```

#### POSITION_OPENED
```json
{
  "type": "POSITION_OPENED",
  "data": { /* PositionRow */ }
}
```

#### POSITION_CLOSED
```json
{
  "type": "POSITION_CLOSED",
  "data": { /* ClosedPositionRow */ }
}
```

---

## Error responses

All errors follow:
```json
{
  "error": "Human-readable error message"
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad request — missing or invalid parameters |
| 404 | Token or position not found |
| 429 | Rate limit exceeded |
| 502 | External source (DexScreener/BirdEye) unreachable |

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "../config/env.js";
import type { Repository } from "../db/repository.js";
import type { ScreenerService } from "../services/screenerService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDashboardRoot(): string {
  const candidates = [
    path.join(__dirname, "../../public/dashboard"),
    path.join(process.cwd(), "public", "dashboard"),
    path.join(process.cwd(), "../public/dashboard"),
  ];
  for (const dir of candidates) {
    const test = path.resolve(dir);
    if (fs.existsSync(test)) return test;
  }
  // fallback that will log a clear error at boot
  return path.resolve(path.join(__dirname, "../../public/dashboard"));
}

export type BroadcastFn = (type: string, data: unknown) => void;

export async function buildServer(
  env: AppEnv,
  repo: Repository,
  screener: ScreenerService
) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocketPlugin);
  const dashboardRoot = resolveDashboardRoot();
  console.log(`[STATIC] Dashboard root: ${dashboardRoot}`);
  await app.register(staticFiles, {
    root: dashboardRoot,
    prefix: "/",
    index: ["index.html"],
  });

  // ── WebSocket clients ──────────────────────────────────────────────────
  const wsClients = new Set<import("ws").WebSocket>();

  const broadcast: BroadcastFn = (type, data) => {
    const payload = JSON.stringify({ type, data });
    for (const ws of wsClients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  screener.setBroadcast(broadcast);

  app.get("/ws", { websocket: true }, (socket) => {
    wsClients.add(socket);

    // Send initial state on connect
    const snap = repo.getDashboardSnapshot();
    socket.send(JSON.stringify({
      type: "INITIAL_STATE",
      data: {
        tokens:          snap.alertTokens,
        watchTokens:     snap.watchTokens,
        alerts:          snap.recentAlerts,
        lastScan:        snap.lastScan,
        alertsLastHour:  snap.alertsLastHour,
        scanning:        screener.scanning,
        ts:              new Date().toISOString(),
      },
    }));

    socket.on("close", () => wsClients.delete(socket));
    socket.on("error", () => wsClients.delete(socket));
  });

  // ── REST ──────────────────────────────────────────────────────────────

  app.get("/api/status", async () => ({
    status:          "online",
    scanning:        screener.scanning,
    lastScan:        screener.lastScan,
    lastScanDb:      repo.getLastScan(),
    alertsLastHour:  repo.countAlertsLastHour(),
    wsClients:       wsClients.size,
    uptime:          process.uptime(),
    version:         "4.0.0",
  }));

  app.get<{ Querystring: { limit?: string; decision?: string; tier?: string } }>(
    "/api/tokens",
    async (req) => {
      const limit  = Math.min(parseInt(req.query.limit ?? "100"), 200);
      const tokens = repo.listTokens(limit, {
        decision: req.query.decision,
        tier:     req.query.tier,
      });
      return { tokens, total: tokens.length };
    }
  );

  app.get<{ Params: { address: string } }>(
    "/api/token/:address",
    async (req, reply) => {
      const token = repo.getToken(req.params.address);
      if (!token) return reply.status(404).send({ error: "Token not found" });
      const alerts = repo.listAlerts(5).filter(a => a.token_address === req.params.address);
      return { token, alerts };
    }
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/alerts",
    async (req) => {
      const limit  = Math.min(parseInt(req.query.limit ?? "50"), 100);
      const alerts = repo.listAlerts(limit);
      return { alerts, total: alerts.length };
    }
  );

  app.post("/api/scan/trigger", async (_, reply) => {
    if (screener.scanning) return { status: "already_scanning" };
    screener.runScan().catch(e => console.error("[API] Scan error:", e));
    return reply.status(202).send({ status: "started" });
  });

  app.get("/api/dashboard", async () => repo.getDashboardSnapshot());

  app.patch<{ Params: { id: string }; Body: { action: string } }>(
    "/api/alert/:id/action",
    async (req, reply) => {
      const id     = parseInt(req.params.id);
      const action = req.body?.action;
      if (!action || isNaN(id)) return reply.status(400).send({ error: "id and action required" });
      repo.updateAlertAction(id, action);
      return { ok: true };
    }
  );

  // ── Paper trading ─────────────────────────────────────────────────────

  // GET /api/positions — full portfolio snapshot + wallet
  app.get("/api/positions", async () => ({
    open:   repo.positions.listOpenPositions(),
    closed: repo.positions.listClosedPositions(100),
    stats:  repo.positions.getPnlStats(),
    walletBalance: repo.getWalletBalance(),
    autoTrade: {
      enabled:     repo.getAutoTradeEnabled(),
      solPerTrade: env.AUTO_TRADE_SOL_PER_TRADE,
      maxPositions: env.AUTO_TRADE_MAX_POSITIONS,
      minTier:     env.AUTO_TRADE_MIN_TIER,
      minScore:    env.AUTO_TRADE_MIN_SCORE,
    },
  }));

  // GET /api/positions/:id/pnl — live unrealized P&L for one open position
  app.get<{ Params: { id: string } }>("/api/positions/:id/pnl", async (req, reply) => {
    const pos = repo.positions.getPosition(req.params.id);
    if (!pos) return reply.status(404).send({ error: "Position not found" });
    const screened = await screener.checkAddress(pos.address);
    if (!screened) return reply.status(502).send({ error: "Could not fetch price" });
    const currentPrice = screened.priceUsd;
    const pnlPct  = pos.entry_price > 0 ? ((currentPrice - pos.entry_price) / pos.entry_price) * 100 : 0;
    const pnlSol  = pos.amount_sol * (pnlPct / 100);
    const holdMin = Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60000);
    return { id: pos.id, symbol: pos.symbol, currentPrice, pnlPct, pnlSol, holdMin };
  });

  app.post<{
    Body: {
      address: string; amountSol: number; slPct?: number; tpPct?: number;
      trailingStopPct?: number; notes?: string;
    };
  }>("/api/positions/buy", async (req, reply) => {
    const { address, amountSol, slPct, tpPct, trailingStopPct, notes } = req.body ?? {};
    if (!address || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "address and amountSol (>0) required" });
    }

    // Check wallet balance
    if (!repo.deductWallet(amountSol)) {
      return reply.status(402).send({
        error: "Insufficient paper wallet balance",
        walletBalance: repo.getWalletBalance(),
      });
    }

    const screened = await screener.checkAddress(address);
    if (!screened) {
      repo.creditWallet(amountSol); // refund
      return reply.status(404).send({ error: "Token not found on DexScreener" });
    }

    const pos = repo.positions.openPosition({
      address:    screened.address,
      symbol:     screened.symbol,
      entryPrice: screened.priceUsd,
      amountSol,
      slPct:           slPct           ?? null,
      tpPct:           tpPct           ?? null,
      trailingStopPct: trailingStopPct ?? null,
      notes:  notes  ?? undefined,
    });

    broadcast("POSITION_OPENED", pos);
    return reply.status(201).send({ position: pos, walletBalance: repo.getWalletBalance() });
  });

  app.post<{
    Params: { id: string };
    Body: { fraction?: number };
  }>("/api/positions/:id/sell", async (req, reply) => {
    const pos = repo.positions.getPosition(req.params.id);
    if (!pos) return reply.status(404).send({ error: "Position not found or already closed" });

    const screened = await screener.checkAddress(pos.address);
    if (!screened) return reply.status(502).send({ error: "Could not fetch current price" });

    const fraction = req.body?.fraction ?? 1;
    const closed = repo.positions.closePosition(req.params.id, fraction, screened.priceUsd, "manual");
    if (!closed) return reply.status(500).send({ error: "Close failed" });

    // Credit wallet: return the closed amount at current price
    const returnAmount = closed.amount_sol;
    repo.creditWallet(returnAmount);

    broadcast("POSITION_CLOSED", closed);
    return { closed, walletBalance: repo.getWalletBalance() };
  });

  return { app, broadcast };
}

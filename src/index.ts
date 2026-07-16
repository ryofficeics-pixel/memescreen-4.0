import cron from "node-cron";
import { loadEnv } from "./config/env.js";
import { Repository } from "./db/repository.js";
import { ScreenerService } from "./services/screenerService.js";
import { TelegramService } from "./services/telegramService.js";
import { AlertService } from "./services/alertService.js";
import { buildServer } from "./server/api.js";

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  MEMESCREENER 4.0 — Solana Multi-Source Detector ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // 1. Validate env (exits with clear error if invalid)
  const env = loadEnv();
  const srcLimit = env.MAX_TOKENS_PER_SOURCE ?? env.DEXSCREENER_MAX_TOKENS;
  console.log(`[BOOT] Port:${env.PORT} | Scan every ${env.SCAN_INTERVAL_MINUTES}m | ${srcLimit} tokens/source | BirdEye:${env.BIRDEYE_API_KEY ? "✓" : "—"} | PumpFun:${env.PUMPFUN_ENABLED}`);

  // 2. DB
  const repo = new Repository(env.DATABASE_PATH);
  repo.init();

  // 3. Services
  const screener = new ScreenerService(repo, env);
  const tg       = new TelegramService(env, repo, screener);
  const alerter  = new AlertService(repo, tg);

  // 4. Wire alert callback — screener calls this for each ALERT-decision token
  screener.setOnAlert(async (token) => {
    await alerter.handleScreenedToken(token);
  });

  // 5. Fastify server (sets screener.setBroadcast internally)
  const { app } = await buildServer(env, repo, screener, () => shutdown("API"));
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`[SERVER] Dashboard → http://localhost:${env.PORT}`);

  // 6. Telegram bot
  await tg.launch();

  // 7. After each scan, send summary to Telegram
  screener.setOnScanComplete(async (summary) => {
    await tg.sendScanSummary(summary);
  });

  // 8. Cron schedule
  const cronExpr = `*/${env.SCAN_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, () => {
    console.log("[CRON] Scheduled scan triggered");
    screener.runScan().catch(e => console.error("[CRON] Scan error:", e));
  });
  console.log(`[CRON] Scheduled: every ${env.SCAN_INTERVAL_MINUTES} minutes`);

  // 9. Initial scan (after 3s warmup)
  setTimeout(() => {
    console.log("[BOOT] Running initial scan...");
    screener.runScan().catch(e => console.error("[BOOT] Initial scan error:", e));
  }, 3000);

  // 9b. SL/TP monitor — every 30s, non-overlapping
  async function runSltp() {
    try {
      const n = repo.positions.listOpenPositions().length;
      if (n > 0) await screener.checkSlTp();
    } catch (e) {
      console.error("[SL/TP] Fatal in monitor:", e);
    }
  }
  runSltp(); // immediate first run
  setInterval(runSltp, 30_000);
  console.log("[SL/TP] Monitor: every 30s");

  // 9c. Self-audit every 12 minutes — verifies SL/TP can reach every open position
  setInterval(async () => {
    const warnings = await screener.auditSlTp();
    for (const w of warnings) console.log(`[AUDIT] ⚠ ${w}`);
  }, 12 * 60 * 1000);
  console.log("[AUDIT] SL/TP price-source health check every 12 minutes");

  // 10. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[SHUTDOWN] ${signal}`);
    tg.stop();
    await app.close();
    repo.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

main().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});

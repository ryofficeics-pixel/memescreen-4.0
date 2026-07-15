import { Telegraf, Markup, type Context } from "telegraf";
import type { AppEnv } from "../config/env.js";
import type { Repository } from "../db/repository.js";
import type { ScreenerService } from "./screenerService.js";
import type { ScanSummary, AlertRow } from "../domain/types.js";
import type { ScreenedTokenV40 } from "./screenerService.js";

export class TelegramService {
  private readonly bot: Telegraf;
  private paused = false;

  constructor(
    private readonly env: AppEnv,
    private readonly repo: Repository,
    private readonly screener: ScreenerService
  ) {
    this.bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
    this.registerCommands();
  }

  // ── Guard middleware — only allow configured chat IDs ────────────────────
  private isAllowed(ctx: Context): boolean {
    return this.env.allowedChatIds.has(String(ctx.chat?.id ?? ""));
  }

  // ── Register all commands ────────────────────────────────────────────────
  private registerCommands(): void {
    // Auth guard on every update
    this.bot.use(async (ctx, next) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("⛔ Unauthorized").catch(() => {});
        return;
      }
      return next();
    });

    this.bot.start(ctx => ctx.reply(
      "🚀 *MemeScreener 4.0*\n\n" +
      "Commands:\n" +
      "/status — scan stats\n" +
      "/top — top 5 signals\n" +
      "/sources — data source health\n" +
      "/check <address> — analyze token\n" +
      "/scan — trigger manual scan\n" +
      "/buy <addr> <sol> [sl%] [tp%] [trail%] — paper buy\n" +
      "/sell <id> [fraction] — paper sell\n" +
      "/positions — open paper positions\n" +
      "/pnl — paper trading stats\n" +
      "/pause — pause alerts\n" +
      "/resume — resume alerts\n" +
      "/alerts — recent alerts\n" +
      "/help — this menu",
      { parse_mode: "Markdown" }
    ));

    this.bot.help(ctx => ctx.reply(
      "📖 *Commands*\n\n" +
      "`/status` — system + last scan stats\n" +
      "`/top` — top scoring alert tokens\n" +
      "`/sources` — data source health & last counts\n" +
      "`/check <addr>` — deep scan specific token\n" +
      "`/scan` — force immediate scan\n" +
      "`/setjupiter <key>` — set Jupiter API key (routability checks)\n" +
      "`/buy <addr> <sol> [sl%] [tp%] [trail%]` — open paper position " +
      "(blank sl/tp auto-fills from moonshot suggestion; trail% rides the " +
      "move with an adaptive trailing stop instead of a fixed target)\n" +
      "`/sell <id> [fraction]` — close paper position (default: full)\n" +
      "`/positions` — list open paper positions\n" +
      "`/pnl` — paper trading PnL summary\n" +
      "`/pause` — pause Telegram alerts\n" +
      "`/resume` — resume Telegram alerts\n" +
      "`/alerts` — last 10 alerts\n" +
      "`/approve <id>` — mark alert approved\n" +
      "`/reject <id>` — mark alert rejected",
      { parse_mode: "Markdown" }
    ));

    // ── 4.0: /sources — data source health ──────────────────────────────────
    this.bot.command("sources", async ctx => {
      const statuses = this.repo.getAllSourceStatuses();
      if (statuses.length === 0) {
        return ctx.reply("No source data yet — run /scan first.");
      }
      const sourceIcon: Record<string, string> = {
        dexscreener: "📈", birdeye: "🦅", pumpfun: "🎰",
      };
      const lines = statuses.map(s => {
        const icon   = sourceIcon[s.name] ?? "🔗";
        const status = s.last_ok ? "✅" : "❌";
        const latency = s.last_latency_ms ? `${s.last_latency_ms}ms` : "—";
        const count   = s.last_count != null ? `${s.last_count} tokens` : "—";
        const lastOk  = s.last_success_at ? fmtTime(s.last_success_at) : "never";
        const errLine = (!s.last_ok && s.last_error)
          ? `\n   ⚠ ${s.last_error.slice(0, 60)}`
          : "";
        return `${icon} *${s.name}* ${status}\n   ${count} | ${latency} | last ok: ${lastOk}${errLine}`;
      }).join("\n\n");
      await ctx.reply(`🌐 *Data Sources*\n\n${lines}`, { parse_mode: "Markdown" });
    });

    this.bot.command("status", async ctx => {
      const lastScan       = this.screener.lastScan;
      const alertsLastHour = this.repo.countAlertsLastHour();
      const pauseText      = this.paused ? "⏸ PAUSED" : "▶️ ACTIVE";

      await ctx.reply(
        `📊 *Screener Status*\n\n` +
        `State: ${pauseText}\n` +
        `Scanning: ${this.screener.scanning ? "🔄 In progress" : "✅ Idle"}\n\n` +
        `*Last Scan:*\n` +
        (lastScan
          ? `• Candidates: ${lastScan.totalCandidates}\n` +
            `• Alerts: ${lastScan.alertsCount}\n` +
            `• Watch: ${lastScan.watchCount}\n` +
            `• Avoided: ${lastScan.avoidCount}\n` +
            `• Duration: ${(lastScan.durationMs / 1000).toFixed(1)}s`
          : "No scan run yet") +
        `\n\n*Alerts this hour:* ${alertsLastHour}`,
        { parse_mode: "Markdown" }
      );
    });

    this.bot.command("top", async ctx => {
      const tokens = this.repo.listTokens(5, { decision: "alert" });
      if (tokens.length === 0) {
        return ctx.reply("No alert-level tokens found. Run /scan first.");
      }
      const tierIcon: Record<string, string> = { S: "🟦", A: "🟩", B: "🟨", C: "⬜", REJECT: "🟥" };
      const lines = tokens.map((t, i) =>
        `${i + 1}. ${tierIcon[t.tier] ?? ""} *$${t.symbol}* (Tier ${t.tier}) — Score: ${t.final_score}/100\n` +
        `   Vol1h: ${fmtUsd(t.volume_1h)} | Liq: ${fmtUsd(t.liquidity_usd)}\n` +
        `   \`${t.address.slice(0, 20)}...\``
      ).join("\n\n");
      await ctx.reply(`🏆 *Top Alert Signals*\n\n${lines}`, { parse_mode: "Markdown" });
    });

    this.bot.command("check", async ctx => {
      const parts   = ctx.message.text.split(" ");
      const address = parts[1]?.trim();
      if (!address) return ctx.reply("Usage: /check <token_address>");

      const msg = await ctx.reply("🔍 Analyzing token...");
      try {
        const screened = await this.screener.checkAddress(address);
        if (!screened) {
          return ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            "❌ Token not found on DexScreener"
          );
        }
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          this.buildAlertMessage(screened),
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `❌ Error: ${errMsg}`
        );
      }
    });

    this.bot.command("scan", async ctx => {
      if (this.screener.scanning) return ctx.reply("⏳ Scan already in progress");
      await ctx.reply("⚡ Manual scan triggered...");
      this.screener.runScan().catch(e => console.error("[TG] Scan error:", e));
    });

    this.bot.command("pause", async ctx => {
      this.paused = true;
      await ctx.reply("⏸ Alerts paused. Use /resume to restart.");
    });

    this.bot.command("resume", async ctx => {
      this.paused = false;
      await ctx.reply("▶️ Alerts resumed.");
    });

    this.bot.command("alerts", async ctx => {
      const alerts = this.repo.listAlerts(10);
      if (alerts.length === 0) return ctx.reply("No alerts yet.");
      const lines = alerts.map((a: AlertRow) =>
        `#${a.id} *$${a.symbol}* score:${a.final_score} — ${a.user_action ?? "pending"} (${fmtTime(a.created_at)})`
      ).join("\n");
      await ctx.reply(`📋 *Recent Alerts*\n\n${lines}`, { parse_mode: "Markdown" });
    });

    this.bot.command("approve", async ctx => {
      const id = parseInt(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(id)) return ctx.reply("Usage: /approve <alert_id>");
      this.repo.updateAlertAction(id, "approved");
      await ctx.reply(`✅ Alert #${id} marked as approved`);
    });

    this.bot.command("reject", async ctx => {
      const id = parseInt(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(id)) return ctx.reply("Usage: /reject <alert_id>");
      this.repo.updateAlertAction(id, "rejected");
      await ctx.reply(`❌ Alert #${id} marked as rejected`);
    });

    // /setjupiter <api_key> — store Jupiter API key for routability checks
    this.bot.command("setjupiter", async ctx => {
      const key = ctx.message.text.split(" ")[1]?.trim();
      if (!key) {
        const current = this.repo.getSetting("jupiter_api_key");
        return ctx.reply(
          current
            ? "Jupiter key is set. Send /setjupiter <key> to replace it, or /setjupiter clear to remove."
            : "Usage: /setjupiter <api_key>\nGet a free key at https://portal.jup.ag"
        );
      }
      if (key.toLowerCase() === "clear") {
        this.repo.setSetting("jupiter_api_key", "");
        return ctx.reply("🗑 Jupiter key cleared. Routability checks disabled.");
      }
      this.repo.setSetting("jupiter_api_key", key);
      await ctx.reply("✅ Jupiter API key saved. Routability checks now active on next scan.");
    });

    // ── Paper trading commands ────────────────────────────────────────────
    // /buy <address> <amountSol> [slPct] [tpPct]
    this.bot.command("buy", async ctx => {
      const parts   = ctx.message.text.split(" ").filter(Boolean);
      const address = parts[1];
      const amount  = parseFloat(parts[2] ?? "");
      let   slPct   = parts[3] ? parseFloat(parts[3]) : null;
      let   tpPct   = parts[4] ? parseFloat(parts[4]) : null;
      const trailPct = parts[5] ? parseFloat(parts[5]) : null;

      if (!address || isNaN(amount) || amount <= 0) {
        return ctx.reply(
          "Usage: /buy <address> <amountSol> [slPct] [tpPct] [trailPct]\n" +
          "Example: /buy 8a5bn...pump 0.5 20 50\n" +
          "(buys 0.5 SOL worth, stop-loss -20%, take-profit +50%)\n\n" +
          "Leave slPct/tpPct blank (or pass \"-\") to auto-fill from the " +
          "adaptive moonshot suggestion — e.g. /buy <addr> 0.5 - - 25 uses " +
          "the suggested SL/TP with a 25% trailing stop instead of a fixed target."
        );
      }

      if (!this.repo.deductWallet(amount)) {
        return ctx.reply(`❌ Insufficient paper wallet balance (${this.repo.getWalletBalance().toFixed(4)} SOL)`);
      }

      const screened = await this.screener.checkAddress(address);
      if (!screened) {
        this.repo.creditWallet(amount);
        return ctx.reply("❌ Token not found on DexScreener");
      }

      // Auto-fill from the adaptive moonshot suggestion if the user left
      // SL/TP unset (or passed "-") rather than defaulting to nothing —
      // a moonshot-flagged token left with no TP has no safety net either.
      let autoFilled = false;
      if (slPct === null || isNaN(slPct)) {
        slPct = screened.moonshot.suggestedSlPct;
        autoFilled = true;
      }
      if (tpPct === null || isNaN(tpPct)) {
        tpPct = screened.moonshot.suggestedTpPct;
        autoFilled = true;
      }

      const pos = this.repo.positions.openPosition({
        address: screened.address,
        symbol:  screened.symbol,
        entryPrice: screened.priceUsd,
        amountSol:  amount,
        slPct, tpPct,
        trailingStopPct: trailPct && !isNaN(trailPct) ? trailPct : null,
      });

      const moonshotNote = screened.moonshot.isMoonshotCandidate
        ? `\n🚀 Moonshot candidate (score ${screened.moonshot.moonshotScore}/100) — suggested ceiling ${screened.moonshot.suggestedTpMultiplier}x`
        : "";

      await ctx.reply(
        `✅ *Paper position opened*\n\n` +
        `Token: $${pos.symbol}\n` +
        `Entry: $${fmtPrice(pos.entry_price)}\n` +
        `Size: ${pos.amount_sol} SOL\n` +
        `SL: ${slPct ? `-${slPct}%` : "none"} | TP: ${tpPct ? `+${tpPct}%` : "none"}` +
        `${autoFilled ? " (auto-filled from moonshot suggestion)" : ""}\n` +
        `Trailing stop: ${pos.trailing_stop_pct ? `${pos.trailing_stop_pct}% off peak` : "none — fixed TP only"}` +
        moonshotNote + `\n` +
        `Wallet: ${this.repo.getWalletBalance().toFixed(4)} SOL\n` +
        `ID: \`${pos.id}\``,
        { parse_mode: "Markdown" }
      );
    });

    // /sell <positionId> [fraction]
    this.bot.command("sell", async ctx => {
      const parts      = ctx.message.text.split(" ").filter(Boolean);
      const positionId = parts[1];
      const fraction   = parts[2] ? parseFloat(parts[2]) : 1;

      if (!positionId) return ctx.reply("Usage: /sell <position_id> [fraction 0-1, default 1]");

      const pos = this.repo.positions.getPosition(positionId);
      if (!pos) return ctx.reply("❌ Position not found or already closed");

      const screened = await this.screener.checkAddress(pos.address);
      if (!screened) return ctx.reply("❌ Could not fetch current price");

      const closed = this.repo.positions.closePosition(positionId, fraction, screened.priceUsd, "manual");
      if (!closed) return ctx.reply("❌ Close failed");

      this.repo.creditWallet(closed.amount_sol);

      const pnlEmoji = (closed.pnl_pct ?? 0) >= 0 ? "🟢" : "🔴";
      await ctx.reply(
        `${pnlEmoji} *Position closed* (${(fraction * 100).toFixed(0)}%)\n\n` +
        `Token: $${closed.symbol}\n` +
        `Entry: $${fmtPrice(closed.entry_price)} → Exit: $${fmtPrice(closed.exit_price)}\n` +
        `PnL: ${closed.pnl_pct?.toFixed(2) ?? "—"}% (${closed.pnl_sol?.toFixed(4) ?? "—"} SOL)\n` +
        `Wallet: ${this.repo.getWalletBalance().toFixed(4)} SOL`,
        { parse_mode: "Markdown" }
      );
    });

    // /positions — list open paper positions
    this.bot.command("positions", async ctx => {
      const open = this.repo.positions.listOpenPositions();
      if (open.length === 0) return ctx.reply("No open positions.");
      const lines = open.map(p =>
        `*$${p.symbol}* — ${p.amount_sol} SOL @ $${fmtPrice(p.entry_price)}\n` +
        `  SL:${p.sl_pct ? `-${p.sl_pct}%` : "—"} TP:${p.tp_pct ? `+${p.tp_pct}%` : "—"}` +
        `${p.trailing_stop_pct ? ` Trail:${p.trailing_stop_pct}% (peak $${fmtPrice(p.peak_price)})` : ""}\n` +
        `  \`${p.id}\``
      ).join("\n\n");
      await ctx.reply(`📂 *Open Positions*\n\n${lines}`, { parse_mode: "Markdown" });
    });

    // /pnl — rich paper trading stats
    this.bot.command("pnl", async ctx => {
      const s = this.repo.positions.getPnlStats();
      const emoji   = s.realizedPnlSol >= 0 ? "🟢" : "🔴";
      const sign    = s.realizedPnlSol >= 0 ? "+" : "";
      const open    = this.repo.positions.listOpenPositions();
      const ah      = s.avgHoldMinutes;
      const holdTxt = ah != null ? (ah < 60 ? `${Math.round(ah)}m` : `${(ah/60).toFixed(1)}h`) : "—";
      await ctx.reply(
        `${emoji} *Paper Trading Summary*\n\n` +
        `💰 Realized PnL: \`${sign}${s.realizedPnlSol.toFixed(4)} SOL\`\n` +
        `⚖️ Win rate: ${s.winRate.toFixed(1)}% (${s.totalTrades} closed)\n` +
        `📂 Open positions: ${open.length} (${s.solAtRisk.toFixed(3)} SOL at risk)\n` +
        `⏱ Avg hold: ${holdTxt}\n` +
        `📈 Best trade: ${s.bestTradePct != null ? `+${s.bestTradePct.toFixed(1)}%` : "—"}\n` +
        `📉 Worst trade: ${s.worstTradePct != null ? `${s.worstTradePct.toFixed(1)}%` : "—"}`,
        { parse_mode: "Markdown" }
      );
    });

    // /wallet — show paper wallet balance
    this.bot.command("wallet", async ctx => {
      const bal = this.repo.getWalletBalance();
      const open = this.repo.positions.listOpenPositions();
      const at   = this.repo.getAutoTradeEnabled();
      await ctx.reply(
        `👛 *Paper Wallet*\n\n` +
        `Balance: \`${bal.toFixed(4)} SOL\`\n` +
        `Open positions: ${open.length}\n` +
        `Auto-trade: ${at ? "✅ ON" : "❌ OFF"}`,
        { parse_mode: "Markdown" }
      );
    });

    // /autotrade — toggle auto-trade on/off
    this.bot.command("autotrade", async ctx => {
      const current = this.repo.getAutoTradeEnabled();
      this.repo.setAutoTradeEnabled(!current);
      await ctx.reply(
        `🤖 Auto-trade is now *${!current ? "ENABLED" : "DISABLED"}*\n` +
        `${!current ? "Will auto-buy alert-tier tokens on next scan." : "Manual trading only."}`,
        { parse_mode: "Markdown" }
      );
    });

    // Inline button callbacks
    this.bot.action(/^approve_(\d+)$/, async ctx => {
      const id = parseInt(ctx.match[1]!);
      this.repo.updateAlertAction(id, "approved");
      await ctx.answerCbQuery("✅ Approved");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "✅ Approved", callback_data: "noop" }]]
      });
    });

    this.bot.action(/^reject_(\d+)$/, async ctx => {
      const id = parseInt(ctx.match[1]!);
      this.repo.updateAlertAction(id, "rejected");
      await ctx.answerCbQuery("❌ Rejected");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "❌ Rejected", callback_data: "noop" }]]
      });
    });

    this.bot.action("noop", ctx => ctx.answerCbQuery());

    this.bot.catch((err) => {
      console.error("[TG] Bot error:", err);
    });
  }

  // ── Send alert for strong-buy token ─────────────────────────────────────
  async sendAlert(token: ScreenedTokenV40, alertId: number): Promise<boolean> {
    if (!this.env.ENABLE_TELEGRAM) return false;
    if (this.paused)              return false;

    const alertsH = this.repo.countAlertsLastHour();
    if (alertsH >= this.env.MAX_ALERTS_PER_HOUR) {
      console.warn(`[TG] Rate limit: ${alertsH} alerts this hour, max ${this.env.MAX_ALERTS_PER_HOUR}`);
      return false;
    }

    try {
      await this.bot.telegram.sendMessage(
        this.env.TELEGRAM_CHAT_ID,
        this.buildAlertMessage(token),
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("✅ Approve", `approve_${alertId}`),
              Markup.button.callback("❌ Reject",  `reject_${alertId}`),
            ],
            [Markup.button.url(
              "📊 DexScreener",
              token.pairUrl || `https://dexscreener.com/solana/${token.address}`
            )],
          ])
        }
      );
      return true;
    } catch (err) {
      console.error("[TG] sendAlert failed:", err);
      return false;
    }
  }

  async sendScanSummary(summary: ScanSummary): Promise<void> {
    if (!this.env.ENABLE_TELEGRAM || this.paused) return;
    try {
      await this.bot.telegram.sendMessage(
        this.env.TELEGRAM_CHAT_ID,
        `🔍 *Scan Complete*\n` +
        `Scanned: ${summary.totalCandidates} | Alerts: ${summary.alertsCount} | ` +
        `Watch: ${summary.watchCount} | Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
        { parse_mode: "Markdown" }
      );
    } catch { /* silent — summary is non-critical */ }
  }

  // ── Format alert message ─────────────────────────────────────────────────
  buildAlertMessage(t: ScreenedTokenV40): string {
    const emoji    = t.decision === "alert" ? "🚀🟢" : "👀🟡";
    const scoreBar = progressBar(t.finalScore);
    const c        = t.risk.checks;
    const comp     = t.opportunity.components;
    const tierIcon = { S: "🟦", A: "🟩", B: "🟨", C: "⬜", REJECT: "🟥" }[t.tier];
    const jupText  = t.jupiterRoutable === null ? "not checked"
                    : t.jupiterRoutable ? "✅ routable" : "❌ NOT routable";

    // 4.0: source confirmation line
    const sourceIcon: Record<string, string> = { dexscreener: "📈", birdeye: "🦅", pumpfun: "🎰" };
    const sourceNames = Array.isArray(t.sources) && t.sources.length > 0 ? t.sources : [t.source];
    const sourceLine  = sourceNames.map(s => `${sourceIcon[s] ?? "🔗"} ${s}`).join(" + ");
    const multiConfirm = sourceNames.length >= 2 ? " ⭐ *multi-source*" : "";

    const checkLines = [
      `${c.age.passed        ? "✅" : "❌"} Age: ${c.age.value}`,
      `${c.liquidity.passed  ? "✅" : "❌"} Liquidity: ${c.liquidity.value}`,
      `${c.volume.passed     ? "✅" : "❌"} Volume: ${c.volume.value}`,
      `${c.volatility.passed ? "✅" : "⚠️"} Volatility: ${c.volatility.value}`,
      `${c.fdvRatio.passed   ? "✅" : "⚠️"} FDV/Liq: ${c.fdvRatio.value}`,
      `${c.holderConc.passed ? "✅" : "❌"} Top10: ${c.holderConc.value}`,
      `${c.honeypot.passed   ? "✅" : "❌"} Sell Sim: ${c.honeypot.value}`,
      `${c.mintAuth.passed   ? "✅" : "⚠️"} Mint Auth: ${c.mintAuth.value}`,
    ].join("\n");

    // 4.0: new momentum breakdown lines
    const compLines = [
      `• Vol Velocity:   ${comp.volumeVelocity}/100`,
      `• Price Momentum: ${comp.priceMomentum}/100`,
      `• Holder Spread:  ${comp.holderGrowth}/100`,
      `• Liq Depth:      ${comp.liquidityDepth}/100`,
      `• TX Activity:    ${comp.txActivity}/100`,
      `• Age Window:     ${comp.ageWindow}/100`,
      `• Buy Pressure:   ${comp.buySellPressure}/100`,
      ...(comp.liquidityGrowth  > 0 ? [`• Liq Growth:     +${comp.liquidityGrowth}pts`]  : []),
      ...(comp.crossSourceBonus > 0 ? [`• Multi-Source:   +${comp.crossSourceBonus}pts`] : []),
    ].join("\n");

    const moonshotLine = t.moonshot.isMoonshotCandidate
      ? `🚀 *Moonshot candidate* (${t.moonshot.moonshotScore}/100) — suggested TP ceiling *${t.moonshot.suggestedTpMultiplier}x*, SL -${t.moonshot.suggestedSlPct}%\n` +
        (t.moonshot.pumpAlreadyDetected
          ? `⚡ Pump already detected: *${t.moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x* since first seen\n\n`
          : "\n")
      : (t.moonshot.pumpAlreadyDetected
          ? `⚡ *Pump already detected*: ${t.moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x since first seen\n\n`
          : "");

    return (
      `${emoji} *${t.decision === "alert" ? "STRONG BUY" : "WATCH"}: $${t.symbol}*  ${tierIcon} Tier ${t.tier}\n` +
      `${t.name}\n\n` +
      moonshotLine +
      `📊 *Score: ${t.finalScore}/100*  (confidence ${t.tierConfidence}%)\n` +
      `\`${scoreBar}\`\n` +
      `Risk: ${t.risk.riskScore}/100 | Opp: ${t.opportunity.opportunityScore}/100\n` +
      `Jupiter: ${jupText}\n` +
      `🌐 Sources: ${sourceLine}${multiConfirm}\n\n` +
      `💰 Price: \`$${fmtPrice(t.priceUsd)}\`\n` +
      `📈 Vol 1h: \`${fmtUsd(t.volume1hUsd)}\` (${t.priceChange1h > 0 ? "+" : ""}${t.priceChange1h.toFixed(1)}%)\n` +
      `💧 Liquidity: \`${fmtUsd(t.liquidityUsd)}\`\n` +
      `🏪 FDV: \`${fmtUsd(t.fdvUsd)}\`\n` +
      `🏦 DEX: \`${t.dexId.toUpperCase()}\`\n` +
      `⏰ Age: \`${t.ageMinutes !== null ? fmtAge(t.ageMinutes) : "unknown"}\`\n\n` +
      `*Momentum:*\n${compLines}\n\n` +
      `*Anti-Scam (8 checks):*\n${checkLines}\n\n` +
      `🔗 \`${t.address}\``
    );
  }

  async launch(): Promise<void> {
    await this.bot.launch({ dropPendingUpdates: true });
    console.log("[TG] Bot launched — polling");
  }

  stop(): void {
    this.bot.stop("SIGTERM");
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────
function progressBar(score: number): string {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function fmtUsd(n: number): string {
  if (!n || !isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number): string {
  if (!n || !isFinite(n)) return "—";
  if (n < 0.000001) return n.toExponential(4);
  if (n < 0.01)     return n.toFixed(8);
  if (n < 1)        return n.toFixed(6);
  return n.toFixed(4);
}

function fmtAge(minutes: number): string {
  if (minutes < 60)   return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

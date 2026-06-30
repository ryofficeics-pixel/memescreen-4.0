import { Telegraf } from "telegraf";
import { loadEnv } from "../src/config/env.js";

const env = loadEnv();

console.log("\n📨 Testing Telegram connection...\n");

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

try {
  const me = await bot.telegram.getMe();
  console.log("✅ Bot connected:", `@${me.username}`);

  await bot.telegram.sendMessage(
    env.TELEGRAM_CHAT_ID,
    "🚀 *MemeScreener 3.0* — Telegram test OK!\n\nYour bot is connected and ready.",
    { parse_mode: "Markdown" }
  );
  console.log("✅ Test message sent to chat:", env.TELEGRAM_CHAT_ID);
} catch (err) {
  console.error("❌ Telegram error:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  bot.stop();
}

process.exit(0);

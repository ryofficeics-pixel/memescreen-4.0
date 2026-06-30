import { loadEnv } from "../src/config/env.js";

console.log("\n🔍 Checking environment config...\n");

const env = loadEnv();

console.log("✅ Environment valid!\n");
console.log("  PORT              :", env.PORT);
console.log("  SCAN_INTERVAL     :", env.SCAN_INTERVAL_MINUTES, "minutes");
console.log("  QUICKNODE_RPC     :", env.QUICKNODE_RPC_URL.slice(0, 40) + "...");
console.log("  TELEGRAM_BOT_TOKEN:", env.TELEGRAM_BOT_TOKEN.slice(0, 12) + "...");
console.log("  TELEGRAM_CHAT_ID  :", env.TELEGRAM_CHAT_ID);
console.log("  MIN_LIQUIDITY     :", "$" + env.MIN_LIQUIDITY_USD.toLocaleString());
console.log("  STRONG_BUY_SCORE  :", env.STRONG_BUY_SCORE);
console.log("  MAX_RISK_SCORE    :", env.MAX_RISK_SCORE);
console.log("  DATABASE_PATH     :", env.DATABASE_PATH);
console.log("");

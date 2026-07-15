import { config } from "dotenv";
import { z } from "zod";

config();

const schema = z.object({
  NODE_ENV:    z.enum(["development", "production"]).default("development"),
  LOG_LEVEL:   z.enum(["trace","debug","info","warn","error"]).default("info"),
  PORT:        z.coerce.number().int().positive().default(3001),

  QUICKNODE_RPC_URL: z.string().url("QUICKNODE_RPC_URL must be a valid URL"),

  TELEGRAM_BOT_TOKEN:   z.string().min(10, "TELEGRAM_BOT_TOKEN required"),
  TELEGRAM_CHAT_ID:     z.string().min(1,  "TELEGRAM_CHAT_ID required"),
  ENABLE_TELEGRAM:      z.string().transform(v => v === "true").default("true"),

  // ── 4.0: Multi-source data ───────────────────────────────────────────────
  // BirdEye: source is silently skipped if key is absent
  BIRDEYE_API_KEY:       z.string().default(""),
  // Toggle Pump.fun source (default on — uses free DexScreener endpoint)
  PUMPFUN_ENABLED:       z.string().default("true"),
  // Toggle cross-source confirmation bonus in opportunity scoring
  MULTI_SOURCE_BONUS:    z.string().default("true"),
  // Per-source token limit; total candidates = up to 3× this value
  MAX_TOKENS_PER_SOURCE: z.coerce.number().int().min(10).max(500).default(100),

  SCAN_INTERVAL_MINUTES:  z.coerce.number().int().min(1).max(60).default(30),
  DEXSCREENER_MAX_TOKENS: z.coerce.number().int().min(1).max(200).default(100),

  MIN_LIQUIDITY_USD:      z.coerce.number().positive().default(50000),
  MIN_VOLUME_24H_USD:     z.coerce.number().positive().default(25000),
  MIN_TOKEN_AGE_MINUTES:  z.coerce.number().positive().default(60),
  MAX_TOP10_HOLDER_PCT:   z.coerce.number().min(0).max(100).default(65),

  MAX_RISK_SCORE:         z.coerce.number().min(0).max(100).default(45),
  MIN_OPPORTUNITY_SCORE:  z.coerce.number().min(0).max(100).default(55),
  STRONG_BUY_SCORE:       z.coerce.number().min(0).max(100).default(75),

  MAX_ALERTS_PER_HOUR:    z.coerce.number().int().positive().default(10),

  // ── Auto-trade (paper wallet) ────────────────────────────────────────────
  AUTO_TRADE_ENABLED:      z.string().default("false"),
  AUTO_TRADE_SOL_PER_TRADE: z.coerce.number().positive().default(0.5),
  AUTO_TRADE_MAX_POSITIONS: z.coerce.number().int().positive().default(5),
  // Min tier to auto-buy: "S" only, or "A" (includes S+A)
  AUTO_TRADE_MIN_TIER:     z.enum(["S", "A", "B"]).default("A"),
  AUTO_TRADE_MIN_SCORE:    z.coerce.number().int().min(0).max(100).default(60),

  DATABASE_PATH: z.string().default("./data/screener.db"),
});

export type AppEnv = z.infer<typeof schema> & {
  allowedChatIds: Set<string>;
};

let _env: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (_env) return _env;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment config:");
    parsed.error.issues.forEach(i => console.error(`  • ${i.path.join(".")}: ${i.message}`));
    process.exit(1);
  }

  const allowedChatIds = new Set<string>();
  const rawChatId = parsed.data.TELEGRAM_CHAT_ID;
  rawChatId.split(",").map(s => s.trim()).filter(Boolean).forEach(id => allowedChatIds.add(id));

  _env = { ...parsed.data, allowedChatIds };
  return _env;
}

// ─── Convenience boolean accessors ────────────────────────────────────────
export function isPumpFunEnabled(env: AppEnv):       boolean { return env.PUMPFUN_ENABLED    === "true"; }
export function isMultiSourceBonus(env: AppEnv):     boolean { return env.MULTI_SOURCE_BONUS === "true"; }
export function hasBirdEyeKey(env: AppEnv):          boolean { return env.BIRDEYE_API_KEY.trim().length > 0; }

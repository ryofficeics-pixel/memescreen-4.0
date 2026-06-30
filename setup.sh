#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   MEMESCREENER 3.0 — SETUP              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org (v20+)"
  exit 1
fi
NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 20 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VER" = "old" ]; then
  echo "⚠️  Node.js v20+ required. Current: $(node --version)"
  echo "   Update at https://nodejs.org"
fi
echo "✅ Node.js: $(node --version)"

# Install deps
echo ""
echo "📦 Installing dependencies..."
npm install

# Create .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "─────────────────────────────────────────"
  echo "⚙️  Created .env — fill in these values:"
  echo ""
  echo "  QUICKNODE_RPC_URL  → quicknode.com → free account → Solana Mainnet"
  echo "  TELEGRAM_BOT_TOKEN → @BotFather on Telegram → /newbot"
  echo "  TELEGRAM_CHAT_ID   → @userinfobot on Telegram → send /start"
  echo "─────────────────────────────────────────"
else
  echo "✅ .env already exists"
fi

# Dirs
mkdir -p data logs
echo "✅ Directories ready"

echo ""
echo "════════════════════════════════════════════"
echo "✅ Setup complete! Next steps:"
echo ""
echo "  1. Edit .env with your keys"
echo "  2. npm run check:env    — validate config"
echo "  3. npm run test:tg      — test Telegram"
echo "  4. npm run dev          — start (dev mode)"
echo ""
echo "  Dashboard → http://localhost:3001"
echo "════════════════════════════════════════════"
echo ""

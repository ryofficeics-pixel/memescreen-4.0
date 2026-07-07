# MemeScreener 4.0 - Quick Start Scripts

Windows batch files for easy server management.

---

## Available Scripts

### `start.bat` — Development Mode (Recommended)

**What it does:**
- Checks Node.js installation
- Verifies .env file exists
- Installs dependencies if needed
- Starts server in development mode with auto-reload
- Opens dashboard in browser automatically
- Runs in separate window (keeps running after script exits)

**Usage:**
```bash
Double-click start.bat
# OR
start.bat
```

**Features:**
- ✅ Auto-reload on file changes (tsx watch)
- ✅ Detailed console output
- ✅ Browser opens automatically at http://localhost:3002
- ✅ Server runs in separate window

---

### `start-production.bat` — Production Mode

**What it does:**
- Builds TypeScript to JavaScript (dist/ folder)
- Starts compiled server (faster, no watch mode)
- Opens dashboard in browser

**Usage:**
```bash
Double-click start-production.bat
# OR
start-production.bat
```

**When to use:**
- Running 24/7 on a dedicated machine
- VPS deployment (though PM2 is better for VPS)
- Lower memory usage than development mode

---

### `stop.bat` — Stop Server

**What it does:**
- Kills all MemeScreener Node.js processes
- Frees port 3002

**Usage:**
```bash
Double-click stop.bat
# OR
stop.bat
```

**Use when:**
- Server window is closed but process still running
- Port 3002 is blocked
- Need to restart server

---

## First-Time Setup

1. **Configure .env file:**
   ```bash
   # Copy example and edit
   copy .env.example .env
   notepad .env
   ```

2. **Fill in required values:**
   - `QUICKNODE_RPC_URL` → Get from quicknode.com (free)
   - `TELEGRAM_BOT_TOKEN` → Get from @BotFather
   - `TELEGRAM_CHAT_ID` → Get from @userinfobot

3. **Run start.bat:**
   ```bash
   start.bat
   ```

---

## Troubleshooting

### "Node.js not found"
- Install Node.js from https://nodejs.org (v20 or v24 recommended)
- Restart terminal after installation

### ".env file not found"
- Copy `.env.example` to `.env`
- Fill in required credentials

### "Port 3002 already in use"
- Run `stop.bat` to kill existing process
- OR change `PORT=3003` in `.env`

### Server starts but dashboard won't load
- Wait 10 seconds for full startup
- Check if port 3002 is blocked by firewall
- Try http://127.0.0.1:3002 instead of localhost

### "npm install failed"
- Delete `node_modules` folder
- Run `npm install` manually
- Check internet connection

---

## Manual Commands (if scripts fail)

```bash
# Install dependencies
npm install

# Development mode (manual)
npm run dev

# Production build + start
npm run build
npm start

# Stop server (manual)
# Press Ctrl+C in the server window
```

---

## What Happens When You Run start.bat

```
1. Checks if Node.js is installed
   └→ Exits with error if missing

2. Checks if .env exists
   └→ Exits with error if missing

3. Checks if node_modules exists
   └→ Runs npm install if missing

4. Starts server in new window
   └→ Runs: npm run dev
   └→ tsx watch src/index.ts

5. Waits 8 seconds

6. Opens browser at http://localhost:3002

7. Shows success message
   └→ Dashboard URL
   └→ How to stop (Ctrl+C in server window)
```

---

## Server Window Shortcuts

When the server window is active:

| Key | Action |
|-----|--------|
| `Ctrl+C` | Stop server gracefully |
| `Ctrl+Z` | Pause output (press Enter to resume) |
| `rs` + Enter | Manual restart (tsx watch) |

---

## Next Steps After Starting

1. **Dashboard opens automatically** at http://localhost:3002
2. **First scan runs in 30 minutes** (or send `/scan` via Telegram)
3. **Check Telegram bot:** Send `/start` to your bot
4. **Explore tabs:**
   - 💼 Positions (paper trading)
   - 🚀 Alerts (high-score tokens)
   - 👀 Watch (medium-score tokens)
   - 📋 All (full scan results)

---

## Recommended Workflow

**Daily use:**
1. Double-click `start.bat`
2. Let it run in background
3. Check dashboard when Telegram alerts arrive
4. Close server window when done (or leave running 24/7)

**For 24/7 operation:**
1. Use `start-production.bat` OR
2. Deploy to VPS with PM2 (see docs/DEPLOYMENT.md)

**To restart:**
1. Run `stop.bat`
2. Run `start.bat`

---

## File Locations

| File | Purpose |
|------|---------|
| `start.bat` | Development mode launcher |
| `start-production.bat` | Production mode launcher |
| `stop.bat` | Server terminator |
| `.env` | Configuration (secrets, DO NOT commit) |
| `data/screener.db` | SQLite database (positions, alerts) |
| `dist/` | Compiled JavaScript (production build) |
| `node_modules/` | Dependencies |

---

## Security Notes

⚠️ **Never commit:**
- `.env` file (contains API keys)
- `data/` folder (contains database)
- `dist/` folder (build artifacts)

✅ **Safe to commit:**
- `.env.example` (template without secrets)
- `*.bat` scripts
- `src/` source code
- `docs/` documentation

The `.gitignore` file already excludes sensitive files.

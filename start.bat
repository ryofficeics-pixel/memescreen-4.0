@echo off
REM ============================================
REM MemeScreener 4.0 - Auto Start Script
REM ============================================

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  MEMESCREENER 4.0 - Starting...                  ║
echo ╚══════════════════════════════════════════════════╝
echo.

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

REM Check if .env file exists
if not exist ".env" (
    echo [ERROR] .env file not found. Copy .env.example to .env and configure it.
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo [SETUP] Installing dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

echo [STARTING] Launching MemeScreener 4.0 server...
echo [DASHBOARD] Will open at http://localhost:3002
echo.

REM Kill any stale server on port 3002
>nul 2>&1 powershell -NoProfile -Command "$tcp = Get-NetTCPConnection -LocalPort 3002 -ErrorAction SilentlyContinue; if ($tcp) { Stop-Process -Id $tcp.OwningProcess -Force }"
timeout /t 2 /nobreak >nul

REM Start the server in a new window with explicit working directory
start "MemeScreener 4.0 Server" /D "%ROOT_DIR%" cmd /k "npm run dev"

REM Health check — poll the API until the server responds
echo [WAIT] Checking server health... (max 30s)
set "retries=0"
:healthloop
timeout /t 2 /nobreak >nul
set /a retries+=1
if %retries% gtr 15 (
    echo [ERROR] Server failed to start after 30 seconds. Check the server window for errors.
    pause
    exit /b 1
)
>nul 2>&1 curl -s http://localhost:3002/api/status || goto healthloop

REM Open browser first — scan runs in background, dashboard syncs via WebSocket
echo [BROWSER] Opening dashboard...
start http://localhost:3002

REM Fetch current wallet balance + PnL (best-effort, scan may still be running)
echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  MemeScreener 4.0 — Portfolio Summary            ║
echo ╚══════════════════════════════════════════════════╝
powershell -NoProfile -Command "$r = Invoke-WebRequest 'http://localhost:3002/api/positions' -UseBasicParsing -TimeoutSec 4; $d = $r.Content | ConvertFrom-Json; $s = $d.stats; echo '║  Paper Wallet: ' + $d.walletBalance.ToString('F4') + ' SOL'; echo '║  Open Positions: ' + $d.open.Count; echo '║  Realized PnL: ' + $s.realizedPnlSol.ToString('F4') + ' SOL'; echo '║  Win Rate: ' + $s.winRate.ToString('F1') + '% (' + $s.totalTrades + ' closed)'; if ($s.avgHoldMinutes -ne $null) { if ($s.avgHoldMinutes -lt 60) { $ht = [Math]::Round($s.avgHoldMinutes).ToString() + 'm' } else { $ht = [Math]::Round($s.avgHoldMinutes / 60, 1).ToString() + 'h' }; echo '║  Avg Hold: ' + $ht }"

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  MemeScreener 4.0 is running!                    ║
echo ║                                                  ║
echo ║  Dashboard: http://localhost:3002                ║
echo ║  Server: Running in separate window              ║
echo ║                                                  ║
echo ║  Telegram: /wallet /pnl /buy /sell /positions    ║
echo ║  Press Ctrl+C in server window to stop          ║
echo ╚══════════════════════════════════════════════════╝
echo.

pause

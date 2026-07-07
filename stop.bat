@echo off
REM ============================================
REM MemeScreener 4.0 - Stop Script
REM ============================================

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  MEMESCREENER 4.0 - Stopping Server             ║
echo ╚══════════════════════════════════════════════════╝
echo.

REM Kill all Node.js processes running tsx or memescreener
echo [STOP] Terminating Node.js processes...
taskkill /F /FI "WINDOWTITLE eq MemeScreener 4.0*" >nul 2>&1
taskkill /F /IM node.exe /FI "WINDOWTITLE eq MemeScreener*" >nul 2>&1

REM Alternative: kill by port (if running on port 3002)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3002') do taskkill /F /PID %%a >nul 2>&1

echo [DONE] Server stopped
echo.
pause

@echo off
REM ============================================
REM MemeScreener 4.0 - Production Start Script
REM ============================================

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  MEMESCREENER 4.0 - Production Build           ║
echo ╚══════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

REM Check if .env file exists
if not exist ".env" (
    echo [ERROR] .env file not found
    pause
    exit /b 1
)

REM Build the project
echo [BUILD] Compiling TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo [STARTING] Launching production server...
echo.

REM Start the production server in a new window
start "MemeScreener 4.0 Production" cmd /k "npm start"

REM Wait for server startup
timeout /t 8 /nobreak >nul

REM Open dashboard
start http://localhost:3002

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  Production server running                       ║
echo ║  Dashboard: http://localhost:3002                ║
echo ╚══════════════════════════════════════════════════╝
echo.
pause

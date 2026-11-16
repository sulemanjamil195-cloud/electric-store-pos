@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js 22 LTS first from the official Node.js site. & pause & exit /b 1)
where npm >nul 2>&1 || (echo npm not found. & pause & exit /b 1)
if not exist node_modules (echo Installing project dependencies... & call npm install || (pause & exit /b 1))
call npm run dev
pause

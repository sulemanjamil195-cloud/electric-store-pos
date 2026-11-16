@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (call npm install || (pause & exit /b 1))
call npm run build:win
if errorlevel 1 (echo Build failed. Copy the errors and share them for help.) else (echo Installer should be in the release folder.)
pause

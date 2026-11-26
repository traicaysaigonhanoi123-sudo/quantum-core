@echo off
title QUANTUM CORE // Zero-Trust Quant & Orderflow Terminal
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Khoi dong Zero-Trust Server tai http://127.0.0.1:8787 ...
  start "QUANTUM CORE Server" cmd /c "cd /d "%~dp0" && node server/server.mjs"
  timeout /t 1 /nobreak >nul
  start "" "http://127.0.0.1:8787"
) else (
  echo Khong tim thay Node.js, dang mo truc tiep index.html ...
  start "" "%~dp0index.html"
)

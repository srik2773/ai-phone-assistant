@echo off
rem Double-click launcher for the call dashboard (Windows).
rem Starts the dashboard server and opens it in your browser.
rem Closing this window stops the dashboard.
title Call Dashboard
cd /d "%~dp0.."
node dashboard\server.js
if errorlevel 1 pause

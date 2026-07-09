@echo off
setlocal

set TARGET=%~1
if "%TARGET%"=="" set TARGET=both

if /I "%TARGET%"=="chrome" goto run
if /I "%TARGET%"=="edge" goto run
if /I "%TARGET%"=="firefox" goto run
if /I "%TARGET%"=="both" goto run

echo Usage: %~nx0 [chrome^|edge^|firefox^|both]
exit /b 1

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %TARGET%
exit /b %ERRORLEVEL%

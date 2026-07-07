@echo off
REM HyperFetch Windows setup launcher. Double-click this, or run from a terminal:
REM   setup-windows.bat            (both Chrome and Firefox)
REM   setup-windows.bat chrome     (Chrome only)
REM   setup-windows.bat firefox    (Firefox only)
setlocal
set TARGET=%1
if "%TARGET%"=="" set TARGET=both
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %TARGET%
echo.
pause

@echo off
rem Double-click friendly wrapper: runs setup.ps1 with PowerShell.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause

@echo off
chcp 65001 >nul
title Classroom Live - Reset Server Address
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reset-server.ps1" %*

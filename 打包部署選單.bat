@echo off
cd /d "%~dp0"
title Classroom Live - Build and Deploy Menu
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0build-and-deploy-menu.ps1"

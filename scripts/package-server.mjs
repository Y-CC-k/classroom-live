import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const projectRoot = resolve(__dirname, '..');

const serverSrc = resolve(projectRoot, 'packages/server');
const serverDist = resolve(projectRoot, 'dist-electron/server');

console.log('Packaging server...');

// Clean output
if (existsSync(serverDist)) {
  rmSync(serverDist, { recursive: true, force: true });
}
mkdirSync(serverDist, { recursive: true });

// Copy server source (excluding node_modules, dist, etc.)
const excludeDirs = ['node_modules', 'dist', 'dist-electron', '.git', '.gitignore', '*.log'];
function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeDirs.some(ex => entry.name.match(ex.replace('*', '.*')))) continue;
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

// Re-export readdirSync
const { readdirSync } = await import('fs');

copyDir(serverSrc, serverDist);

console.log(`Server packaged to: ${serverDist}`);

// Create start-server.bat in server folder
const serverStartBat = `@echo off
chcp 65001 >nul
title Classroom Live - Signal Server

cd /d "%~dp0"
echo ==========================================
echo  Classroom Live - Signal Server
echo  Port: 8787
echo ==========================================
echo.

REM Check if port 8787 is in use
netstat -ano | findstr :8787 >nul
if %errorlevel% equ 0 (
    echo [Warning] Port 8787 already in use, trying to kill existing process...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

echo [Starting] Starting signal server...
npm.cmd run start

echo.
echo Server stopped.
pause
`;

import { writeFileSync } from 'fs';
writeFileSync(resolve(serverDist, 'start-server.bat'), serverStartBat);

console.log('Server package created with start-server.bat');

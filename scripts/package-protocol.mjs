import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const projectRoot = resolve(__dirname, '..');

const protocolSrc = resolve(projectRoot, 'packages/protocol');
const protocolDist = resolve(projectRoot, 'dist-electron/protocol');

console.log('Packaging protocol...');

if (existsSync(protocolDist)) {
  rmSync(protocolDist, { recursive: true, force: true });
}
mkdirSync(protocolDist, { recursive: true });

// Copy protocol source
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

const { readdirSync } = await import('fs');
copyDir(protocolSrc, protocolDist);

console.log(`Protocol packaged to: ${protocolDist}`);

/**
 * Electron 應用的共用打包器。
 *
 * 為什麼不用 electron-vite / webpack：
 *   這個專案只有三個進入點（main / preload / renderer），
 *   esbuild 一個檔案就能處理完，而且建置時間是毫秒級。
 *   對「老師按下去就要能用」的課堂軟體來說，啟動速度比工具鏈的完整性重要。
 *
 * 產物結構：
 *   dist/main/index.cjs        （CommonJS，Electron 主行程）
 *   dist/preload/index.cjs     （CommonJS，preload）
 *   dist/renderer/renderer.js  （IIFE，直接給 <script> 載入）
 *   dist/renderer/index.html
 *   dist/renderer/renderer.css
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { context } from 'esbuild';

const TARGETS = [
  { entry: 'src/main/index.ts', outfile: 'dist/main/index.cjs', platform: 'node', format: 'cjs' },
  { entry: 'src/preload/index.ts', outfile: 'dist/preload/index.cjs', platform: 'node', format: 'cjs' },
  { entry: 'src/renderer/renderer.ts', outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' },
];

/** 直接複製、不經打包的靜態資產 */
// 直接複製到 dist 的靜態資產（不存在的自動跳過：teacher 沒有 rules.png）
const STATIC_ASSETS = ['src/renderer/index.html', 'src/renderer/renderer.css', 'src/renderer/rules.png'];

/** 整包複製到 dist/assets/ 的資料夾（不存在的自動跳過：teacher 沒有 clear-browser） */
const STATIC_ASSET_FOLDERS = ['src/assets/clear-browser'];

function esbuildOptions(root, target, dev) {
  return {
    entryPoints: [path.join(root, target.entry)],
    outfile: path.join(root, target.outfile),
    bundle: true,
    format: target.format,
    platform: target.platform,
    target: target.platform === 'node' ? 'node20' : 'chrome122',
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    treeShaking: true,
    legalComments: 'none',
    logLevel: 'warning',
    // Electron 本身由執行環境提供，不能打包進來
    external: target.platform === 'node' ? ['electron'] : [],
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
  };
}

async function copyStatic(root) {
  const outDir = path.join(root, 'dist', 'renderer');
  await mkdir(outDir, { recursive: true });
  for (const asset of STATIC_ASSETS) {
    const from = path.join(root, asset);
    if (!existsSync(from)) continue;
    await cp(from, path.join(outDir, path.basename(asset)));
  }
  // 整包資料夾：dist/assets/<資料夾名>/（主行程以相對 __dirname 定位）
  for (const folder of STATIC_ASSET_FOLDERS) {
    const from = path.join(root, folder);
    if (!existsSync(from)) continue;
    await cp(from, path.join(root, 'dist', 'assets', path.basename(folder)), { recursive: true });
  }
  // 版本戳：哪一次打包、幾點幾分——升級後在記錄裡一眼看出機器跑的是哪版
  const pkgRaw = await readFile(path.join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const builtAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  await writeFile(
    path.join(root, 'dist', 'build-info.json'),
    JSON.stringify({ version: pkg.version ?? '0.0.0', builtAt }, null, 2) + '\n',
    'utf8'
  );
  console.log(`[build] stamp ${pkg.version ?? '?'} @ ${builtAt}`);
}

/**
 * @param {object} options
 * @param {string} options.root  應用套件根目錄
 * @param {boolean} [options.dev] 開發模式（不壓縮、含 sourcemap）
 * @param {boolean} [options.watch] 監看檔案變更
 * @param {boolean} [options.run] 建置完成後啟動 Electron
 */
export async function runApp({ root, dev = false, watch = false, run = false }) {
  if (!dev && !watch) {
    await rm(path.join(root, 'dist'), { recursive: true, force: true });
  }

  const contexts = await Promise.all(TARGETS.map(target => context(esbuildOptions(root, target, dev))));

  if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
  } else {
    await Promise.all(contexts.map(ctx => ctx.rebuild()));
  }
  await copyStatic(root);

  const label = path.basename(root);
  console.log(`[${label}] 已建置 ${TARGETS.length} 個進入點${watch ? '（監看中）' : ''}`);

  if (!run) {
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    return;
  }

  const electron = await resolveElectron(root);
  if (!electron) {
    console.error(`[${label}] 找不到 electron。請先執行 npm install（本機若無網路，Electron 無法下載二進位檔）。`);
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    process.exitCode = 1;
    return;
  }

  const child = spawn(electron, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: dev ? 'development' : 'production' },
  });

  child.on('exit', async code => {
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    process.exit(code ?? 0);
  });
}

async function resolveElectron(root) {
  if (process.env.ELECTRON_BINARY && existsSync(process.env.ELECTRON_BINARY)) {
    return process.env.ELECTRON_BINARY;
  }
  try {
    const imported = await import('electron');
    const binary = typeof imported === 'string' ? imported : imported?.default;
    if (typeof binary === 'string' && existsSync(binary)) return binary;
  } catch {
    // 落到下面回傳 null
  }
  // 允許從執行中的套件往上找
  const local = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  return existsSync(local) ? local : null;
}

/** 供 scripts/build.mjs 直接使用時取得自身目錄 */
export const scriptDir = path.dirname(fileURLToPath(import.meta.url));

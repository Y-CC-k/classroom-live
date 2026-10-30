import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';

/**
 * 伺服機打包腳本。
 *
 * 1. esbuild：把 src/index.ts 連同 @classroom/protocol、ws 打成單一 dist/server.cjs
 *    （純 CommonJS，符合 Node SEA 的要求，也可單獨拿去用 node server.cjs 執行）。
 * 2. Node SEA：把 server.cjs 嵌進 node.exe，產出完全獨立的 classroom-server.exe，
 *    伺服機不需要安裝 Node.js 或任何依賴。
 * 3. 把 exe + config.json 範本放到 dist-electron/server/（與教師機、學生機同一個產出位置）。
 *
 * 用法：
 *   npm run build --workspace @classroom/server   # 只做 esbuild（產 dist/server.cjs）
 *   npm run pack  --workspace @classroom/server   # 打包出單一執行檔 classroom-server.exe
 */

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(pkgDir, '..', '..');
const dist = resolve(pkgDir, 'dist');
const onlyBundle = process.argv.includes('--bundle');

const SEA_CONFIG_JSON = {
  main: 'server.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
};

// SEA 用來辨識 blob 位置的 fuse id（本專案的 postject 版本 sentinel 要給到冒號之前）
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const CONFIG_TEMPLATE = {
  host: '0.0.0.0',
  port: 8787,
  maxStudentsPerRoom: 60,
  heartbeatIntervalMs: 5000,
  heartbeatMissLimit: 3,
  emptyRoomTtlMs: 600000,
  verbose: true,
};

function step(label, fn) {
  console.log(`[server] ${label}...`);
  fn();
}

step('esbuild bundle → dist/server.cjs', () => {
  rmSync(resolve(dist, 'server.cjs'), { force: true });
  mkdirSync(dist, { recursive: true });
  execFileSync(
    process.execPath,
    [
      // esbuild 沒有 bin script 關聯問題，直接用其 CLI js
      resolve(workspaceRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      resolve(pkgDir, 'src', 'index.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node24',
      `--outfile=${resolve(dist, 'server.cjs')}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' }
  );
});

if (onlyBundle) {
  console.log('[server] 只打包 server.cjs（--bundle），不產出執行檔');
  process.exit(0);
}

const exePath = resolve(dist, 'classroom-server.exe');
const seaExe = resolve(dist, 'sea-copy.exe');

step('Node SEA blob', () => {
  writeFileSync(resolve(dist, 'sea-config.json'), JSON.stringify(SEA_CONFIG_JSON, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', resolve(dist, 'sea-config.json')], {
    stdio: 'inherit',
    cwd: dist,
  });
});

step('複製 node.exe 並注入 blob（postject）', () => {
  rmSync(exePath, { force: true });
  rmSync(seaExe, { force: true });
  copyFileSync(process.execPath, seaExe);

  const require2 = createRequire(import.meta.url);
  const postjectPkg = require2.resolve('postject/package.json');
  const postjectCli = resolve(dirname(postjectPkg), 'dist', 'cli.js');
  if (!existsSync(postjectCli)) {
    throw new Error(`postject CLI 找不到：${postjectCli}`);
  }

  execFileSync(
    process.execPath,
    [postjectCli, seaExe, 'NODE_SEA_BLOB', resolve(dist, 'sea-prep.blob'), '--sentinel-fuse', SENTINEL_FUSE],
    { stdio: 'inherit' }
  );

  renameSync(seaExe, exePath);
});

step('輸出至 dist-electron/server', () => {
  const outDir = resolve(workspaceRoot, 'dist-electron', 'server');
  mkdirSync(outDir, { recursive: true });
  rmSync(resolve(outDir, 'classroom-server.exe'), { force: true });
  copyFileSync(exePath, resolve(outDir, 'classroom-server.exe'));
  const configOut = resolve(outDir, 'config.json');
  // 部署 config.json 只在不存在時產生範本，不覆蓋資訊組已改好的值
  if (!existsSync(configOut)) {
    writeFileSync(configOut, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, 'utf8');
  }
  console.log('[server] 完成：', resolve(outDir, 'classroom-server.exe'));
});

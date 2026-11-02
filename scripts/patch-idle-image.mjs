// 暫存修補：待機圖（idle image）遠端更換完整管線
import fs from 'node:fs';

let total = 0;
const root = 'D:/classroom-live';

// ── A1. protocol: CtlMessage 加 idle-image-applied ──
{
  const f = `${root}/packages/protocol/src/datachannel.ts`;
  let c = fs.readFileSync(f, 'utf8');
  const anchor = `  | { t: 'idle-screen'; title: string; text: string }`;
  const add = anchor + `\n  /** 待機圖已在學生機落地：通知 renderer 重取並套用（不動文字欄位） */\n  | { t: 'idle-image-applied' }`;
  if (c.includes(anchor) && !c.includes("'idle-image-applied'")) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    total++;
    console.log('A1 protocol OK');
  } else console.log('A1 SKIP');
}

// ── A2. student ipc.ts ──
{
  const f = `${root}/packages/student/src/shared/ipc.ts`;
  let c = fs.readFileSync(f, 'utf8');
  let p = 0;

  // 2a. StudentConfig 加 idleImagePath
  const cfgAnchor = `  idleTitle?: string;\n  idleText?: string;`;
  const cfgNew = cfgAnchor + `\n  /** 自訂待機底圖路徑（userData 下的 idle-image.*）；空 = 用 App 內建守則海報 */\n  idleImagePath?: string;`;
  if (c.includes(cfgAnchor) && !c.includes('idleImagePath')) {
    c = c.replace(cfgAnchor, cfgNew);
    p++;
  }

  // 2b. IPC 表加 getIdleImage（錨：applyUpdate）
  const ipcAnchor = `  applyUpdate: 'student:apply-update',`;
  const ipcNew = ipcAnchor + `\n  /** 讀取自訂待機底圖（回傳 data URL；未設定回 null） */\n  getIdleImage: 'student:get-idle-image',`;
  if (c.includes(ipcAnchor) && !c.includes('getIdleImage')) {
    c = c.replace(ipcAnchor, ipcNew);
    p++;
  }

  // 2c. StudentApi 加方法（錨：applyUpdate(): ...）
  const apiAnchor = `  applyUpdate(): Promise<{ ok: boolean; reason?: string }>;`;
  const apiNew = apiAnchor + `\n  /** 讀取自訂待機底圖（data URL）；未設定回 null */\n  getIdleImage(): Promise<string | null>;`;
  if (c.includes(apiAnchor) && !c.includes('getIdleImage(): Promise')) {
    c = c.replace(apiAnchor, apiNew);
    p++;
  }

  fs.writeFileSync(f, c, 'utf8');
  total += p;
  console.log(`A2 student ipc.ts: ${p} / 3`);
}

// ── A3. student preload ──
{
  const f = `${root}/packages/student/src/preload/index.ts`;
  let c = fs.readFileSync(f, 'utf8');
  const anchor = `  applyUpdate: () => ipcRenderer.invoke(IPC.applyUpdate) as Promise<{ ok: boolean; reason?: string }>,`;
  const add = anchor + `\n  getIdleImage: () => ipcRenderer.invoke(IPC.getIdleImage) as Promise<string | null>,`;
  if (c.includes(anchor) && !c.includes('getIdleImage')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    total++;
    console.log('A3 preload OK');
  } else console.log('A3 SKIP');
}

// ── A4. student main file-recv.ts：fileEnd 攔截 + getIdleImage handler ──
{
  const f = `${root}/packages/student/src/main/modules/file-recv.ts`;
  let c = fs.readFileSync(f, 'utf8');
  let p = 0;

  // 4a. fileEnd 成功後攔截待機圖（錨：lastStoredFile 設定）
  const endAnchor = `    lastStoredFile = { path: transfer.target, at: Date.now() };\n    return { ok: true, path: transfer.target };`;
  const endNew = `    lastStoredFile = { path: transfer.target, at: Date.now() };

    // 待機圖：「待機畫面.xxx」的圖片檔 → 複製到 userData 並記錄路徑，
    // renderer 待機時顯示（取代 App 內建守則海報）。
    if (/^待機畫面\\.(png|jpe?g|webp)$/i.test(transfer.name)) {
      try {
        const ext = path.extname(transfer.target).toLowerCase();
        const dest = path.join(app.getPath('userData'), \`idle-image\${ext}\`);
        // 清掉不同副檔名的舊圖，避免殘留
        for (const e of ['.png', '.jpg', '.jpeg', '.webp']) {
          const oldPath = path.join(app.getPath('userData'), \`idle-image\${e}\`);
          if (oldPath !== dest && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        fs.copyFileSync(transfer.target, dest);
        saveConfig({ idleImagePath: dest });
        console.log(\`[idle-image] 待機圖已更新：\${dest}\`);
      } catch (error) {
        console.error('[idle-image] 待機圖儲存失敗：', error);
      }
    }
    return { ok: true, path: transfer.target };`;
  if (c.includes(endAnchor) && !c.includes('idle-image`')) {
    c = c.replace(endAnchor, endNew);
    p++;
  }

  // 4b. registerFileIpc 加 getIdleImage handler（錨：appInfo handler 結尾）
  const handlerAnchor = `    saveDir: pickSaveDir() ?? getConfig().fileSaveDir,\n  }));`;
  const handlerNew = `    saveDir: pickSaveDir() ?? getConfig().fileSaveDir,\n  }));\n\n  ipcMain.handle(IPC.getIdleImage, async (): Promise<string | null> => {\n    const imagePath = getConfig().idleImagePath;\n    if (!imagePath || !fs.existsSync(imagePath)) return null;\n    try {\n      const ext = path.extname(imagePath).toLowerCase();\n      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';\n      const data = await fs.promises.readFile(imagePath);\n      return \`data:\${mime};base64,\${data.toString('base64')}\`;\n    } catch {\n      return null;\n    }\n  });`;
  if (c.includes(handlerAnchor) && !c.includes('IPC.getIdleImage')) {
    c = c.replace(handlerAnchor, handlerNew);
    p++;
  }

  fs.writeFileSync(f, c, 'utf8');
  total += p;
  console.log(`A4 file-recv.ts: ${p} / 2`);
}

// ── A5. student renderer ──
{
  const f = `${root}/packages/student/src/renderer/bootstrap.ts`;
  let c = fs.readFileSync(f, 'utf8');
  let p = 0;

  // 5a. els 加 idleRules
  const elsAnchor = `  idleTitle: $<HTMLHeadingElement>('idle-title'),\n  idleText: $<HTMLParagraphElement>('idle-text'),`;
  const elsNew = elsAnchor + `\n  idleRules: $<HTMLImageElement>('idle-rules'),`;
  if (c.includes(elsAnchor) && !c.includes("idleRules:")) {
    c = c.replace(elsAnchor, elsNew);
    p++;
  }

  // 5b. refreshIdleImage 函數（放在 setIdle 函數之後）
  const fnAnchor = `function setBanner(text: string, kind: 'idle' | 'ok' | 'warn' | 'err'): void {`;
  const fnNew = `/** 重取自訂待機底圖（教師端送來的待機畫面.xxx）；無則保持內建守則海報 */\nasync function refreshIdleImage(): Promise<void> {\n  try {\n    const dataUrl = await window.studentApi.getIdleImage();\n    if (dataUrl) {\n      els.idleRules.src = dataUrl;\n      els.idleRules.hidden = false;\n    }\n  } catch {\n    /* 讀不到就維持內建海報 */\n  }\n}\n\n` + fnAnchor;
  if (c.includes(fnAnchor) && !c.includes('async function refreshIdleImage')) {
    c = c.replace(fnAnchor, fnNew);
    p++;
  }

  // 5c. boot 呼叫（錨：els.studentName.value = config.studentName;）
  const bootAnchor = `  els.studentName.value = config.studentName;`;
  const bootNew = bootAnchor + `\n  void refreshIdleImage();`;
  if (c.includes(bootAnchor) && !c.includes('void refreshIdleImage();')) {
    c = c.replace(bootAnchor, bootNew);
    p++;
  }

  // 5d. idle-screen case 也重取圖（新圖可能伴隨文字一起送）
  const idleScreenAnchor = `      if (!broadcastActive) {\n        setIdle(title || '教室直播', text || '已連線，等待教師廣播…');\n      }\n      break;`;
  const idleScreenNew = `      void refreshIdleImage();\n      if (!broadcastActive) {\n        setIdle(title || '教室直播', text || '已連線，等待教師廣播…');\n      }\n      break;`;
  if (c.includes(idleScreenAnchor) && !c.includes('void refreshIdleImage();\n      if (!broadcastActive)')) {
    c = c.replace(idleScreenAnchor, idleScreenNew);
    p++;
  }

  // 5e. handleControl 加 case 'idle-image-applied'（錨：case 'watch'）
  const watchAnchor = `    case 'watch': {`;
  const appliedCase = `    case 'idle-image-applied':\n      // 老師送來的新待機圖已落地：重取並套用\n      void refreshIdleImage();\n      break;\n\n` + watchAnchor;
  if (c.includes(watchAnchor) && !c.includes("case 'idle-image-applied'")) {
    c = c.replace(watchAnchor, appliedCase);
    p++;
  }

  fs.writeFileSync(f, c, 'utf8');
  total += p;
  console.log(`A5 student renderer: ${p} / 5`);
}

// ── A6. teacher file-transfer.ts：sendIdleImage ──
{
  const f = `${root}/packages/teacher/src/renderer/webrtc/file-transfer.ts`;
  let c = fs.readFileSync(f, 'utf8');
  const anchor = `  /** 對單一台送檔（走該台的檔案通道） */`;
  const add = `  /**
   * 更換學生機待機底圖：把圖片以固定檔名「待機畫面.xxx」送出，
   * 學生機落地後存進 userData 並自動套用（取代內建守則海報）。
   * 回傳已開始送出的台數。
   */
  sendIdleImage(file: File): number {
    const ext = (file.name.match(/\\.(png|jpe?g|webp)$/i)?.[0] ?? '.png').toLowerCase();
    const renamed = new File([file], \`待機畫面\${ext}\`, { type: file.type });
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.file?.readyState === 'open') {
        void this.deliverFiles(peerId, link.file, [renamed]);
        sent++;
      }
    }
    return sent;
  }

` + anchor;
  if (c.includes(anchor) && !c.includes('sendIdleImage')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    total++;
    console.log('A6 file-transfer OK');
  } else console.log('A6 SKIP');
}

// ── A7. teacher session.ts：sendIdleImageAll ──
{
  const f = `${root}/packages/teacher/src/renderer/webrtc/session.ts`;
  let c = fs.readFileSync(f, 'utf8');
  const anchor = `  setIdleScreenAll(title: string, text: string): number {`;
  const add = `  /**
   * 更換所有已連線學生機的待機底圖。
   * 圖片走檔案通道（固定檔名「待機畫面.xxx」），學生機落地後自動套用。
   * 回傳已開始送出的台數。
   */
  sendIdleImageAll(file: File): number {
    return this.fileTransferManager.sendIdleImage(file);
  }

` + anchor;
  if (c.includes(anchor) && !c.includes('sendIdleImageAll')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    total++;
    console.log('A7 session OK');
  } else console.log('A7 SKIP');
}

// ── A8. teacher broadcast.ts：file-result 待機圖偵測 ──
{
  const f = `${root}/packages/teacher/src/renderer/webrtc/broadcast.ts`;
  let c = fs.readFileSync(f, 'utf8');
  const anchor = `          // 熱更新：若收到的是升級包（檔名含「升級包」的 .zip），通知學生機套用並重啟`;
  const add = `          // 待機圖落地：通知學生端重取並套用（檔名固定「待機畫面.xxx」）\n          if (/^待機畫面\\./i.test(parsed.name ?? '')) {\n            this.sendCtl(peerId, { t: 'idle-image-applied' });\n            this.options.onLog('info', \`\${link.state.info.name} 待機圖已套用\`);\n          }\n` + anchor;
  if (c.includes(anchor) && !c.includes('idle-image-applied')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    total++;
    console.log('A8 broadcast OK');
  } else console.log('A8 SKIP');
}

// ── A9. teacher bootstrap.ts：els + 綁定 ──
{
  const f = `${root}/packages/teacher/src/renderer/bootstrap.ts`;
  let c = fs.readFileSync(f, 'utf8');
  let p = 0;

  // 9a. els（錨：btnIdleScreen）
  const elsAnchor = `  btnIdleScreen: $<HTMLButtonElement>('btn-idle-screen'),`;
  const elsNew = elsAnchor + `\n  idleImageInput: $<HTMLInputElement>('idle-image-input'),\n  btnIdleImage: $<HTMLButtonElement>('btn-idle-image'),\n  idleImageLabel: $<HTMLSpanElement>('idle-image-label'),`;
  if (c.includes(elsAnchor) && !c.includes('idleImageInput')) {
    c = c.replace(elsAnchor, elsNew);
    p++;
  }

  // 9b. 綁定（錨：待機畫面已送出那段之後，用 btnIdleScreen listener 結尾）
  const bindAnchor = `    log(
      count > 0 ? 'info' : 'warn',
      \`待機畫面已送出給 \${count} 台學生機（未廣播的台立即顯示；全部存檔，下次開機也顯示）。\`
    );
  });`;
  const bindNew = bindAnchor + `

  // 更換學生機待機底圖：選圖 → 走檔案通道送出（固定檔名「待機畫面.xxx」）
  els.btnIdleImage.addEventListener('click', () => els.idleImageInput.click());
  els.idleImageInput.addEventListener('change', () => {
    const file = els.idleImageInput.files?.[0];
    if (!file) return;
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再更換待機圖。');
      return;
    }
    const count = session.sendIdleImageAll(file);
    els.idleImageLabel.textContent = \`\${file.name} → \${count} 台\`;
    log(
      count > 0 ? 'info' : 'warn',
      \`待機圖已開始送給 \${count} 台；各台落地後自動套用（取代內建守則海報）。\`
    );
    els.idleImageInput.value = '';
  });`;
  if (c.includes(bindAnchor) && !c.includes('btnIdleImage.addEventListener')) {
    c = c.replace(bindAnchor, bindNew);
    p++;
  }

  fs.writeFileSync(f, c, 'utf8');
  total += p;
  console.log(`A9 teacher bootstrap: ${p} / 2`);
}

console.log(`TOTAL: ${total}`);

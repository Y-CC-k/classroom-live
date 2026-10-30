# classroom-live

教室「教師機螢幕直播教學 + 學生機鍵盤滑鼠控制」系統的完整骨架。

---

## 📋 專案概述

本專案是一套 Windows 限定的教室直播教學系統，包含教師機、學生機、信令伺服器與伺服器管理 GUI 四大模組，採用 **TypeScript + Electron + Node.js** 開發，原生層為 C++ / N-API。

### 核心功能

| 模組 | 主要功能 |
|------|----------|
| **教師機** | 螢幕廣播、學生監看、遠端鍵鼠控制、鎖定、檔案傳送、升級、關機/重開機、UWF 遙控 |
| **學生機** | 接收廣播畫面、接受遠端控制、緊急解鎖 (Ctrl+Alt+Shift+Esc)、檔案接收 |
| **伺服器** | 房間（班級）管理、WebRTC 信令轉發、心跳偵測、空房間回收 |
| **伺服器 GUI** | 圖形化啟動/停止伺服器、線上統計監控 |

---

## 2. 目錄結構

```
classroom-live/
├─ docs/                         # 文件說明
│   └─ 教室直播系統_操作與維護說明書.md
├─ packages/
│   ├─ protocol/                 # 共用型別與協定（信令、DataChannel、VK 鍵碼表）
│   ├─ server/                   # 信令伺服器（Node.js + ws）
│   ├─ server-gui/               # 伺服器管理 GUI（Electron）
│   ├─ native/                   # Windows 原生層（C++ N-API：SendInput、低階鉤子）
│   ├─ teacher/                  # 教師機 Electron 應用
│   └─ student/                  # 學生機 Electron 應用
├─ scripts/                      # 建置與部署腳本
│   ├─ electron-build.mjs        # 共用 esbuild 驅動打包器
│   ├─ smoke-server.mjs          # 伺服器協定冒煙測試
│   ├─ smoke-wol.mjs             # Wake-on-LAN 冒煙測試
│   ├─ clean.mjs                 # 清除建置產物
│   ├─ gen-build-menu.mjs        # 打包選單產生器
│   ├─ make-upgrade-pack.mjs     # 學生機升級包製作
│   ├─ copy-native.mjs           # 原生模組複製
│   ├─ package-server.mjs        # 伺服器打包
│   ├─ package-protocol.mjs      # 協定套件打包
│   ├─ smoke-native.mjs          # 原生模組冒煙測試
│   └─ native-check.cjs          # 原生模組載入檢查
├─ tsconfig.base.json            # TypeScript 基礎設定
├─ package.json                  # npm workspaces 根設定
├─ README.md                     # 本文件（開發人員用）
└─ docs\教室直播系統_操作與維護說明書.md  # 使用者操作說明書
```

---

## 3. 安裝與開發環境

### 系統需求

| 項目 | 需求 |
|------|------|
| Node.js | ≥ 20 |
| 作業系統 | Windows 10 / 11（僅支援 Windows） |
| 編譯原生模組 | Visual Studio Build Tools 2022（C++ 桌面開發）＋ Python 3.9+ |
| 執行權限 | 建議以系統管理員身分執行學生機 |

### 安裝步驟

```powershell
# 1. 進入專案目錄
cd D:\classroom-live

# 2. 安裝相依套件（原生模組編譯失敗不會中斷安裝）
npm.cmd install

# 3. 若要編譯原生模組（啟用遠端控制功能）
npm.cmd run build:native
```

> **注意**：本專案使用 `npm.cmd` 而非 `npm`，因為 PowerShell 執行原則可能封鎖 `npm.ps1`。

---

## 4. 開發指令

| 指令 | 說明 |
|------|------|
| `npm.cmd run typecheck` | 檢查所有套件的 TypeScript 類型 |
| `npm.cmd run lint` | 執行 ESLint 程式碼檢查 |
| `npm.cmd run format` | 執行 Prettier 程式碼格式化 |
| `npm.cmd run smoke` | 執行伺服器與 Wake-on-LAN 冒煙測試 |
| `npm.cmd run build` | 建置教師機與學生機 |
| `npm.cmd run build:teacher` | 僅建置教師機 |
| `npm.cmd run build:student` | 僅建置學生機 |
| `npm.cmd run pack:all` | 打包所有安裝包（教師 + 學生 + 伺服器 GUI） |
| `npm.cmd run make-upgrade-pack` | 製作學生機升級包 |

### 開發模式啟動

```powershell
# 啟動伺服器
npm.cmd run dev:server

# 啟動教師機
npm.cmd run dev:teacher

# 啟動學生機
npm.cmd run dev:student

# 啟動伺服器 GUI
npm.cmd run dev:server-gui
```

---

## 5. 升級包製作

若要將新版本發給學生機，請：

```powershell
# 1. 先重新建置學生機
npm.cmd run build:student

# 2. 製作升級包
npm.cmd run make-upgrade-pack
```

產出的 `學生機升級包 vX.Y.Z.zip` 可透過教師機「送檔／升級」功能推送給各台學生機，學生機收到後會自動解壓覆蓋 `resources\app` 並重啟。

---

## 6. 目錄架構說明

| 目錄 | 說明 |
|------|------|
| `packages/protocol/` | 共用通訊協定與型別（供伺服器與兩端 Electron 共用） |
| `packages/server/` | 信令伺服器（Node.js + ws，只轉發 SDP/ICE） |
| `packages/server-gui/` | Electron 包裝的伺服器管理 GUI |
| `packages/native/` | Windows 原生層（SendInput 注入 + 低階鉤子） |
| `packages/teacher/` | 教師機 Electron 應用 |
| `packages/student/` | 學生機 Electron 應用 |
| `scripts/` | 建置、打包、煙霧測試腳本 |
| `docs/` | 操作與維護說明書 |

---

## 7. 法律與倫理注意事項

遠端控制他人電腦是**高風險能力**，誤用可能觸法。請務必：

1. **取得明確同意**：學生（及其法定代理人，若未成年）必須事前告知並同意裝置可能被遠端檢視與控制。學生端程式有 `allowRemoteControl` 開關，應預設關閉或由學生自行開啟。
2. **保留緊急解鎖**：`Ctrl+Alt+Shift+Esc` 不可被停用，且解鎖行為要能即時通知使用者。
3. **僅在受控環境使用**：限於自有／已受管理的教學裝置，不可安裝在他人未授權的機器上。
4. **遵守當地法規**：可能涉及《刑法》妨害電腦使用罪、個人資料保護法、歐盟 GDPR 等；請諮詢法務。
5. **資料最小化**：畫面與輸入事件屬敏感資料，請勿錄存或外流。

本專案以「教學與研究」為目的提供，作者不對任何誤用負責。

---

## 10. 授權

本骨架未附授權條款，預設保留所有權利。若要公開發布，請自行加上適合的授權（例如 MIT），並確認已遵守所有第三方程式庫的授權。

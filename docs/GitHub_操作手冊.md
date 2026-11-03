# classroom-live GitHub 操作手冊

本手冊適用於 Windows 環境，適用於 `classroom-live` 專案的完整 Git 與 GitHub 上傳流程。

---

## 目錄

1. [前置準備：安裝 Git](#前置準備安裝-git)
2. [步驟一：初始化本地 Git 儲存庫](#步驟一初始化本地-git-儲存庫)
3. [步驟二：設定 Git 使用者資訊](#步驟二設定-git-使用者資訊)
4. [步驟三：建立 .gitignore（排除大檔案）](#步驟三建立-gitignore排除大檔案)
5. [步驟四：加入檔案並 Commit](#步驟四加入檔案並-commit)
6. [步驟五：在 GitHub 上建立遠端倉庫](#步驟五在-github-上建立遠端倉庫)
7. [步驟六：連接遠端並推送](#步驟六連接遠端並推送)
8. [常見問題排查](#常見問題排查)
9. [後續維護指令](#後續維護指令)

---

## 1. 前置準備：安裝 Git

### 1.1 下載與安裝

1. 前往 [Git 官方下載頁面](https://git-scm.com/download/win)
2. 下載對應版本的安裝程式（建議 64-bit Git for Windows Setup）
3. 執行安裝程式，一路點擊「Next」，關鍵選項建議如下：
   - **PATH**：選擇 `Git from the command line and also from 3rd-party software`（**重要**，這樣 PowerShell 才能認得 `git` 指令）
   - **HTTPS transport**：選擇 `Use the OpenSSL library`
   - **Line endings**：選擇 `Checkout Windows-style, commit Unix-style line endings`
4. 安裝完成後，**關閉並重新開啟 PowerShell 視窗**（讓 PATH 環境變數生效）

### 1.2 驗證安裝

在 PowerShell 中執行：

```powershell
git --version
```

若顯示類似 `git version 2.xx.x.windows.x` 即代表安裝成功。

---

## 2. 步驟一：初始化本地 Git 儲存庫

在專案根目錄下執行：

```powershell
cd D:\classroom-live
git init
```

執行成功後會看到類似訊息：

```
Initialized empty Git repository in D:/classroom-live/.git/
```

---

## 3. 步驟二：設定 Git 使用者資訊

第一次使用 Git 時需要設定全域使用者資訊（只需設定一次）：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的 email@example.com"
```

### 驗證設定

```powershell
git config --global --list
```

---

## 4. 步驟三：建立 .gitignore（排除大檔案）

為了避免 Electron 打包後的 `.exe` 安裝程式超過 GitHub 100 MB 限制，必須建立 `.gitignore` 排除大檔案與建置輸出。

在 `D:\classroom-live` 下建立 `.gitignore`：

```powershell
@"
# Electron 打包輸出（大檔案，不納入版本控制）
dist-electron/

# Node 模組
node_modules/

# 建置輸出
packages/*/dist/
packages/*/build/

# 日誌
*.log
*.zip

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
"@ | Out-File -Encoding utf8 .gitignore
```

確認檔案已建立：

```powershell
dir .gitignore
```

---

## 5. 步驟四：加入檔案並 Commit

### 5.1 查看目前變更狀態

```powershell
git status
```

### 5.2 加入所有檔案到暫存區

```powershell
git add -A
```

### 5.3 建立 Commit

```powershell
git commit -m "feat: complete P2-2 H.264 hardware codec + P2-3 adaptive quality + P0-2 native prebuild + fix upgrade flow

- H.264 硬體編碼預設開啟，連線時自動偵測並排到編碼偏好第一名
- 自適應畫質管理，監控網路狀況自動調整編碼參數，手動調整時自動關閉
- 原生模組預編譯支援，新增 build:prebuild 腳本與 CI job
- 修復 upgradePackageNames 跨模組不一致，apply-update 現在能正常觸發學生端重啟
- 新增 E2E 測試架構 (playwright config, helpers, basic test, CI job)"
```

### 5.4 確認 Commit 成功

```powershell
git log --oneline -5
```

---

## 6. 步驟五：在 GitHub 上建立遠端倉庫

請在瀏覽器開啟 [GitHub](https://github.com) 並執行：

1. 登入你的 GitHub 帳號（例如 `Y-CC-k`）
2. 點擊右上角 `+` → **New repository**
3. Repository name 填寫：`classroom-live`
4. 選擇 **Private** 或 **Public**（依需求）
5. **不要勾選** "Add a README file"（因為本地已有檔案，勾選會造成衝突）
6. 點擊 **Create repository**

建立完成後，GitHub 會顯示遠端網址，例如：

```
https://github.com/Y-CC-k/classroom-live.git
```

請記下這個網址，後續步驟會用到。

---

## 7. 步驟六：連接遠端並推送

### 7.1 連接遠端倉庫

將 `Y-CC-k` 替換為你的 GitHub 帳號名稱：

```powershell
git remote add origin https://github.com/Y-CC-k/classroom-live.git
```

### 7.2 設定主分支名稱

```powershell
git branch -M main
```

### 7.3 推送到 GitHub

```powershell
git push -u origin main
```

### 7.4 確認推送成功

執行：

```powershell
git log --oneline -3
```

然後開啟瀏覽器前往：

```
https://github.com/Y-CC-k/classroom-live
```

應該可以看到所有檔案已經上傳完成。

---

## 8. 常見問題排查

### 問題 A：推送失敗，大檔案超過 100 MB

**錯誤訊息範例：**

```
remote: error: File dist-electron/student/win-unpacked/教室直播 — 學生機.exe is 180.07 MB; this exceeds GitHub's file size limit of 100.00 MB
remote: error: GH001: Large files detected.
```

**解決方案：**

1. 從 Git 追蹤中移除已加入的大檔案：

```powershell
git rm -r --cached dist-electron/
git rm -r --cached packages/*/dist/
git rm -r --cached packages/*/build/
```

2. 重新 Commit：

```powershell
git add -A
git commit -m "fix: exclude large Electron installer binaries from Git tracking"
```

3. 再次推送：

```powershell
git push -u origin main
```

> 電子安裝程式 `.exe` 建議透過 **GitHub Releases** 分發，不適合直接放在 Git 儲存庫。

---

### 問題 B：推送時要求輸入使用者名稱與密碼

GitHub 已停止支援直接使用密碼進行 HTTPS 推送，請使用 **Personal Access Token (PAT)**：

1. 在 GitHub 上：Settings → Developer settings → Personal access tokens → Tokens (classic)
2. 點擊 **Generate new token (classic)**
3. 勾選 `repo` 權限
4. 複製產生的 Token
5. 推送時在密碼欄位貼上該 Token（不會顯示字元，直接按 Enter）

---

### 問題 C：`git` 指令不被認識

確認已安裝 Git 並勾選了「Git from the command line and also from 3rd-party software」，然後**重新開啟 PowerShell 視窗**。

---

### 問題 D：遠端倉庫已有檔案，推送衝突

如果遠端倉庫已經有檔案（例如誤勾選了 README），請先拉取再推送：

```powershell
git pull origin main --allow-unrelated-histories
git push -u origin main
```

---

## 9. 後續維護指令

### 查看提交歷史

```powershell
git log --oneline
```

### 查看目前狀態

```powershell
git status
```

### 查看修改內容（未 commit）

```powershell
git diff
```

### 撤銷暫存區的檔案

```powershell
git reset HEAD <檔案名稱>
```

### 將本地分支推送到遠端（後續變更）

```powershell
git add -A
git commit -m "你的提交訊息"
git push
```

### 從遠端拉取最新程式碼

```powershell
git pull
```

---

## 10. 快速參考：完整流程一覽

| 步驟       | 指令                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| 初始化     | `git init`                                                                         |
| 設定使用者 | `git config --global user.name "名字"`<br>`git config --global user.email "email"` |
| 建立忽略檔 | 建立 `.gitignore`                                                                  |
| 加入檔案   | `git add -A`                                                                       |
| 提交       | `git commit -m "訊息"`                                                             |
| 連接遠端   | `git remote add origin https://github.com/Y-CC-k/classroom-live.git`               |
| 設定分支   | `git branch -M main`                                                               |
| 推送       | `git push -u origin main`                                                          |

---

> 💡 **提示**：建議在每次完成重要功能後都進行 Commit，這樣可以隨時回到之前正常運作的版本，也方便與團隊成員協作。

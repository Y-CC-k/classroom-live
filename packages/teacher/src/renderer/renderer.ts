/**
 * 教師機 renderer 進入點。
 *
 * 為了維護性，實作已拆分到：
 *   - bootstrap.ts：應用程式初始化、事件綁定、主要邏輯
 *   - ui/elements.ts：DOM 元素快取
 *   - ui/monitor-viewer.ts：監看視窗
 *   - broadcast.ts：廣播控制
 *   - connection.ts：連線管理
 *
 * 本檔案作為 barrel file，重新匯出所有模組。
 */

export * from './bootstrap.js';

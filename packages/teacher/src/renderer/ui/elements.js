// elements.js – 彙總所有 DOM 元素給 UI module 使用
// 由 bootstrap.ts 在 page-load 時 populate（elems → els）

/** 所有靠「id=」掛載的 DOM 元素 */
export const els: Record<string, HTMLElement> = {};

/** 在 bootstrap.ts 填入：  els.monitorViewer = document.getElementById('monitorViewer') 等 */
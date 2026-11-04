import { type TeacherSession } from '../webrtc/session.js';
import { els } from './elements.js';

/** 當前正在監看的學生機（一次一台；null = 沒有在監看） */
export let watchingPeer: string | null = null;
/** 監看窗顯示中的物件 URL（換幀時要收掉避免洩漏） */
export let monitorUrl: string | null = null;

/** 勾選要進行「單機功能」的學生機（卡片勾選框；勾選名單獨立於廣播名單） */
export const checkedPeers = new Set<string>();

/** 把 RTCPeerConnection 的狀態翻成中文。 */
export function connectionLabel(state: RTCPeerConnectionState | 'idle'): string {
  switch (state) {
    case 'idle':
      return '未開始';
    case 'new':
      return '建立中';
    case 'connecting':
      return '連線中';
    case 'connected':
      return '已連線';
    case 'disconnected':
      return '已中斷';
    case 'failed':
      return '失敗';
    case 'closed':
      return '已關閉';
    default:
      return String(state);
  }
}

/** 關閉監看：通知學生機停止送圖、收掉浮動窗 */
export function closeMonitor(session: TeacherSession): void {
  if (watchingPeer && session.isConnected) session.watchStudent(watchingPeer, false);
  watchingPeer = null;
  if (monitorUrl) {
    URL.revokeObjectURL(monitorUrl);
    monitorUrl = null;
  }
  els.monitorViewer.hidden = true;
  els.monitorImg.src = '';
}

/** 收到一幀監看畫面：只顯示還在監看的那台（不是的話直接丟掉） */
export function showMonitorFrame(
  peerId: string,
  frame: { url: string; width: number; height: number; seq: number }
): void {
  if (watchingPeer !== peerId) {
    URL.revokeObjectURL(frame.url);
    return;
  }
  if (monitorUrl) URL.revokeObjectURL(monitorUrl);
  monitorUrl = frame.url;
  els.monitorImg.src = frame.url;
  els.monitorMeta.textContent = `第 ${frame.seq} 張 · ${frame.width}×${frame.height} · 3 秒/張`;
}

/** 開始監看勾選的那一台（單機功能列的「👁 監看」按鈕） */
export function toggleWatchChecked(session: TeacherSession): void {
  if (!session.isConnected) {
    els.log.prepend(document.createTextNode('尚未連線；請先按「連線」再監看。'));
    return;
  }
  if (checkedPeers.size !== 1) {
    els.log.prepend(document.createTextNode(`監看一次一台：請只勾選一台（目前已勾 ${checkedPeers.size} 台）。`));
    return;
  }
  const peerId = [...checkedPeers][0]!;
  const student = session.students().find(item => item.info.id === peerId);
  if (!student) {
    els.log.prepend(document.createTextNode('這台已經離線了。'));
    return;
  }
  if (watchingPeer === peerId) {
    closeMonitor(session);
    els.log.prepend(document.createTextNode('已停止監看。'));
    renderStudents(session);
    return;
  }
  // 換台：先通知上一台停止，避免兩台同時送圖
  closeMonitor(session);
  if (!session.watchStudent(peerId, true, 3000)) {
    els.log.prepend(document.createTextNode('監看送出失敗：控制通道還沒連上這台。'));
    return;
  }
  watchingPeer = peerId;
  els.monitorViewer.hidden = false;
  els.monitorLabel.textContent = `監看中：${student.info.name}`;
  els.monitorMeta.textContent = '等待第一張畫面…（3 秒/張）';
  els.log.prepend(document.createTextNode(`已開始監看 ${student.info.name}（每 3 秒一張，關閉浮動窗即停止）。`));
  renderStudents(session);
}

/** 勾選要進行「單機功能」的學生機（卡片勾選框；勾選名單獨立於廣播名單） */
export function updateStudentBar(): void {
  const count = checkedPeers.size;
  els.perStudentBar.hidden = count === 0;
  els.checkedCount.textContent = `已選 ${count} 台`;
}

function tag(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** 渲染學生清單 */
export function renderStudents(session: TeacherSession): void {
  const students = session.students();
  els.studentCount.textContent = String(students.length);
  els.emptyStudents.hidden = students.length > 0;

  // 直播狀態：有指定名單時表頭出現「回到全班」按鈕
  const targets = session.getBroadcastTargets();
  if (targets) {
    const names =
      students
        .filter(student => targets.has(student.info.id))
        .map(student => student.info.name)
        .join('、') || `${targets.size} 台`;
    els.broadcastTargetLabel.textContent = names.length > 30 ? `${names.slice(0, 30)}…` : names;
    els.btnBroadcastAll.hidden = false;
  } else {
    els.btnBroadcastAll.hidden = true;
  }
  // 台數多時提示畫質：延遲主要是教師機編碼負載，降畫質與硬體編碼是最有效的兩件事
  els.scaleHint.hidden = students.length < 15;
  if (students.length >= 20) {
    els.scaleHint.textContent =
      '⚠ 已超過 19 台：建議把畫質降到「講課簡報（5fps）」或「每秒 2 張」，並開啟 H.264 硬體編碼，否則教師機編碼會塞車、畫面延遲會變大。';
  } else if (students.length >= 15) {
    els.scaleHint.textContent = '⚠ 學生機已 15 台以上：若發現延遲變大，先降畫質或確認已開啟 H.264 硬體編碼。';
  } else {
    els.scaleHint.textContent = '';
  }
  els.studentGrid.replaceChildren();

  // 勾選名單跟著現在一波清單修整：已下線的台自動移出勾選
  const peerIds = new Set(students.map(student => student.info.id));
  for (const id of [...checkedPeers]) {
    if (!peerIds.has(id)) checkedPeers.delete(id);
  }
  updateStudentBar();

  // 正在監看的那台離線了：自動收掉監看（避免窗一直停在舊畫面）
  if (watchingPeer && !peerIds.has(watchingPeer)) {
    const name = students.find(item => item.info.id === watchingPeer)?.info.name ?? watchingPeer;
    closeMonitor(session);
    els.log.prepend(document.createTextNode(`監看的學生機（${name}）已離線，監看窗已自動關閉。`));
  }
  refreshSceneButtons(session);

  for (const student of students) {
    const card = document.createElement('div');
    card.className = 'card';

    // 勾選框：勾起來的台才能用「單機功能列」（中欄最下方）
    const peerId = student.info.id;
    const pickLine = document.createElement('div');
    pickLine.className = 'pick-line';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.title = '勾選後可用最下方的單機功能列（點卡片也可以勾／取消）';
    pick.checked = checkedPeers.has(peerId);
    pick.addEventListener('change', () => {
      if (pick.checked) checkedPeers.add(peerId);
      else checkedPeers.delete(peerId);
      card.classList.toggle('checked', pick.checked);
      updateStudentBar();
    });
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = student.info.name;
    name.title = `${student.info.name} (${student.info.id})`;
    pickLine.append(pick, name);
    // 點卡片任意處＝切換勾選（點勾選框本身除外）
    card.addEventListener('click', event => {
      if (event.target === pick) return;
      pick.checked = !pick.checked;
      pick.dispatchEvent(new Event('change'));
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const broadcasting = Boolean(session.getLocalStream());
    const videoArrived = broadcasting && student.broadcastState === 'connected';
    const broadcastText = videoArrived
      ? '畫面已送達'
      : broadcasting
        ? `廣播：${connectionLabel(student.broadcastState)}`
        : targets?.has(peerId) === false
          ? '直播排除'
          : '未廣播';

    const broadcastTagClass = videoArrived ? 'tag ok' : targets?.has(peerId) === false ? 'tag' : 'tag';
    meta.append(tag(broadcastText, broadcastTagClass));
    if (session.lockActive || session.controlManager.lockedPeers.has(student.info.id) || session.isPeerLocked(student.info.id)) meta.append(tag('已鎖定', 'tag err'));
    if (watchingPeer === peerId) meta.append(tag('👁 正在監看', 'tag ok'));
    if (student.lastError) meta.append(tag(`錯誤：${student.lastError}`, 'tag err'));

    card.append(pickLine, meta);
    if (pick.checked) card.classList.add('checked');
    els.studentGrid.append(card);
  }
}

/** 教學活動場景：廣播中＋全班鎖定＋全班靜音 */
export function refreshSceneButtons(session: TeacherSession): void {
  const teaching = Boolean(session.getLocalStream()) && Boolean(session.lockActive) && Boolean(session.muteActive);
  const learning = !session.getLocalStream() && !session.lockActive && !session.muteActive;
  els.btnSceneTeach.classList.toggle('primary', teaching);
  els.btnSceneTeach.classList.toggle('ghost', !teaching);
  els.btnSceneLearn.classList.toggle('primary', learning);
  els.btnSceneLearn.classList.toggle('ghost', !learning);
}

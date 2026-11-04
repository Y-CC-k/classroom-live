// webrtc 模組入口
export type {
  TeacherSessionOptions,
  TeacherSessionEvents,
  StudentState,
  Link,
  WatchFrameAssembly,
  ImagePumpStats,
  ScreenMeta,
} from './types.js';

export { TeacherSession } from './session.js';
export { BroadcastManager } from './broadcast.js';
export { FileTransferManager } from './file-transfer.js';
export { ControlManager } from './lock.js';
export { TargetsManager } from './targets.js';
export { findVideoSender, preferVideoCodecs, tuneSender, describe } from './encoding.js';
export { AdaptiveQualityManager } from './adaptive-quality.js';

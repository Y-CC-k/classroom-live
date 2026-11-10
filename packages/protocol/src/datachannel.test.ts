import { describe, it, expect } from 'vitest';
import type { CtlMessage } from './datachannel.js';

function isModeMsg(msg: CtlMessage): msg is CtlMessage & { t: 'mode'; mode: string } {
  return msg.t === 'mode';
}

describe('protocol/datachannel', () => {
  describe('CtlMessage mode payload', () => {
    it('should accept mode with no constraint fields (backward compatible)', () => {
      const msg: CtlMessage = { t: 'mode', mode: 'control' };
      expect(msg.t).toBe('mode');
      if (isModeMsg(msg)) {
        expect(msg.mode).toBe('control');
        expect((msg as any).maxFramerate).toBeUndefined();
      }
    });

    it('should accept mode with maxFramerate constraint', () => {
      const msg: CtlMessage = { t: 'mode', mode: 'control', maxFramerate: 10 };
      if (isModeMsg(msg)) {
        expect(msg.mode).toBe('control');
        expect((msg as any).maxFramerate).toBe(10);
      }
    });

    it('should accept mode with maxWidth/maxHeight constraints', () => {
      const msg: CtlMessage = {
        t: 'mode',
        mode: 'control',
        maxFramerate: 10,
        maxWidth: 1280,
        maxHeight: 720,
      };
      if (isModeMsg(msg)) {
        expect(msg.mode).toBe('control');
        expect((msg as any).maxFramerate).toBe(10);
        expect((msg as any).maxWidth).toBe(1280);
        expect((msg as any).maxHeight).toBe(720);
      }
    });

    it('should accept mode with monitor mode (exit control)', () => {
      const msg: CtlMessage = { t: 'mode', mode: 'monitor' };
      if (isModeMsg(msg)) {
        expect(msg.mode).toBe('monitor');
      }
    });

    it('should accept mode with lock mode', () => {
      const msg: CtlMessage = { t: 'mode', mode: 'lock' };
      if (isModeMsg(msg)) {
        expect(msg.mode).toBe('lock');
      }
    });
  });
});

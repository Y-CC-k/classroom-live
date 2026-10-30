import { describe, it, expect } from 'vitest';
import { codeToVk, vkToCode, isReservedTeacherKey, PANIC_HOTKEY_LABEL, VK } from './keymap';

describe('protocol/keymap', () => {
  describe('codeToVk', () => {
    it('should map KeyA to VK.A (0x41)', () => {
      expect(codeToVk('KeyA')).toBe(0x41);
    });

    it('should map KeyZ to VK.Z (0x5a)', () => {
      expect(codeToVk('KeyZ')).toBe(0x5a);
    });

    it('should map Digit0 to VK.NUM_0 (0x30)', () => {
      expect(codeToVk('Digit0')).toBe(0x30);
    });

    it('should map Digit9 to VK.NUM_9 (0x39)', () => {
      expect(codeToVk('Digit9')).toBe(0x39);
    });

    it('should map Numpad0 to VK.NUM_0 via numpad mapping (0x60)', () => {
      expect(codeToVk('Numpad0')).toBe(0x60);
    });

    it('should map F1 to 0x70', () => {
      expect(codeToVk('F1')).toBe(0x70);
    });

    it('should map F24 to 0x87', () => {
      expect(codeToVk('F24')).toBe(0x87);
    });

    it('should map Escape to VK.ESCAPE (0x1b)', () => {
      expect(codeToVk('Escape')).toBe(0x1b);
    });

    it('should map Space to VK.SPACE (0x20)', () => {
      expect(codeToVk('Space')).toBe(0x20);
    });

    it('should map Enter to VK.ENTER (0x0d)', () => {
      expect(codeToVk('Enter')).toBe(0x0d);
    });

    it('should return null for unknown codes', () => {
      expect(codeToVk('UnknownKey')).toBeNull();
      expect(codeToVk('')).toBeNull();
    });
  });

  describe('vkToCode', () => {
    it('should map 0x41 back to KeyA', () => {
      expect(vkToCode(0x41)).toBe('KeyA');
    });

    it('should map 0x1b back to Escape', () => {
      expect(vkToCode(0x1b)).toBe('Escape');
    });

    it('should return null for unknown VK', () => {
      expect(vkToCode(0x9999)).toBeNull();
    });
  });

  describe('VK constants', () => {
    it('should have correct BACKSPACE value', () => {
      expect(VK.BACKSPACE).toBe(0x08);
    });

    it('should have correct TAB value', () => {
      expect(VK.TAB).toBe(0x09);
    });

    it('should have correct ENTER value', () => {
      expect(VK.ENTER).toBe(0x0d);
    });

    it('should have correct SPACE value', () => {
      expect(VK.SPACE).toBe(0x20);
    });

    it('should have correct ESCAPE value', () => {
      expect(VK.ESCAPE).toBe(0x1b);
    });

    it('should have correct A value', () => {
      expect(VK.A).toBe(0x41);
    });

    it('should have correct Z value', () => {
      expect(VK.Z).toBe(0x5a);
    });
  });

  describe('isReservedTeacherKey', () => {
    it('should return true for F11', () => {
      expect(isReservedTeacherKey({ code: 'F11', ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    });

    it('should return true for F12', () => {
      expect(isReservedTeacherKey({ code: 'F12', ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    });

    it('should return true for Ctrl+W', () => {
      expect(isReservedTeacherKey({ code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    });

    it('should return true for Ctrl+R', () => {
      expect(isReservedTeacherKey({ code: 'KeyR', ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    });

    it('should return true for Ctrl+T', () => {
      expect(isReservedTeacherKey({ code: 'KeyT', ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    });

    it('should return true for Ctrl+Alt+Shift (panic hotkey)', () => {
      expect(isReservedTeacherKey({ code: 'KeyA', ctrlKey: true, altKey: true, shiftKey: true })).toBe(true);
    });

    it('should return false for normal key A', () => {
      expect(isReservedTeacherKey({ code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    });

    it('should return false for Ctrl+A (not W/R/T)', () => {
      expect(isReservedTeacherKey({ code: 'KeyA', ctrlKey: true, altKey: false, shiftKey: false })).toBe(false);
    });
  });

  describe('PANIC_HOTKEY_LABEL', () => {
    it('should be "Ctrl + Alt + Shift + Esc"', () => {
      expect(PANIC_HOTKEY_LABEL).toBe('Ctrl + Alt + Shift + Esc');
    });
  });
});

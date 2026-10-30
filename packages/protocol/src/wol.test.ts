import { describe, it, expect } from 'vitest';
import { normalizeMac, buildMagicPacket, subnetBroadcast } from './wol';

describe('protocol/wol', () => {
  describe('normalizeMac', () => {
    it('should normalize aa:bb:cc:dd:ee:ff to lowercase', () => {
      expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('should normalize uppercase MAC', () => {
      expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('should normalize mixed case MAC', () => {
      expect(normalizeMac('Aa:Bb:Cc:Dd:Ee:Ff')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('should normalize MAC with dash separators', () => {
      expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('should normalize MAC with dot separators', () => {
      expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('should return null for all zeros MAC', () => {
      expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    });

    it('should return null for all f MAC', () => {
      expect(normalizeMac('ff:ff:ff:ff:ff:ff')).toBeNull();
    });

    it('should return null for invalid length', () => {
      expect(normalizeMac('aa:bb:cc')).toBeNull();
      expect(normalizeMac('aa:bb:cc:dd:ee:ff:00')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(normalizeMac('')).toBeNull();
    });

    it('should return null for undefined', () => {
      expect(normalizeMac('')).toBeNull();
    });
  });

  describe('buildMagicPacket', () => {
    it('should produce a 102 byte packet', () => {
      const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff');
      expect(packet).not.toBeNull();
      expect(packet!.length).toBe(102);
    });

    it('should start with 6 bytes of 0xff', () => {
      const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff')!;
      for (let i = 0; i < 6; i++) {
        expect(packet[i]).toBe(0xff);
      }
    });

    it('should repeat MAC 16 times after header', () => {
      const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff')!;
      const macBytes = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
      for (let repeat = 0; repeat < 16; repeat++) {
        for (let i = 0; i < 6; i++) {
          expect(packet[6 + repeat * 6 + i]).toBe(macBytes[i]);
        }
      }
    });

    it('should return null for invalid MAC', () => {
      expect(buildMagicPacket('invalid')).toBeNull();
      expect(buildMagicPacket('00:00:00:00:00:00')).toBeNull();
    });

    it('should accept mixed case MAC', () => {
      const packet = buildMagicPacket('AA:BB:CC:DD:EE:FF')!;
      expect(packet[6]).toBe(0xaa);
      expect(packet[7]).toBe(0xbb);
    });
  });

  describe('subnetBroadcast', () => {
    it('should compute broadcast for /24', () => {
      expect(subnetBroadcast('192.168.1.20', '255.255.255.0')).toBe('192.168.1.255');
    });

    it('should compute broadcast for /16', () => {
      expect(subnetBroadcast('10.0.0.5', '255.255.0.0')).toBe('10.0.255.255');
    });

    it('should compute broadcast for /8', () => {
      expect(subnetBroadcast('10.0.0.5', '255.0.0.0')).toBe('10.255.255.255');
    });

    it('should return null for invalid IP', () => {
      expect(subnetBroadcast('invalid', '255.255.255.0')).toBeNull();
    });

    it('should return null for invalid netmask', () => {
      expect(subnetBroadcast('192.168.1.20', 'invalid')).toBeNull();
    });

    it('should return null for /0 mask', () => {
      expect(subnetBroadcast('192.168.1.20', '0.0.0.0')).toBeNull();
    });
  });
});

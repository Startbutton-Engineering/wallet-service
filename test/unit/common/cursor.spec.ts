import { cursorFingerprint, decodeCursor, encodeCursor } from '../../../src/common/cursor';
import { AppError, ErrorCode } from '../../../src/common/errors';

const FP = cursorFingerprint(['m1', 'NGN', null, null, null, null]);
const raw = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url');

function expectValidation(fn: () => unknown, message?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.VALIDATION_FAILED);
    if (message) expect((err as AppError).message).toContain(message);
    return;
  }
  throw new Error('expected a validation error');
}

describe('cursor', () => {
  describe('cursorFingerprint', () => {
    it('is stable for the same filters and differs when any filter changes', () => {
      expect(cursorFingerprint(['m1', 'NGN', null])).toBe(cursorFingerprint(['m1', 'NGN', null]));
      expect(cursorFingerprint(['m1', 'NGN', null])).not.toBe(cursorFingerprint(['m1', 'NGN', 'payout']));
      expect(cursorFingerprint(['m1', 'NGN', null])).toHaveLength(16);
    });
  });

  describe('round trip', () => {
    it('restores a sequence position', () => {
      const cursor = encodeCursor({ mode: 'sequence', sequence: 42 }, FP);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor, FP)).toEqual({ mode: 'sequence', sequence: 42 });
    });

    it('restores a time position to the millisecond', () => {
      const createdAt = new Date('2026-09-28T10:11:12.345Z');
      const id = '64b7f0c2a1b2c3d4e5f60718';
      const cursor = encodeCursor({ mode: 'time', createdAt, id }, FP);
      expect(decodeCursor(cursor, FP)).toEqual({ mode: 'time', createdAt, id });
    });
  });

  describe('decodeCursor rejects', () => {
    it('a cursor minted under different filters', () => {
      const cursor = encodeCursor({ mode: 'sequence', sequence: 1 }, FP);
      expectValidation(() => decodeCursor(cursor, cursorFingerprint(['other'])), 'does not match');
    });

    it('garbage that is not base64 JSON', () => {
      expectValidation(() => decodeCursor('%%%not-a-cursor', FP), 'Invalid cursor');
    });

    it('JSON that is not an object', () => {
      expectValidation(() => decodeCursor(raw(null), FP), 'Invalid cursor');
      expectValidation(() => decodeCursor(raw(7), FP), 'Invalid cursor');
    });

    it('an unknown version', () => {
      expectValidation(() => decodeCursor(raw({ v: 2, f: FP, m: 's', s: 1 }), FP), 'Invalid cursor');
    });

    it('a tampered sequence', () => {
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 's', s: '1' }), FP), 'Invalid cursor');
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 's', s: 1.5 }), FP), 'Invalid cursor');
    });

    it('a tampered time position', () => {
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 't', t: 'x', i: '64b7f0c2a1b2c3d4e5f60718' }), FP));
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 't', t: 1, i: 'not-an-id' }), FP));
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 't', t: 1, i: 5 }), FP));
    });

    it('an unknown mode', () => {
      expectValidation(() => decodeCursor(raw({ v: 1, f: FP, m: 'x' }), FP), 'Invalid cursor');
    });
  });
});

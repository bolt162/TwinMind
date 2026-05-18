import { describe, it, expect } from 'vitest';
import {
  assertTransition,
  canTransition,
  ChunkStateError,
  CHUNK_STATES,
  ELIGIBLE_FOR_UPLOAD,
  isTerminal,
} from '@core/state/ChunkState';

describe('ChunkState FSM', () => {
  it('enumerates exactly the six architected states', () => {
    expect(CHUNK_STATES).toEqual([
      'captured',
      'uploading',
      'transcribed',
      'completed',
      'failed_retry',
      'failed_permanent',
    ]);
  });

  describe('canTransition', () => {
    it.each([
      ['captured', 'uploading', true],
      ['uploading', 'transcribed', true],
      ['uploading', 'failed_retry', true],
      ['uploading', 'failed_permanent', true],
      ['transcribed', 'completed', true],
      ['failed_retry', 'uploading', true],
      ['failed_retry', 'failed_permanent', true],
    ] as const)('allows %s → %s', (from, to, expected) => {
      expect(canTransition(from, to)).toBe(expected);
    });

    it.each([
      // Cannot skip uploading and go straight to transcribed.
      ['captured', 'transcribed'],
      // Cannot resurrect from terminal states.
      ['completed', 'uploading'],
      ['failed_permanent', 'uploading'],
      ['completed', 'failed_retry'],
      // No-op self-loops are not allowed either.
      ['captured', 'captured'],
    ] as const)('rejects %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });
  });

  it('assertTransition throws ChunkStateError with from/to attached', () => {
    try {
      assertTransition('completed', 'uploading');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ChunkStateError);
      expect((e as ChunkStateError).from).toBe('completed');
      expect((e as ChunkStateError).to).toBe('uploading');
    }
  });

  it('identifies terminal states correctly', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed_permanent')).toBe(true);
    expect(isTerminal('captured')).toBe(false);
    expect(isTerminal('uploading')).toBe(false);
    expect(isTerminal('transcribed')).toBe(false);
    expect(isTerminal('failed_retry')).toBe(false);
  });

  it('upload-eligibility set matches captured + failed_retry', () => {
    // This must match the SQL predicate in UploadQueue (§11.1) — drift here is
    // the kind of bug that silently strands chunks forever.
    expect([...ELIGIBLE_FOR_UPLOAD].sort()).toEqual(['captured', 'failed_retry']);
  });
});

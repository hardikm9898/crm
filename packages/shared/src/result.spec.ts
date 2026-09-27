import { describe, expect, it } from 'vitest';
import { err, isOk, ok, partition, unwrapOr } from './result.js';

describe('Result', () => {
  it('distinguishes success from failure', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err(new Error('x')))).toBe(false);
  });

  it('falls back on failure', () => {
    expect(unwrapOr(err<Error>(new Error('x')), 7)).toBe(7);
    expect(unwrapOr(ok(3), 7)).toBe(3);
  });

  it('partitions a batch for a partial-success response', () => {
    const { succeeded, failed } = partition([ok(1), err('bad row 2'), ok(3), err('bad row 4')]);
    expect(succeeded).toEqual([1, 3]);
    expect(failed).toEqual(['bad row 2', 'bad row 4']);
  });
});

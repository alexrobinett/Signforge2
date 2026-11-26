// The month's Images transformations (#500): taken all or none within a ceiling, in one statement, each month its own.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { imagesMonth, imagesTransformsUsed, takeImagesTransforms } from '../src';

describe("the month's Images transformations", () => {
  it('takes what fits under the ceiling, all or none, and starts again each month', async () => {
    const month = imagesMonth(Date.UTC(2027, 2, 31, 23, 59));
    expect(month).toBe('2027-03');
    expect(await takeImagesTransforms(env.DB, month, 2, 5)).toBe(true);
    expect(await takeImagesTransforms(env.DB, month, 2, 5)).toBe(true);
    // Two more would make 6: neither is taken, though one would fit.
    expect(await takeImagesTransforms(env.DB, month, 2, 5)).toBe(false);
    expect(await takeImagesTransforms(env.DB, month, 1, 5)).toBe(true);
    expect(await takeImagesTransforms(env.DB, month, 1, 5)).toBe(false);
    expect(await imagesTransformsUsed(env.DB, month)).toBe(5);
    const next = imagesMonth(Date.UTC(2027, 3, 1));
    expect(await imagesTransformsUsed(env.DB, next)).toBe(0);
    expect(await takeImagesTransforms(env.DB, next, 2, 5)).toBe(true);
    // A first take past the ceiling counts nothing.
    expect(await takeImagesTransforms(env.DB, '2027-05', 6, 5)).toBe(false);
    expect(await imagesTransformsUsed(env.DB, '2027-05')).toBe(0);
  });

  it('costs one D1 statement a take', async () => {
    const calls: string[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (q: string) => {
      calls.push(q);
      return prepare(q);
    };
    try {
      await takeImagesTransforms(env.DB, '2027-06', 1, 10);
    } finally {
      env.DB.prepare = prepare;
    }
    expect(calls).toHaveLength(1);
  });
});

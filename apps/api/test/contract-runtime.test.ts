// The contract's checks the API runs, in the Worker's own runtime (workerd), where they could differ from Node's.
import { validateSpotData } from '@signforge/contract';
import { describe, expect, it } from 'vitest';

describe('the contract in the Worker runtime', () => {
  // `maxMarks` counts the marks on each character with Intl.Segmenter (review of #448, round 5).
  it('counts the marks on each character, as Node does', () => {
    const fields = { t: { type: 'text' as const, label: 'T', maxMarks: 4 } };
    const joined = `U${`${'̍'.repeat(4)}‍`.repeat(4)}${'̍'.repeat(4)}`;
    expect(validateSpotData(fields, { t: joined }, {})).toEqual(['field "t" stacks more than 4 accents or marks on one character']);
    expect(validateSpotData(fields, { t: 'หนีไฟไปทางนี้ חַיִּ֣ים' }, {})).toEqual([]);
  });
});

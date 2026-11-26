// A smart group's rule in the CMS (#186): conditions as the tools take them, what keeps one from being saved, and the
// screens it matches now, matched as the publish matches them.
import { describe, expect, it } from 'vitest';
import { matching, ruleOf, ruleProblem, termWords, unmet, type RuleTerm } from '../src/lib/rules';

const screen = (name: string, labels: Record<string, string>, orientation = 'landscape') => ({
  name,
  labels,
  systemLabels: { orientation, kind: 'device', timezone: 'UTC' },
});
const SCREENS = [screen('Door', { region: 'North', store: '0142' }), screen('Till', { region: 'south' }), screen('Menu', {}, 'portrait')];
const term = (key: string, op: RuleTerm['op'], ...values: string[]): RuleTerm => ({ key, op, values });

describe('a rule as the builder holds it', () => {
  it('goes to the tools with its values trimmed, and only those its comparison takes', () => {
    expect(ruleOf([term('region', 'eq', ' North ', 'stray'), term('type', 'in', 'kiosk', ' '), term('store', 'missing', 'left over')])).toEqual({
      all: [term('region', 'eq', 'North'), term('type', 'in', 'kiosk'), term('store', 'missing')],
    });
  });

  it('says what keeps it from being saved: no condition, past ten, no label, no value', () => {
    expect(ruleProblem([])).toMatch(/every screen/);
    expect(ruleProblem(Array.from({ length: 11 }, (_, i) => term(`k${i}`, 'exists')))).toBe("A group's rule has at most 10 conditions; this one has 11.");
    expect(ruleProblem([term('', 'eq', 'x')])).toBe('Choose a label for each condition.');
    expect(ruleProblem([term('region', 'eq', '  ')])).toBe('Give region a value.');
    expect(ruleProblem([term('type', 'notin')])).toBe('Choose at least one value of type.');
    expect(ruleProblem([term('region', 'eq', 'north'), term('store', 'exists')])).toBeUndefined();
  });

  it('matches screens as a selector does: case aside, system labels too, and a missing key for "is not set"', () => {
    expect(matching(SCREENS, [term('region', 'eq', 'NORTH')]).map((s) => s.name)).toEqual(['Door']);
    expect(matching(SCREENS, [term('orientation', 'eq', 'portrait')]).map((s) => s.name)).toEqual(['Menu']);
    expect(matching(SCREENS, [term('region', 'missing')]).map((s) => s.name)).toEqual(['Menu']);
    expect(matching(SCREENS, [term('region', 'eq', '')])).toEqual([]);
  });

  it('names the conditions no screen meets, which is why a rule matches none', () => {
    const rule = [term('region', 'eq', 'north'), term('store', 'in', '9999', '0001')];
    expect(matching(SCREENS, rule)).toEqual([]);
    expect(unmet(SCREENS, rule).map(termWords)).toEqual(['store is one of 9999, 0001']);
    // Each met alone, but by no screen together: none is named.
    expect(unmet(SCREENS, [term('region', 'eq', 'south'), term('store', 'exists')])).toEqual([]);
  });
});

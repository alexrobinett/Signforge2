// A field's problems and choices in words (#359): each of the contract's field problems said by the
// field's label, as the publish toast says them, and select options by a label.
import type { FieldDef } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { isEmptyProblem, optionLabel, problemWords } from '../src/lib/field-words';

const fields: Record<string, FieldDef> = {
  look: { type: 'select', label: 'Look', options: ['pop', 'poster'], default: 'pop' },
  headline: { type: 'text', label: 'Headline', maxLength: 80 },
  photo: { type: 'image', label: 'Photo' },
  showPhoto: { type: 'boolean', label: 'Show the photo', default: true },
  logo: { type: 'image', label: 'Logo' },
  opens: { type: 'date', label: 'Opens' },
  at: { type: 'datetime', label: 'Starts' },
  price: { type: 'number', label: 'Price', max: 100 },
  facts: { type: 'list', label: 'Facts', item: { label: { type: 'text', label: 'Label' }, value: { type: 'number', label: 'Value' } } },
};

describe('problemWords', () => {
  it.each([
    ['image field "photo" has no asset', 'No image for Photo: choose one, or untick Show the photo'],
    ['image field "logo" has no asset', 'No image for Logo: choose one'],
    ['field "headline" is missing', 'Headline is empty'],
    ['field "headline" is missing (a bound field needs a fallback value)', 'Headline needs a value to show until its data arrives'],
    ['field "opens" has no date yet', 'No date for Opens: pick one'],
    ['field "at" has no date and time yet', 'No date and time for Starts: pick one'],
    ['field "headline" is longer than 80', 'Headline is longer than 80 characters'],
    ['field "look" must be one of pop, poster', 'Look must be one of Pop, Poster'],
    ['field "price" must be at most 100', 'Price must be at most 100'],
    ['field "facts" row 2 is missing "label"', 'Facts, row 2, Label is empty'],
    ['field "facts[3].value" must be a number', 'Facts, row 3, Value must be a number'],
    ['field "gone" is missing', 'Gone is empty'],
    ["duration 1000 ms is outside the template's range 4000 to 60000", "Duration 1000 ms is outside the template's range 4000 to 60000"],
  ])('%s', (problem, words) => expect(problemWords(problem, fields)).toBe(words));

  it('knows which problems are of an empty value, shown only once a field is touched or Publish is pressed', () => {
    expect(
      ['image field "photo" has no asset', 'field "headline" is missing', 'field "opens" has no date yet', 'field "facts" row 2 is missing "label"'].every(
        isEmptyProblem,
      ),
    ).toBe(true);
    expect(['field "headline" is longer than 80', 'field "price" must be at most 100'].some(isEmptyProblem)).toBe(false);
  });
});

describe('optionLabel', () => {
  it.each([
    ['pop', 'Pop'],
    ['days and hours', 'Days and hours'],
    ['days, hours and minutes', 'Days, hours and minutes'],
    ['mph', 'mph'],
    ['km/h', 'km/h'],
    ['°F', '°F'],
    ['New', 'New'],
    ['', 'None'],
  ])('%s', (option, label) => expect(optionLabel(option)).toBe(label));
});

/**
 * A template field's problems and choices in the words people read (#359), not the contract's.
 * `validateSpotField` (packages/contract) names a field by its key in quotes, which an editor, a
 * playlist row, the stage and a held publish's toast all showed as it was: `image field "photo" has
 * no asset`. Here each is said by the field's label, the publish toast's way (`heldWords`): "No
 * image for Photo: choose one, or untick Show the photo". A problem the contract adds later reads
 * as it says, with the field's label for its key.
 */
import { type FieldDef, toggleOf } from '@signforge/contract';

/** `field "x"` or `image field "x"`, and the rest of the problem; a list cell is `field "x[3].k"`. */
const SUBJECT = /^(?:image )?field "([^"]+)"\s*(.*)$/;
const CELL = /^(.+)\[(\d+)\]\.(.+)$/;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A select option as people read it: a word capitalised ("pop" is Pop, "days and hours" Days and
 * hours), a unit or a symbol as written ("mph", "km/h", "°F"), none as None.
 */
export function optionLabel(option: string): string {
  if (option === '') return 'None';
  // A lowercase word with a vowel is a word; "mph" has none, and a unit with a slash or a symbol is not lowercase letters.
  return /^[a-z][a-z ,]*$/.test(option) && /[aeiouy]/.test(option) ? capital(option) : option;
}

/** What `name` is called on the form: its label, a list cell's as "Facts, row 2, Value"; its key if the template has no such field. */
function labelOf(name: string, fields: Record<string, FieldDef>): string {
  const cell = CELL.exec(name);
  if (!cell) return fields[name]?.label ?? name;
  const [, list = '', row = '', column = ''] = cell;
  const def = fields[list];
  const item = def?.type === 'list' ? def.item[column]?.label : undefined;
  return `${def?.label ?? list}, row ${row}, ${item ?? column}`;
}

/** A problem with an empty value: one a person has not had the chance to fill yet, so shown only once they have (#359). */
export const isEmptyProblem = (problem: string) => / has no asset$| is missing\b| has no date( and time)? yet$/.test(problem);

/**
 * One of `validateSpotField`'s problems, in words, capitalised and without a full stop. `fields` are
 * the template's, for labels; a field it does not have is named by its key. Another problem reads as it says.
 */
export const problemWords = (problem: string, fields: Record<string, FieldDef>): string => capital(said(problem, fields));

function said(problem: string, fields: Record<string, FieldDef>): string {
  const subject = SUBJECT.exec(problem);
  if (!subject) return problem;
  const [, name = '', rest = ''] = subject;
  const label = labelOf(name, fields);
  if (rest === 'has no asset') {
    const toggle = fields[toggleOf(name)]?.label;
    return `No image for ${label}: choose one${toggle ? `, or untick ${toggle}` : ''}`;
  }
  if (rest === 'is missing (a bound field needs a fallback value)') return `${label} needs a value to show until its data arrives`;
  if (rest === 'is missing') return `${label} is empty`;
  const date = /^has no (date|date and time) yet$/.exec(rest);
  if (date) return `No ${date[1]} for ${label}: pick one`;
  const row = /^row (\d+) is missing "([^"]+)"$/.exec(rest);
  if (row) return `${labelOf(`${name}[${row[1]}].${row[2]}`, fields)} is empty`;
  const chars = /^is longer than (\d+)$/.exec(rest);
  if (chars) return `${label} is longer than ${chars[1]} characters`;
  const options = /^must be one of (.*)$/.exec(rest);
  if (options) {
    const def = fields[name];
    const list = def?.type === 'select' ? def.options : (options[1] ?? '').split(', ');
    return `${label} must be one of ${list.map(optionLabel).join(', ')}`;
  }
  return `${label} ${rest}`;
}

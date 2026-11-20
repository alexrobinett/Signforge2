/** The days of a week as the CMS shows them, for display hours and schedule entries. */

/** Monday first, as people read a week; the contract counts 0 as Sunday. */
export const DAYS: [day: number, short: string, long: string][] = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [0, 'Sun', 'Sunday'],
];

/** "Every day", "Mon–Fri", or "Sat, Sun". */
export function dayRange(days: number[]): string {
  const order = DAYS.map(([d]) => d).filter((d) => days.includes(d));
  if (order.length === 7) return 'Every day';
  const names = DAYS.filter(([d]) => days.includes(d)).map(([, short]) => short);
  const idx = order.map((d) => DAYS.findIndex(([x]) => x === d));
  const consecutive = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  return consecutive && names.length > 2 ? `${names[0]}–${names.at(-1)}` : names.join(', ');
}

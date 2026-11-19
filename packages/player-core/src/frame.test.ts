import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { containedFrames } from './frame';

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const policiesOf = (wrapper: string) => [...wrapper.matchAll(/content="([^"]*)"/g)].map((m) => m[1]!);
const scriptsOf = (html: string) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const DISARM = "if(!(delete this.RTCPeerConnection&&delete this.webkitRTCPeerConnection))throw new Error('[sf] WebRTC could not be removed');";

describe('containedFrames', () => {
  it('lets the wrapper and template run only their classic scripts, each disarmed first', () => {
    const { wrapper, template } = containedFrames(
      '<!doctype html><p>x</p><script>"use strict";go()</script><script type="text/javascript">more()\r\n</script><script type="module">mod()</script>',
    );
    const [strict, plain, module] = scriptsOf(template);
    // The prologue stays first, so the script keeps strict mode; CR LF reads as LF.
    expect(strict).toBe(`"use strict";\n;${DISARM}go()`);
    expect(plain).toBe(`\n;${DISARM}more()\n`);
    // A module is left as it is, and not let run.
    expect(module).toBe('mod()');
    const [relay] = scriptsOf(wrapper);
    const [policy, inlineOnly] = policiesOf(wrapper);
    expect(policy).toContain(`script-src ${[relay!, strict!, plain!].map(hash).join(' ')};`);
    expect(/script-src [^;]*/.exec(policy!)![0]).not.toContain('unsafe');
    // The second policy allows no script URL, whatever `integrity` a script names.
    expect(inlineOnly).toBe("script-src 'unsafe-inline'");
  });

  it('leaves a data block as it is, and does not let it run', () => {
    const { wrapper, template } = containedFrames('<script type="application/json">{"a":1}</script>');
    expect(template).toBe('<script type="application/json">{"a":1}</script>');
    expect(policiesOf(wrapper)[0]).not.toContain(hash('{"a":1}'));
  });

  it('keeps a script strict however its directive prologue starts, and a sloppy one sloppy', () => {
    const probe = 'this.strict = (function () { return this === undefined; })();';
    const strictness = (prologue: string) => {
      const [armed] = scriptsOf(containedFrames(`<script>${prologue}${probe}</script>`).template);
      const global = createContext({});
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

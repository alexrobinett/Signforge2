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

  // A global with both constructors, as a template's frame has before the guard runs; then the script.
  const run = (script: string) => {
    const global = createContext({ RTCPeerConnection() {}, webkitRTCPeerConnection() {} });
    runInContext(script, global);
    return global as { seen?: boolean; r?: string };
  };
  const allowed = (bundle: string) => {
    const { wrapper, template } = containedFrames(bundle);
    const [armed] = scriptsOf(template);
    return policiesOf(wrapper)[0]!.includes(hash(armed!)) ? armed! : undefined;
  };

  it('runs the guard before anything else in the script, however a comment in it ends', () => {
    // U+2028 and U+2029 end a line comment in JavaScript; the parser reads CR LF as LF.
    for (const end of ['\n', '\r\n', '\u2028', '\u2029']) {
      const armed = allowed(`<script>"use strict";// a note${end}this.seen = 'RTCPeerConnection' in this;</script>`);
      expect(armed, JSON.stringify(end)).toBeDefined();
      expect(run(armed!).seen, JSON.stringify(end)).toBe(false);
    }
  });

  it('keeps an expression that starts with a string on the next line whole', () => {
    const armed = allowed('<script>"use strict";"abc"\n.concat(this.r = "ok");</script>');
    expect(run(armed!).r).toBe('ok');
  });

  it('lets no script run that does not start with exactly "use strict";', () => {
    for (const text of ['\uFEFF"use strict";x()', '/* licence */"use strict";x()', "'use strict';x()", '"use strict"\r\nx()', ' "use strict";x()', 'x()']) {
      const { wrapper, template } = containedFrames(`<script>${text}</script>`);
      expect(template, JSON.stringify(text)).toBe(`<script>${text.replace('\r\n', '\n')}</script>`);
      expect(policiesOf(wrapper)[0]!.match(/'sha256-/g), JSON.stringify(text)).toHaveLength(1);
    }
  });
});

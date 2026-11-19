import { createHash } from 'node:crypto';
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
});

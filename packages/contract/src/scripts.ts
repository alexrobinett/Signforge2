/**
 * The scripts of a template bundle, found as a browser finds them: parse5 follows the HTML standard's
 * tokenizer and tree builder, so HTML and SVG script elements are found (those in a `<template>` too)
 * with their attributes decoded, and text that only looks like a script (in a textarea, a comment, an
 * attribute) is not one. The bundle check and the player (`containedFrames` in packages/player-core)
 * both read scripts through this, so they agree on which ones a template frame runs and where their
 * text is. See Template containment in docs/architecture.md.
 */
import { type DefaultTreeAdapterTypes as Tree, parse } from 'parse5';
import { TEMPLATE_SCRIPT_START } from './shapes.ts';

export interface BundleScript {
  /** Where the script's text is in the returned `html`, from `start` to `end`. */
  start: number;
  end: number;
  /** Whether a template frame runs it: inline, classic JavaScript, plain text, starting with exactly TEMPLATE_SCRIPT_START. */
  runs: boolean;
  /** Why an executable script would not run; absent for one that runs and for a data block. */
  problem?: string;
}

const SVG = 'http://www.w3.org/2000/svg';
// The HTML standard's JavaScript MIME type essences, and the other types it runs as a script.
const JAVASCRIPT = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);
const OTHER_SCRIPTS = new Set(['module', 'importmap', 'speculationrules']);

/** A script element's type string, as the HTML standard's "prepare the script element" computes it, lowercased. */
function typeOf(el: Tree.Element): string {
  const attr = (name: string) => el.attrs.find((a) => a.name === name && !a.prefix)?.value;
  const type = attr('type');
  const language = attr('language');
  if (type === '' || (type === undefined && !language)) return 'text/javascript';
  return (type ?? `text/${language}`).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
}

function classify(el: Tree.Element, html: string): BundleScript {
  const loc = el.sourceCodeLocation!;
  const texts = el.childNodes.filter((n): n is Tree.TextNode => n.nodeName === '#text');
  const start = loc.startTag!.endOffset;
  const end = loc.endTag?.startOffset ?? el.childNodes.at(-1)?.sourceCodeLocation?.endOffset ?? start;
  const at = { start, end, runs: false };
  const external = el.namespaceURI === SVG ? el.attrs.some((a) => a.name === 'href') : el.attrs.some((a) => a.name === 'src' && !a.prefix);
  if (external) return { ...at, problem: 'a script must be inline: an external script does not run in a template' };
  const type = typeOf(el);
  if (!JAVASCRIPT.has(type) && !OTHER_SCRIPTS.has(type)) return at;
  if (type !== 'text/javascript')
    return { ...at, problem: `a script with type "${type}" does not run in a template: use no type (sf build makes a classic script)` };
  const text = texts.map((t) => t.value).join('');
  // In SVG a script's text can hold character references or CDATA: the text that runs is not the source.
  if (html.slice(start, end) !== text) return { ...at, problem: 'a script must be plain text: no character references, CDATA or elements in it' };
  if (!text.startsWith(TEMPLATE_SCRIPT_START))
    return { ...at, problem: `every script must start with exactly ${TEMPLATE_SCRIPT_START} (sf build makes it so): one that does not, does not run` };
  return { ...at, runs: true };
}

/** A bundle as the browser reads it (CR LF and CR as LF), and its script elements in source order. */
export function bundleScripts(bundle: string): { html: string; scripts: BundleScript[] } {
  const html = bundle.replace(/\r\n?/g, '\n');
  const scripts: BundleScript[] = [];
  const walk = (node: Tree.ParentNode) => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      if (child.tagName === 'script') scripts.push(classify(child, html));
      walk('content' in child ? child.content : child);
    }
  };
  walk(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
  return { html, scripts: scripts.sort((a, b) => a.start - b.start) };
}

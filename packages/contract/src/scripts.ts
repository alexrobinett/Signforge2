/**
 * The scripts of a template bundle, read with an HTML parser: parse5 follows the HTML standard's
 * tokenizer and tree builder, so HTML and SVG script elements are found (those in a `<template>` too)
 * with their attributes decoded, and text that only looks like a script (in a textarea, a comment, an
 * attribute) is not one. A `script` in MathML never runs, and is skipped. A `<select>` is refused: a
 * screen takes no input, and inside one parse5 and Chromium disagree (Chromium parses it as a
 * customizable select), so nothing in it is armed either. Up to the first `<select>` the two parse
 * alike, so parse5 finds that one where Chromium does. The bundle check and the player
 * (`containedFrames` in packages/player-core) both read scripts through this, so they agree on which
 * ones a template frame runs and where their text is. See Template containment in docs/architecture.md.
 *
 * The same walk gives the bundle check its styles (#326): each `<style>` element's text and each `style` attribute's
 * value as the parser reads them (in an SVG's `<style>`, character references read, CDATA unwrapped and comments left
 * out; in an HTML one, the text as written), linear in the bundle. What a refused `<select>` holds is not read again.
 */
import { type DefaultTreeAdapterTypes as Tree, parse } from 'parse5';
import { TEMPLATE_SCRIPT_START } from './shapes.ts';

/** A script element, or a `<select>`, which a template may not hold. */
export interface BundleScript {
  /** Where the script's text (or the whole `<select>`) is in the returned `html`, from `start` to `end`. */
  start: number;
  end: number;
  /** Whether a template frame runs it: inline, classic JavaScript, plain text, starting with exactly TEMPLATE_SCRIPT_START. */
  runs: boolean;
  /** Why an executable script would not run; absent for one that runs and for a data block. */
  problem?: string;
}

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const NO_SELECT = 'a template may not hold a <select>: a screen takes no input; use text or an image';
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

const asciiSpace = (c: string | undefined) => c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
/** ASCII whitespace off both ends, as the HTML standard strips it: by index, linear however long the run (review of #438). */
function asciiTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && asciiSpace(text[start])) start += 1;
  while (end > start && asciiSpace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** A script element's type string, as the HTML standard's "prepare the script element" computes it, lowercased. */
function typeOf(el: Tree.Element): string {
  const attr = (name: string) => el.attrs.find((a) => a.name === name && !a.prefix)?.value;
  const type = attr('type');
  const language = attr('language');
  if (type === '' || (type === undefined && !language)) return 'text/javascript';
  return asciiTrim(type ?? `text/${language}`).toLowerCase();
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

/**
 * A `<style>` element: its text as the parser reads it, and as it is written in the bundle. `written` is empty for one
 * inside another (an SVG's `<style>`s nest): the outer one's holds it, so the written text adds up to the bundle at most.
 */
export interface BundleStyle {
  text: string;
  written: string;
}

/**
 * Each element under `root` (a `<template>`'s content too), with what `visit` passes down to its children: by a stack of
 * our own, not recursion, as a tree can be deeper than the call stack (an SVG's `<style>`s nest, review of #438).
 */
function eachElement<F>(root: Tree.ParentNode, flag: F, visit: (element: Tree.Element, flag: F) => F) {
  // Each element visited as it is taken off the stack, its children pushed last first: in source order, as recursion went.
  const stack: [Extract<Tree.ChildNode, { tagName: string }>, F][] = [];
  const push = (node: Tree.ParentNode, f: F) => {
    for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
      const child = node.childNodes[i]!;
      if ('tagName' in child) stack.push([child, f]);
    }
  };
  push(root, flag);
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [element, f] = top;
    push('content' in element ? element.content : element, visit(element, f));
  }
}

/**
 * A bundle as the browser reads it (CR LF and CR as LF), its script elements in source order, and its styles: each
 * `<style>` element, and each `style` attribute's value.
 */
export function bundleScripts(bundle: string): { html: string; scripts: BundleScript[]; styles: BundleStyle[]; styleAttributes: string[] } {
  const html = bundle.replace(/\r\n?/g, '\n');
  const scripts: BundleScript[] = [];
  const styles: BundleStyle[] = [];
  const styleAttributes: string[] = [];
  const visit = (child: Tree.Element, inSelect: boolean) => {
    const select = !inSelect && child.tagName === 'select' && child.namespaceURI === HTML;
    if (select) {
      // Refused whatever it holds (review of #438, final check): reading what Chromium's customizable select finds
      // in it, which parse5 drops, took a second parse that a tag scan out of step with parse5 made quadratic.
      const loc = child.sourceCodeLocation!;
      scripts.push({ start: loc.startOffset, end: loc.endOffset, runs: false, problem: NO_SELECT });
    }
    if (child.tagName === 'script' && (child.namespaceURI === HTML || child.namespaceURI === SVG)) {
      const found = classify(child, html);
      // In a <select> the <select> is the problem: its scripts are neither armed nor reported again.
      scripts.push(inSelect ? { start: found.start, end: found.end, runs: false } : found);
    }
    return inSelect || select;
  };
  const document = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  eachElement(document, false, (child, inStyle) => {
    for (const a of child.attrs) if (a.name === 'style' && !a.prefix) styleAttributes.push(a.value);
    const style = child.tagName === 'style';
    if (style) {
      const loc = child.sourceCodeLocation!;
      const start = loc.startTag!.endOffset;
      const end = loc.endTag?.startOffset ?? child.childNodes.at(-1)?.sourceCodeLocation?.endOffset ?? start;
      const text = child.childNodes.flatMap((n) => (n.nodeName === '#text' && 'value' in n ? [n.value] : [])).join('');
      styles.push({ text, written: inStyle ? '' : html.slice(start, end) });
    }
    return inStyle || style;
  });
  eachElement(document, false, visit);
  return { html, scripts: scripts.sort((a, b) => a.start - b.start), styles, styleAttributes };
}

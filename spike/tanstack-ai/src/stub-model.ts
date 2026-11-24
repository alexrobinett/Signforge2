/**
 * A scripted model (#346): Anthropic's Messages API and an OpenAI-compatible Chat Completions API,
 * answering what the person asked with a fixed script, so the spike runs with no key and no network.
 * It is the guards' `fetch` (as apps/api's `FEED_STUB_URL`), so the guards still check every URL.
 *
 * Scripts, by the person's latest message (a tool result, which Anthropic sends as a user message, is not one):
 *  - "free text": the final turn is prose, with no JSON, whatever the request asked for.
 *  - "loose": the final turn is JSON, but only `{ text }`: not the card's shape.
 *  - "restart": the model calls the dangerous `restart_screens` tool, then answers.
 *  - "fill": one structured answer from the flyer, no tools.
 *  - otherwise: `list_screens` and `list_playlists`, then the answer card, streamed in three pieces.
 *
 * Every request is kept in `seen`, headers and body, for the tests to read.
 */

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
export const seen: SeenRequest[] = [];

const CARD = {
  text: 'Two screens are behind: they have not reached the latest publish.',
  groups: [{ title: 'Behind', screens: ['Lobby', 'Drive-thru 1'], why: 'Their player is older than the publish.' }],
  steps: [{ label: 'Copy the note', note: 'Restart the two players, then check they show today.' }],
};
const FILL = { headline: 'Hot breakfast, fast', price: '$4.99' };

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

const isResult = (m: unknown) => isRow(m) && (m.role === 'tool' || (Array.isArray(m.content) && m.content.some((c) => isRow(c) && c.type === 'tool_result')));
const isAsked = (m: unknown) => isRow(m) && m.role === 'user' && !isResult(m);

/** The person's latest message's text, as either API carries it. */
function asked(messages: unknown[]): string {
  const last = messages.findLast(isAsked);
  if (!isRow(last)) return '';
  const content = last.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c) => (isRow(c) && typeof c.text === 'string' ? c.text : '')).join(' ') : '';
}

/** Whether a tool's result came since the person's latest message: the model then answers. */
const hasResults = (messages: unknown[]) => messages.slice(messages.findLastIndex(isAsked) + 1).some(isResult);

/** What the script says next: tool calls, or final text (the card's JSON, or prose). */
function next(messages: unknown[], structured: boolean): { calls: { name: string; input: Row }[] } | { text: string[] } {
  const question = asked(messages);
  if (question.includes('fill')) return { text: [JSON.stringify(FILL)] };
  if (question.includes('free text')) return { text: ['Two screens are behind. Restart them.'] };
  if (question.includes('loose')) return { text: [JSON.stringify({ text: CARD.text })] };
  if (!hasResults(messages)) {
    if (question.includes('restart')) return { calls: [{ name: 'restart_screens', input: { reason: 'behind' } }] };
    return {
      calls: [
        { name: 'list_screens', input: {} },
        { name: 'list_playlists', input: {} },
      ],
    };
  }
  if (!structured) return { text: ['Checked the screens.'] };
  const json = JSON.stringify(CARD);
  const third = Math.ceil(json.length / 3);
  return { text: [json.slice(0, third), json.slice(third, 2 * third), json.slice(2 * third)] };
}

const sse = (events: [string | null, Row][]) =>
  new Response(events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

function anthropic(body: Row): Response {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const step = next(messages, isRow(body.output_config));
  const usage = { input_tokens: 10, output_tokens: 10 };
  const message = { id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage };
  if (body.stream !== true) {
    const content = 'calls' in step ? step.calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${i}`, ...c })) : [{ type: 'text', text: step.text.join('') }];
    return Response.json({ ...message, content, stop_reason: 'calls' in step ? 'tool_use' : 'end_turn' });
  }
  const events: [string, Row][] = [['message_start', { type: 'message_start', message }]];
  if ('calls' in step)
    step.calls.forEach((c, index) => {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${seen.length}_${index}`, name: c.name, input: {} } },
      ]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    });
  else {
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
    for (const piece of step.text) events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'calls' in step ? 'tool_use' : 'end_turn' }, usage }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return sse(events);
}

function compatible(body: Row): Response {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const step = next(messages, isRow(body.response_format));
  const chunk = (delta: Row, finish: string | null = null) =>
    [null, { id: 'chatcmpl', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }] as [null, Row];
  if (body.stream !== true) {
    const message =
      'calls' in step
        ? {
            role: 'assistant',
            content: null,
            tool_calls: step.calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
          }
        : { role: 'assistant', content: step.text.join('') };
    return Response.json({
      id: 'chatcmpl',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message, finish_reason: 'calls' in step ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  }
  const events: [null, Row][] = [chunk({ role: 'assistant' })];
  if ('calls' in step)
    step.calls.forEach((c, index) =>
      events.push(
        chunk({
          tool_calls: [{ index, id: `call_${seen.length}_${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }],
        }),
      ),
    );
  else for (const piece of step.text) events.push(chunk({ content: piece }));
  events.push(chunk({}, 'calls' in step ? 'tool_calls' : 'stop'));
  return new Response(`${events.map(([, d]) => `data: ${JSON.stringify(d)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** The scripted model, as a `fetch`. */
export const stubModel: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : {};
  seen.push({ url: request.url, headers: Object.fromEntries(request.headers), body: isRow(body) ? body : {} });
  if (!isRow(body)) return new Response('not JSON', { status: 400 });
  const { pathname } = new URL(request.url);
  if (pathname.endsWith('/messages')) return anthropic(body);
  if (pathname.endsWith('/chat/completions')) return compatible(body);
  return new Response('not found', { status: 404 });
};

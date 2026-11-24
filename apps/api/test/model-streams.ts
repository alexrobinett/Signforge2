// A scripted model's answer as each provider streams it (#349): Anthropic's Messages API events, and
// an OpenAI-compatible endpoint's chat completion chunks. The adapters call both APIs streaming,
// so the agent tests' scripted models answer this way.

/** A block of the model's answer: text, or a call of a tool with its input. */
export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

const sse = (lines: string[]) => new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });

/** Anthropic's streamed message: each block started, its text or input as one delta, stopped; then `stop` and the end. */
export function anthropicStream(id: string, model: string, blocks: Block[], stop: string): Response {
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  return sse([
    event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    ...blocks.flatMap((b, index) => [
      event('content_block_start', {
        index,
        content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} },
      }),
      event('content_block_delta', {
        index,
        delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      }),
      event('content_block_stop', { index }),
    ]),
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage }),
    event('message_stop', {}),
  ]);
}

/** An OpenAI-compatible endpoint's streamed completion: the message's text and tool calls as chunks, then `finish` and `[DONE]`. */
export function completionStream(message: { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }, finish: string): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return sse([
    chunk({ role: 'assistant' }),
    ...(message.content ? [chunk({ content: message.content })] : []),
    ...(message.toolCalls ?? []).map((c, index) =>
      chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }] }),
    ),
    chunk({}, finish),
    'data: [DONE]\n\n',
  ]);
}

// What apps/api bundles today for Anthropic: the SDK's client and one Messages call.
import Anthropic from '@anthropic-ai/sdk';

export default {
  async fetch() {
    const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
    return Response.json(await client.messages.create({ model: 'm', max_tokens: 1, messages: [] }));
  },
};

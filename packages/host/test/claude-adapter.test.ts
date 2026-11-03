import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { claudeModel } from '@agentevents/host';

/** Drives the Claude adapter's manual tool loop with a fake client: no network, no model. */
it('runs the tool loop through the host callback, appends full content, and stops on refusal', async () => {
  const requests: Record<string, unknown>[] = [];
  const replies = [
    { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'describe_service', input: { service: 'checkout-api' } }] },
    { stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: 'text', text: 'done' }] },
  ];
  const fake = { beta: { messages: { create: async (req: Record<string, unknown>) => (requests.push(structuredClone(req)), replies.shift()) } } } as unknown as Anthropic;
  const calls: string[] = [];
  const model = claudeModel({ client: fake });
  const res = await model.runTurn({
    system: 's',
    prompt: 'p',
    tools: [{ name: 'describe_service', description: 'd', inputSchema: { type: 'object', properties: { service: { type: 'string' } } } }],
    callTool: async (name, args) => (calls.push(`${name}:${String(args['service'])}`), { content: '{"healthy":false}', isError: false }),
    maxSteps: 4,
  });
  expect(res).toMatchObject({ text: 'done', stopReason: 'end', usage: { inputTokens: 30, outputTokens: 13 } });
  expect(calls).toEqual(['describe_service:checkout-api']);
  expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
  const second = requests[1]!['messages'] as { role: string; content: unknown }[];
  expect((second[1]!.content as { type: string }[])[0]!.type).toBe('thinking'); // history kept append-only
  expect(second[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] });

  const refusing = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 }, content: [] }) } } } as unknown as Anthropic;
  const r2 = await claudeModel({ client: refusing }).runTurn({ system: 's', prompt: 'p', tools: [], callTool: async () => ({ content: '', isError: false }), maxSteps: 2 });
  expect(r2.stopReason).toBe('refusal');
});

it('bedrock adapter uses the Bedrock model id and sends no Claude-API-only fallback params', async () => {
  const requests: Record<string, unknown>[] = [];
  const fake = { beta: { messages: { create: async (req: Record<string, unknown>) => (requests.push(req), { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] }) } } };
  const { bedrockClaudeModel } = await import('@agentevents/host');
  const res = await bedrockClaudeModel({ client: fake as never }).runTurn({ system: 's', prompt: 'p', tools: [], callTool: async () => ({ content: '', isError: false }), maxSteps: 2 });
  expect(res.text).toBe('ok');
  expect(requests[0]).toMatchObject({ model: 'anthropic.claude-opus-5-5' });
  expect(requests[0]).not.toHaveProperty('fallbacks');
  expect(requests[0]).not.toHaveProperty('betas');
});

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { Model, TurnRequest, TurnResponse } from './model';

/** Any client exposing the Messages API beta surface (Anthropic or Bedrock Mantle). */
type MessagesClient = Pick<Anthropic, 'beta'> | AnthropicBedrockMantle;

export interface ClaudeModelOptions {
  /** Defaults to `claude-opus-5-5`. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** Defaults to `new Anthropic()`, which resolves credentials from the environment. */
  client?: Anthropic;
}

export interface BedrockClaudeModelOptions {
  /** Bedrock model id. Defaults to `anthropic.claude-opus-5-5`; confirm availability in your Region. */
  model?: string;
  /** Defaults to AWS_REGION / AWS_DEFAULT_REGION. */
  region?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** Defaults to a Bedrock Mantle client using the standard AWS credential chain. */
  client?: AnthropicBedrockMantle;
}

/**
 * Recommended for production: Claude on Amazon Bedrock, with AWS IAM, managed security,
 * compliance monitoring and cost controls. Uses the same host-mediated tool loop.
 */
export function bedrockClaudeModel(opts: BedrockClaudeModelOptions = {}): Model {
  const client = opts.client ?? new AnthropicBedrockMantle(opts.region ? { awsRegion: opts.region } : {});
  return toolLoopModel(client, opts.model ?? 'anthropic.claude-opus-5-5', opts, false);
}

/**
 * Claude through the direct Anthropic API, for local development and evaluation. Prefer
 * `bedrockClaudeModel` for production workloads. Server-side refusal fallbacks are enabled.
 */
export function claudeModel(opts: ClaudeModelOptions = {}): Model {
  return toolLoopModel(opts.client ?? new Anthropic(), opts.model ?? 'claude-opus-5-5', opts, true);
}

function toolLoopModel(
  client: MessagesClient,
  model: string,
  opts: { effort?: ClaudeModelOptions['effort']; maxTokens?: number },
  serverFallbacks: boolean,
): Model {
  return {
    id: model,
    async runTurn(req: TurnRequest): Promise<TurnResponse> {
      const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: 'object', ...t.inputSchema } as Anthropic.Beta.BetaTool.InputSchema,
      }));
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (let step = 0; step < req.maxSteps; step++) {
        if (req.signal?.aborted) return { text: '', steps: step, stopReason: 'aborted', usage };
        const response = await client.beta.messages.create(
          {
            model,
            max_tokens: opts.maxTokens ?? 16_000,
            system: req.system,
            messages,
            tools,
            output_config: { effort: opts.effort ?? 'medium' },
            // Server-side refusal fallbacks exist on the Claude API only; on Bedrock a refusal ends the turn.
            ...(serverFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          },
          req.signal ? { signal: req.signal } : undefined,
        );
        usage.inputTokens += response.usage.input_tokens;
        usage.outputTokens += response.usage.output_tokens;
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (response.stop_reason === 'refusal') return { text, steps: step + 1, stopReason: 'refusal', usage };
        // Append the full content (thinking blocks included) so history stays append-only.
        messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || uses.length === 0) return { text, steps: step + 1, stopReason: 'end', usage };
        const results = await Promise.all(
          uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const out = await req.callTool(u.name, (u.input ?? {}) as Record<string, unknown>);
            return { type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
          }),
        );
        messages.push({ role: 'user', content: results });
      }
      return { text: '', steps: req.maxSteps, stopReason: 'max_steps', usage };
    },
  };
}

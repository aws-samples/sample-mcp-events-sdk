/**
 * The model port. The host owns the tool loop boundary: every tool call goes through
 * `callTool`, where autonomy, tiers, taint and idempotency are enforced.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOutcome {
  content: string;
  isError: boolean;
}

export interface TurnRequest {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  maxSteps: number;
  signal?: AbortSignal;
}

export interface TurnResponse {
  text: string;
  steps: number;
  stopReason: 'end' | 'max_steps' | 'refusal' | 'aborted';
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Model {
  id: string;
  runTurn(req: TurnRequest): Promise<TurnResponse>;
}

/**
 * Deterministic model for tests and offline demos. The script decides which tools to call and
 * what to answer, so the whole pipeline runs without credentials.
 */
export function scriptedModel(
  id: string,
  script: (req: TurnRequest, call: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>) => Promise<string>,
): Model {
  return {
    id,
    async runTurn(req) {
      let steps = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> => {
        steps += 1;
        if (steps > req.maxSteps) return { content: 'step limit reached', isError: true };
        if (!req.tools.some((t) => t.name === name)) return { content: `tool ${name} is not available in this turn`, isError: true };
        return req.callTool(name, args);
      };
      const text = await script(req, call);
      return { text, steps, stopReason: steps > req.maxSteps ? 'max_steps' : 'end' };
    },
  };
}

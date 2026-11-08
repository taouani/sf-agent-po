import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/**
 * The model side of an evaluation run. Users bring their own model and keys, so
 * the evaluation runs the same scenarios through several providers and never
 * favours one (goal: satisfying output with any model).
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as the MCP server lists it. */
  inputSchema: Record<string, unknown>;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export interface AgentRun {
  /** The model's last text answer. */
  finalText: string;
  toolCalls: { name: string; args: Record<string, unknown>; isError: boolean }[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the loop ended: the model finished, hit the turn limit, or stopped for another reason. */
  stop: "done" | "max_turns" | "max_tokens" | "refusal" | "other";
}

export interface Model {
  /** "provider:model", e.g. "anthropic:claude-opus-5-5". */
  readonly id: string;
  /** Runs an agent loop: the prompt as the user turn, the tools on offer, until the model stops calling tools. */
  runAgent(prompt: string, tools: ToolSpec[], callTool: CallTool, opts?: { maxTurns?: number }): Promise<AgentRun>;
  /** One answer without tools, for the judge. */
  complete(system: string, prompt: string): Promise<string>;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export const PROVIDERS = {
  anthropic: { env: "ANTHROPIC_API_KEY" },
  openai: { env: "OPENAI_API_KEY" },
  xai: { env: "XAI_API_KEY", baseURL: "https://api.x.ai/v1" },
  /** One key for many vendors' models, named as OpenRouter lists them: "openrouter:anthropic/claude-opus-5.5". */
  openrouter: { env: "OPENROUTER_API_KEY", baseURL: OPENROUTER_URL },
} as const;

export type Provider = keyof typeof PROVIDERS;

/** A guided v1 run submits each step and may be sent back, so it takes more turns than 0.x. */
const DEFAULT_MAX_TURNS = 80;
const MAX_TOKENS = 32_000;

/** Builds a model from "provider:model". Keys come from the provider's usual environment variable. */
export function createModel(spec: string, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Model {
  const i = spec.indexOf(":");
  const provider = spec.slice(0, i) as Provider;
  const model = spec.slice(i + 1);
  if (i < 1 || !model || !(provider in PROVIDERS)) {
    throw new Error(`Invalid model "${spec}". Use provider:model, with provider one of ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  const p = PROVIDERS[provider];
  const apiKey = env[p.env];
  if (!apiKey) throw new Error(`${spec} needs the ${p.env} environment variable.`);
  if (provider === "anthropic") return new AnthropicModel(spec, model, new Anthropic({ apiKey, fetch: fetchImpl }));
  return new OpenAICompatibleModel(
    spec,
    model,
    new OpenAI({ apiKey, baseURL: "baseURL" in p ? p.baseURL : undefined, fetch: fetchImpl }),
    // OpenRouter passes max_tokens on to every vendor (max_completion_tokens is OpenAI's own
    // name), and streams, so that a long answer from any vendor stays under HTTP timeouts.
    provider === "openrouter" ? { maxTokensParam: "max_tokens", stream: true } : {},
  );
}

/** OpenRouter's routing suffixes, which its model list does not show: "anthropic/x:nitro". */
const OPENROUTER_VARIANTS = /:(?:nitro|floor|online|exacto|thinking|extended|beta)$/;

/**
 * Checks that every OpenRouter model asked for is one OpenRouter lists (its list needs no key),
 * so that a misspelt id fails at once, with the ids of the same vendor to choose from.
 */
export async function checkOpenRouterModels(
  specs: readonly string[],
  fetchImpl: typeof fetch = fetch,
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<void> {
  const wanted = specs.filter((s) => s.startsWith("openrouter:")).map((s) => s.slice("openrouter:".length));
  if (!wanted.length) return;
  let models: { id: string; created: number }[];
  try {
    const response = await fetchImpl(`${OPENROUTER_URL}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = ((await response.json()) as { data?: { id?: unknown; created?: unknown }[] }).data;
    if (!Array.isArray(data)) throw new Error("no model list in the answer");
    models = data.flatMap((m) => (typeof m.id === "string" ? [{ id: m.id, created: typeof m.created === "number" ? m.created : 0 }] : []));
  } catch (err) {
    // The check only saves a wasted run: without it, a wrong id fails at its first call.
    warn(`OpenRouter's model list could not be read (${(err as Error).message}), so the model ids are not checked.`);
    return;
  }
  const listed = new Set(models.map((m) => m.id));
  const unknown = wanted.filter((w) => !listed.has(w) && !listed.has(w.replace(OPENROUTER_VARIANTS, "")));
  if (!unknown.length) return;
  const lines = unknown.map((u) => {
    const vendor = u.split("/")[0]!;
    const near = models
      .filter((m) => m.id.startsWith(`${vendor}/`))
      .sort((a, b) => b.created - a.created)
      .slice(0, 15)
      .map((m) => m.id);
    return `"${u}" is not a model OpenRouter lists.${near.length ? ` Its newest ${vendor} models: ${near.join(", ")}.` : ""}`;
  });
  throw new Error(lines.join("\n"));
}

export class AnthropicModel implements Model {
  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly client: Anthropic,
  ) {}

  async runAgent(prompt: string, specs: ToolSpec[], callTool: CallTool, opts: { maxTurns?: number } = {}): Promise<AgentRun> {
    const tools: Anthropic.Tool[] = specs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: "object" } as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const run: AgentRun = { finalText: "", toolCalls: [], turns: 0, inputTokens: 0, outputTokens: 0, stop: "max_turns" };
    while (run.turns < (opts.maxTurns ?? DEFAULT_MAX_TURNS)) {
      run.turns++;
      // Streaming keeps long answers (a full design) under HTTP timeouts.
      const response = await this.client.messages.stream({ model: this.model, max_tokens: MAX_TOKENS, tools, messages }).finalMessage();
      run.inputTokens += response.usage.input_tokens;
      run.outputTokens += response.usage.output_tokens;
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (text) run.finalText = text;
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") {
        run.stop = response.stop_reason === "end_turn" ? "done" : response.stop_reason === "max_tokens" ? "max_tokens" : response.stop_reason === "refusal" ? "refusal" : "other";
        return run;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        const r = await callTool(block.name, args);
        run.toolCalls.push({ name: block.name, args, isError: r.isError });
        results.push({ type: "tool_result", tool_use_id: block.id, content: r.text, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
    }
    return run;
  }

  async complete(system: string, prompt: string): Promise<string> {
    const response = await this.client.messages.stream({ model: this.model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: prompt }] }).finalMessage();
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  }
}

/** OpenAI and providers with an OpenAI-compatible API (xAI). */
export class OpenAICompatibleModel implements Model {
  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly client: OpenAI,
    private readonly options: { maxTokensParam?: "max_tokens" | "max_completion_tokens"; stream?: boolean } = {},
  ) {}

  /** One completion: streamed and put together when the provider streams, else in one answer. */
  private async chat(body: Pick<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model" | "messages" | "tools">): Promise<OpenAI.Chat.ChatCompletion> {
    const limit = { [this.options.maxTokensParam ?? "max_completion_tokens"]: MAX_TOKENS };
    if (!this.options.stream) return this.client.chat.completions.create({ ...body, ...limit });
    const done = await this.client.chat.completions.stream({ ...body, ...limit, stream_options: { include_usage: true } }).finalChatCompletion();
    // The helper adds fields of its own to the message, which is sent back in the next turn.
    return { ...done, choices: done.choices.map(({ message: { parsed: _parsed, ...message }, ...c }) => ({ ...c, message })) } as OpenAI.Chat.ChatCompletion;
  }

  async runAgent(prompt: string, specs: ToolSpec[], callTool: CallTool, opts: { maxTurns?: number } = {}): Promise<AgentRun> {
    const tools: OpenAI.Chat.ChatCompletionTool[] = specs.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: { ...t.inputSchema, type: "object" } },
    }));
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: prompt }];
    const run: AgentRun = { finalText: "", toolCalls: [], turns: 0, inputTokens: 0, outputTokens: 0, stop: "max_turns" };
    while (run.turns < (opts.maxTurns ?? DEFAULT_MAX_TURNS)) {
      run.turns++;
      const response = await this.chat({ model: this.model, tools, messages });
      run.inputTokens += response.usage?.prompt_tokens ?? 0;
      run.outputTokens += response.usage?.completion_tokens ?? 0;
      const choice = response.choices[0];
      if (!choice) {
        run.stop = "other";
        return run;
      }
      const message = choice.message;
      if (message.content?.trim()) run.finalText = message.content.trim();
      messages.push(message);
      const calls = (message.tool_calls ?? []).filter((c) => c.type === "function");
      if (!calls.length) {
        run.stop = choice.finish_reason === "stop" ? "done" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "content_filter" ? "refusal" : "other";
        return run;
      }
      for (const call of calls) {
        let args: Record<string, unknown> | undefined;
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch (err) {
          args = undefined;
          messages.push({ role: "tool", tool_call_id: call.id, content: `Invalid JSON in the tool arguments: ${(err as Error).message}` });
          run.toolCalls.push({ name: call.function.name, args: {}, isError: true });
          continue;
        }
        const result = await callTool(call.function.name, args);
        run.toolCalls.push({ name: call.function.name, args, isError: result.isError });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      }
    }
    return run;
  }

  async complete(system: string, prompt: string): Promise<string> {
    const response = await this.chat({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return response.choices[0]?.message.content ?? "";
  }
}

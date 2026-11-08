import { describe, expect, it } from "vitest";
import { checkOpenRouterModels, createModel, type CallTool, type ToolSpec } from "../src/index.js";

const tools: ToolSpec[] = [
  { name: "design_save", description: "Saves a design.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
];

const callTool: CallTool = async (name, args) => ({ text: `${name} saved ${String(args.title)}`, isError: false });

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** One Messages API answer as the server-sent events the SDK's stream reads. */
function sse(content: Block[], stopReason: string, usage: Record<string, number> = {}): Response {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, ...usage } } }],
  ];
  content.forEach((b, index) => {
    if (b.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("createModel", () => {
  it("needs provider:model and the provider's key", () => {
    expect(() => createModel("claude", {})).toThrow(/Use provider:model/);
    expect(() => createModel("acme:x", {})).toThrow(/Use provider:model/);
    expect(() => createModel("anthropic:claude-opus-5-5", {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(createModel("xai:grok", { XAI_API_KEY: "k" }).id).toBe("xai:grok");
  });
});

describe("Anthropic agent loop", () => {
  it("runs tools until the model ends its turn, sending results back", async () => {
    const bodies: any[] = [];
    const answers = [
      sse([{ type: "text", text: "Saving." }, { type: "tool_use", id: "tu_1", name: "design_save", input: { title: "HLD" } }], "tool_use"),
      sse([{ type: "text", text: "Saved the design." }], "end_turn"),
    ];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return answers.shift()!;
    }) as typeof fetch;
    const model = createModel("anthropic:claude-opus-5-5", { ANTHROPIC_API_KEY: "k" }, fakeFetch);
    const run = await model.runAgent("Draft the design.", tools, callTool);

    expect(run).toMatchObject({ finalText: "Saved the design.", turns: 2, stop: "done", inputTokens: 20, outputTokens: 10 });
    expect(run.toolCalls).toEqual([{ name: "design_save", args: { title: "HLD" }, isError: false }]);
    expect(bodies[0]).toMatchObject({ model: "claude-opus-5-5", stream: true, cache_control: { type: "ephemeral" }, tools: [{ name: "design_save", input_schema: { type: "object" } }] });
    expect(bodies[1].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "design_save saved HLD", is_error: false }],
    });
  });

  it("counts the input read from the cache and written to it", async () => {
    const answers = [
      sse([{ type: "tool_use", id: "tu_1", name: "design_save", input: { title: "HLD" } }], "tool_use", { cache_creation_input_tokens: 1000 }),
      sse([{ type: "text", text: "Done." }], "end_turn", { cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
    ];
    const fakeFetch = (async () => answers.shift()!) as unknown as typeof fetch;
    const run = await createModel("anthropic:claude-opus-5-5", { ANTHROPIC_API_KEY: "k" }, fakeFetch).runAgent("Draft.", tools, callTool);
    expect(run).toMatchObject({ inputTokens: 2070, cachedInputTokens: 1000, cacheWriteTokens: 1050 });
  });

  it("stops at the turn limit", async () => {
    const fakeFetch = (async () => sse([{ type: "tool_use", id: "tu", name: "design_save", input: { title: "x" } }], "tool_use")) as unknown as typeof fetch;
    const model = createModel("anthropic:claude-opus-5-5", { ANTHROPIC_API_KEY: "k" }, fakeFetch);
    const run = await model.runAgent("Loop.", tools, callTool, { maxTurns: 3 });
    expect(run).toMatchObject({ turns: 3, stop: "max_turns" });
  });
});

describe("OpenAI-compatible agent loop", () => {
  const completion = (message: Record<string, unknown>, finish: string) =>
    new Response(
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: finish }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("runs function calls, reports bad arguments to the model, and uses xAI's endpoint", async () => {
    const urls: string[] = [];
    const bodies: any[] = [];
    const answers = [
      completion(
        {
          tool_calls: [
            { id: "c1", type: "function", function: { name: "design_save", arguments: '{"title":"HLD"}' } },
            { id: "c2", type: "function", function: { name: "design_save", arguments: "{oops" } },
          ],
        },
        "tool_calls",
      ),
      completion({ content: "Done." }, "stop"),
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(init.body as string));
      return answers.shift()!;
    }) as typeof fetch;
    const model = createModel("xai:grok-x", { XAI_API_KEY: "k" }, fakeFetch);
    const run = await model.runAgent("Draft.", tools, callTool);

    expect(urls[0]).toMatch(/^https:\/\/api\.x\.ai\/v1\/chat\/completions/);
    expect(run).toMatchObject({ finalText: "Done.", turns: 2, stop: "done", inputTokens: 14, outputTokens: 6 });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([
      ["design_save", false],
      ["design_save", true],
    ]);
    const toolMessages = bodies[1].messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMessages[1].content).toMatch(/Invalid JSON/);
  });

  /** A streamed completion, as OpenRouter sends it: chunks, then usage, then [DONE]. */
  const streamed = (deltas: Record<string, unknown>[], finish: string) => {
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices, ...extra })}\n\n`;
    const body =
      deltas.map((delta) => chunk([{ index: 0, delta, finish_reason: null }])).join("") +
      chunk([{ index: 0, delta: {}, finish_reason: finish }]) +
      chunk([], { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  it("streams from OpenRouter with max_tokens, which it passes on to every vendor", async () => {
    const urls: string[] = [];
    const bodies: any[] = [];
    const answers = [
      streamed([{ role: "assistant", content: null, tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "design_save", arguments: '{"title":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"HLD"}' } }] }], "tool_calls"),
      streamed([{ role: "assistant", content: "Do" }, { content: "ne." }], "stop"),
      streamed([{ role: "assistant", content: "Fine." }], "stop"),
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(init.body as string));
      return answers.shift()!;
    }) as typeof fetch;
    const model = createModel("openrouter:anthropic/claude-opus-5.5", { OPENROUTER_API_KEY: "k" }, fakeFetch);
    const run = await model.runAgent("Draft.", tools, callTool);
    expect(run).toMatchObject({ finalText: "Done.", turns: 2, stop: "done", inputTokens: 14, outputTokens: 6 });
    expect(run.toolCalls).toEqual([{ name: "design_save", args: { title: "HLD" }, isError: false }]);
    expect(await model.complete("Judge.", "Score this.")).toBe("Fine.");

    expect(urls[0]).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/);
    expect(bodies[0]).toMatchObject({ model: "anthropic/claude-opus-5.5", max_tokens: 32_000, stream: true, stream_options: { include_usage: true } });
    expect(bodies[0].max_completion_tokens).toBeUndefined();
    // Anthropic's models cache only when asked: OpenRouter's top-level marker, the messages as they are.
    expect(bodies[0].cache_control).toEqual({ type: "ephemeral" });
    expect(bodies[0].messages).toEqual([{ role: "user", content: "Draft." }]);
    expect(bodies[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "design_save saved HLD" });
    expect(createModel("openrouter:~anthropic/claude-opus-latest", { OPENROUTER_API_KEY: "k" }, fakeFetch)).toBeDefined();
    // The assistant turn goes back as the API knows it.
    const assistant = bodies[1].messages.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0]).toMatchObject({ id: "c1", function: { name: "design_save", arguments: '{"title":"HLD"}' } });
    expect(assistant).not.toHaveProperty("parsed");
    expect(() => createModel("openrouter:x-ai/grok", {})).toThrow(/OPENROUTER_API_KEY/);
  });

  it("leaves the caching to other vendors through OpenRouter, and counts what they read from it", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices, ...extra })}\n\n`;
      const body =
        chunk([{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
        chunk([], { usage: { prompt_tokens: 900, completion_tokens: 3, total_tokens: 903, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 60 } } }) +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const run = await createModel("openrouter:x-ai/grok-7.1", { OPENROUTER_API_KEY: "k" }, fakeFetch).runAgent("Draft.", tools, callTool);
    expect(bodies[0].messages).toEqual([{ role: "user", content: "Draft." }]);
    expect(bodies[0].cache_control).toBeUndefined();
    expect(run).toMatchObject({ inputTokens: 900, cachedInputTokens: 800, cacheWriteTokens: 60 });
  });
});

describe("checkOpenRouterModels", () => {
  const list = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "anthropic/claude-opus-5.5", created: 3 },
          { id: "anthropic/claude-sonnet-4.5", created: 1 },
          { id: "anthropic/claude-sonnet-5.5", created: 2 },
          { id: "x-ai/grok-5", created: 1 },
          { id: "x-ai/grok-5:free", created: 1 },
        ],
      }),
    )) as unknown as typeof fetch;

  it("accepts listed ids and routing variants, and names the vendor's newest models for an unknown one", async () => {
    await expect(checkOpenRouterModels(["anthropic:claude-opus-5-5"], async () => fail())).resolves.toBeUndefined();
    await expect(checkOpenRouterModels(["openrouter:anthropic/claude-opus-5.5", "openrouter:x-ai/grok-5:free", "openrouter:anthropic/claude-sonnet-5.5:nitro"], list)).resolves.toBeUndefined();
    await expect(checkOpenRouterModels(["openrouter:anthropic/claude-opus-5-5"], list)).rejects.toThrow(
      /"anthropic\/claude-opus-5-5" is not a model OpenRouter lists\. Its newest anthropic models: anthropic\/claude-opus-5\.5, anthropic\/claude-sonnet-5\.5, anthropic\/claude-sonnet-4\.5\./,
    );
  });

  it("warns and goes on when the list cannot be read", async () => {
    const warnings: string[] = [];
    const html = (async () => new Response("<html>proxy</html>")) as unknown as typeof fetch;
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(checkOpenRouterModels(["openrouter:anthropic/x"], html, (m) => warnings.push(m))).resolves.toBeUndefined();
    await expect(checkOpenRouterModels(["openrouter:anthropic/x"], down, (m) => warnings.push(m))).resolves.toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe("OpenRouter's model list could not be read (HTTP 503), so the model ids are not checked.");
  });
});

function fail(): never {
  throw new Error("fetched");
}

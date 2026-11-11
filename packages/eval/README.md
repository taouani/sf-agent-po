# @sf-agent-po/eval

Measures how good the agents' output is. For each scenario and each model, the runner:

1. starts the MCP server over stdio with an empty workspace,
2. loads the scenario's inputs (and its local metadata, if any) into a context,
3. runs each task in the rubric in order (the SA's high-level design, then the PO's backlog),
   giving the model the server's own prompt and its tools, the way a client such as Claude
   Desktop would,
4. reads what the task saved, and has a judge model check it against the rubric.

A task's score is 10 × the share of its criteria met. A run's score is the mean of its tasks.
The target is at least 7/10 per model.

The model works alone: publishing to Jira or Confluence and adding inputs are not offered,
and the prompt says no one is there to answer questions, so the agent states its
assumptions and finishes.

## Running it

It calls paid APIs. Build first (the default server is `packages/mcp/dist/main.js`):

```bash
npm run build
export ANTHROPIC_API_KEY=...   # and/or OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY
node packages/eval/dist/cli.js --models anthropic:claude-opus-5-5,openai:<model>,xai:<model>
```

With one OpenRouter key, name models as OpenRouter lists them:
`--models openrouter:anthropic/<model>,openrouter:openai/<model>,openrouter:x-ai/<model>`. An id
OpenRouter does not list stops the run at once, with that vendor's ids to choose from.

### Through LiteLLM or a local model

`compatible:<model>` calls any OpenAI-compatible endpoint: a [LiteLLM](https://docs.litellm.ai)
proxy with your own provider keys behind it, or a local server (vLLM, Ollama, llama.cpp). Name
the model as the endpoint lists it (its `/models`):

```bash
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:4000   # Ollama: http://localhost:11434/v1
export OPENAI_COMPATIBLE_API_KEY=...                      # only if the endpoint asks for one
node packages/eval/dist/cli.js --models compatible:<model> --judge compatible:<judge model>
```

The runner streams and sends `max_tokens` (32,000). A local model with a short context may
refuse that: set `OPENAI_COMPATIBLE_MAX_TOKENS` lower. Prompt caching is up to the endpoint:
the runner marks nothing, so with Anthropic's models behind LiteLLM, set up prompt caching in
LiteLLM (see its prompt caching docs) to keep the cost down. The address must not hold a user name or password; put
the key in `OPENAI_COMPATIBLE_API_KEY`. A local model costs nothing, which makes it a free way
to check a change to a scenario or to the runner before a paid run.

Options: `--judge` (default: the first model), `--scenarios` (ids, default: all), `--server`
(a command that starts another MCP server, for example an installed release; split on spaces, or a JSON array
when a path has spaces), `--out` (default `eval-results/<date>`), `--max-turns` (default 80),
`--list`.

By default the first model also judges, so it scores its own output. For a comparison between
models, pick one fixed judge with `--judge` and keep it for later runs.

It writes `report.md` (scores by model and scenario, then every missed criterion) and
`results.json` (everything, including what was saved and each verdict's reason), and rewrites
both after every run, so a run cut short keeps what it measured. Only the last artifact a task
saves with its own save tool is judged. A task or judging failure scores that task 0 and is
listed in the report.

On GitHub, the **Eval** workflow does the same by hand (Actions, Eval, Run workflow), using the
repository secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` and `OPENROUTER_API_KEY`, and for
`compatible:` models `OPENAI_COMPATIBLE_BASE_URL` (an endpoint GitHub can reach, not `localhost`) and
`OPENAI_COMPATIBLE_API_KEY`. The report appears
in the run's summary.

## Scenarios

The runner finds every folder with a `scenario.json` in `examples/` and in
`packages/eval/scenarios/`:

| Id | Language | Industry | What it tests |
| --- | --- | --- | --- |
| `insurance-renewal` | en | insurance | Inputs plus local metadata |
| `banking-onboarding` | en | financial services | Inputs only |
| `luxury-clienteling` | en | luxury | Scope narrowed by a later email; privacy rules that need technical controls; China data |
| `luxe-service-apres-vente` | fr | luxury | Output in French; scope narrowed by a later email; CITES for exotic leathers; health data in notes |

A scenario folder holds:

- `scenario.json`: `id`, `title`, `industry` (optional), `language` (default `en`), `inputs`
  (default `inputs`) and `metadata` (optional, a local metadata folder);
- `rubric.md`: one `## <title> (<task>)` section per task, with `- [ ]` criteria. Sections
  without a task in brackets are notes for people. Tasks: `sa_high_level_design`, `po_backlog`.

The 0.x server is gone (phase 5). To compare against it, check out the tag `v0-final`, build it,
and run that checkout's runner with `--baseline`.

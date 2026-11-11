# Contributing to sf-agent-po

Thank you for helping. This guide covers the code layout, the checks every change must pass, the rules for the database and for masking, and how to change the agents' domain knowledge without writing code.

## Layout

The code is in npm workspaces under `packages/`:

| Package | What it holds |
| --- | --- |
| `packages/core` | The workspace database and its migrations, masking (rules, dictionary, the name model, the vault), the metadata index, the workflow store, feedback, and the domain content in `content/` |
| `packages/connectors` | Readers for input files (PDF, Office, CSV, draw.io, email), Jira and Confluence, org retrieval with the `sf` CLI, repository clones, and indexing |
| `packages/mcp` | The MCP server, its tools and prompts, the guided workflows, the approval pages, and the `init`, `index`, `key`, `doctor` and `report` commands. This is the published `sf-agent-po` package |
| `packages/eval` | The evaluation runner: scenarios, a judge model, and the report |

`examples/` holds the sample scenarios, `scripts/pack-next.mjs` builds the npm package from the workspaces, and `spikes/` holds the phase 0 experiments (with their own lockfile). The [v1 plan](docs/plan.md) and the phase plans explain why things are as they are.

## Set up

Node.js 24 or later.

```bash
npm ci
npm run build
```

Tests import each package's TypeScript sources, so a stale build never hides a change. The MCP server runs from `packages/mcp/dist/main.js` once built.

## Checks

Run both before every push:

```bash
npm run typecheck
npm test
```

`typecheck` also checks the tests (each package's `tsconfig.check.json`). `npm test` first copies the ONNX Runtime files into `packages/core/vendor/`. Some tests run only where they can, and CI runs them:

| Test | Runs with |
| --- | --- |
| The real name model (`masking-model.test.ts`) | `SF_AGENT_PO_MODEL_TEST=1`, and access to huggingface.co |
| The approval page in Chromium (`browser.test.ts`) | `SF_AGENT_PO_BROWSER_TEST=1`, after `npx playwright-core install chromium-headless-shell` |
| This computer's key store (`keychain.test.ts`) | `SF_AGENT_PO_KEYCHAIN_TEST=1`; on Linux also `SF_AGENT_PO_SECRET_SERVICE=1`, with an unlocked Secret Service. It writes a real key and removes it after |
| The installable package | `node scripts/pack-next.mjs --smoke --smoke-server` |

Tests must not leave keys behind: the key folder in your config folder (`~/.config/sf-agent-po/keys` on Linux) should be as empty after `npm test` as before. GitHub's push protection rejects literals that look like tokens, so build fake tokens at run time in tests.

## Pull requests

Keep one change per pull request, with its tests. Every pull request gets a code review before it is merged, and CI runs the checks on Linux, macOS and Windows. A user-visible change updates the docs it affects (the [package README](packages/mcp/README.md), the [user guide](docs/user-guide.md), [troubleshooting](docs/troubleshooting.md)) in the same pull request.

A release is a version bump of `packages/mcp/package.json` merged to `main`, then the Release next workflow, which publishes to npm under `next`.

## Database migrations

Migrations (`packages/core/src/store/migrations.ts`) are append-only. Never edit or reorder a migration that has been merged: add a new one with the next version number. Each one runs once per database, in a transaction. A newer database is refused by an older server and by `doctor`, and the commands that only read (`doctor`, `report`) open it read-only, so they never migrate a workspace whose server has not been upgraded.

## Masking rules

Masking is what lets the agents work on real inputs. Every change that touches inputs or outputs must keep these rules:

1. **Every input is stored masked.** An input becomes a document only through the `Masker` (`maskDocument`, or the intake in `packages/mcp/src/inputs.ts`): title, content and every metadata string. A new reader returns text and metadata; it never writes to the store or returns text to a tool itself. The metadata index is the exception: it keeps the org's metadata as retrieved (as do the `orgs/` and `repos/` folders), and is masked whenever a tool returns it.
2. **Everything returned to the model is masked.** Tool results carry pseudonyms (`[PERSON_1]`), never real values. Text read from Jira or Confluence for a comparison (the feedback Jira diff) is used and dropped: it is not stored or returned.
3. **Real values only on approval pages and in the final write.** The publish page shows what will be written, with real values, and the publish itself unmasks. Secrets stay masked even there. An approval page's link never reaches the host or the model.
4. **Images are confirmed.** An image is redacted and the user confirms it before the model sees it, whatever the input review setting.
5. **Nothing real in logs or errors.** Error messages and the server log name files and counts, not values. `doctor` output shows no token, username or masked value.
6. **Pseudonyms in inputs are text.** Text in an input that looks like a pseudonym is masked as a literal, so a publish cannot turn it into someone's real name.

The tests in `packages/core/test/ingest.test.ts`, `masking.test.ts` and the tool tests in `packages/mcp/test` check these. A new reader or tool adds a test that its output is masked.

## Domain content without code

The agents' Salesforce knowledge is Markdown in [`packages/core/content`](packages/core/content): industry templates, the agents' roles and practices, the design templates, and the word lists the quality checks use in English and French. An SA or PO can change it with a pull request that touches only those files; the [content README](packages/core/content/README.md) gives each file's format, and the tests check every file. To add an industry, copy an existing file in `industries/`, give it a new `id` (the file name) and its aliases, and fill the five sections.

Sample scenarios for the evaluation runner go in `examples/` or `packages/eval/scenarios`: inputs, a `scenario.json` and a `rubric.md` (see the [eval README](packages/eval/README.md)).

## Reporting a problem

Open an issue with the output of `npx -y sf-agent-po@next doctor`, which is safe to paste. Never paste inputs, tokens, or the output of `key export`.

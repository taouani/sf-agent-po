# sf-agent-po: Phase 1 repository review

> Copy of the [sf-agent-po: Phase 1 repository review](https://claude.ai/artifact/JBucxLtXXBCrmhTQVjDSde) Claude Doc, which stays the working version. Written on 6 Nov 2026, before the v1 rebuild; it describes the 0.x server as it was then. The decisions it led to are in the [v1 plan](plan.md). The diagram is only in the doc.

## 1. What it does and who it is for

sf-agent-po is a local MCP server (TypeScript, about 3,300 lines of source and 1,400 lines of tests) that turns Claude Code, Cursor or VS Code Copilot into a Salesforce Solution Architect and Product Owner. It does no AI reasoning itself: the host's model does the thinking, and the server supplies inputs, method, storage, checks and publishing.

**What it does (fact, from `README.md` and `src/`):**

- **Collects inputs** into a named "requirement context": local notes and `.eml` emails, pasted text, Jira issues, Confluence pages, a Salesforce DX metadata repo (local, GitHub, GitLab, Azure DevOps, git) and a live org through the `sf` CLI (`src/tools/context.ts`).
- **Gives the model a method**: four workflows (SA high-level design, SA detailed design, PO backlog, PO story review) as MCP prompts, with 11 industry templates (`src/agents/`).
- **Stores outputs** (designs as Markdown, backlogs as structured JSON) as versioned artifacts inside the same context, so either agent can go first (`src/artifacts/`).
- **Checks backlogs** with a deterministic quality check: INVEST signals, vague wording, dependency cycles, traceability to inputs (`src/artifacts/backlog.ts`).
- **Publishes** to Confluence pages and Jira epics and stories, behind a signed preview token and optional MCP elicitation (`src/tools/confluence.ts`, `src/tools/backlog.ts`).
- **Packages itself** for each host with `sf-agent-po init`, which writes native agent and command files (`src/hosts/`).

**Who it is for:** an individual Salesforce SA or PO working in an AI coding tool, with Jira and Confluence on Atlassian Cloud. Today that is you, as a prototype (fact, from project notes). The stated future is a product used daily by any SA or PO across industries (fact, from project notes; nothing in the code is built for that yet).

## 2. Architecture map

The server is a thin MCP adapter around one local JSON store; all intelligence sits in the host's model.

*Diagram in the Claude Doc: sf-agent-po architecture · host, server, store, external systems.*

A typical run: the user asks the host to add inputs (context tools write them to the store), runs a workflow prompt, and the model saves a design or backlog as an artifact in the same store. Publishing reads the artifact, shows a preview with a signed token, and writes to Jira or Confluence only when the token still matches. Module map: `src/tools/` registers tools, `src/connectors/` talks to Atlassian and `sf`, `src/loaders/` and `src/metadata/` parse inputs, `src/agents/` holds all prompt text, `src/publish/` converts and signs, `src/hosts/` generates host files.

## 3. Current tech stack

The stack is small, current and dependency-light: five runtime packages, all at or one patch behind their latest release (`npm outdated`, 6 Nov 2026). Typecheck is clean and all 67 tests pass in 1.7 s on Node 22.

| Layer | Choice | Version | Where |
| --- | --- | --- | --- |
| Language | TypeScript, strict, ES modules | 7.0.2 | `tsconfig.json` |
| Runtime | Node.js | `>=20` declared, tested on 22 | `package.json` |
| Protocol | MCP over stdio | `@modelcontextprotocol/sdk` 1.32.2 | `src/index.ts`, `src/server.ts` |
| Validation | Zod schemas for tool inputs and the backlog | 4.6.7 | `src/artifacts/backlog.ts` |
| Parsing | `postal-mime` (email), `fast-xml-parser` (metadata XML), `marked` (Markdown to Confluence) | 4.1.4, 5.11.2, 18.1.1 | `src/loaders/`, `src/metadata/`, `src/publish/` |
| Storage | One JSON file per context on local disk | none | `src/context/store.ts` |
| Jira and Confluence | Direct REST (Jira v3, Confluence v2) with email and API token | none | `src/connectors/atlassian.ts` |
| Salesforce | The user's `sf` CLI, read-only | none | `src/connectors/salesforce.ts` |
| Git hosts | The user's `gh`, `glab` and `git` CLIs | none | `src/metadata/sources.ts` |
| Tests | Vitest with an in-memory MCP client and a fake Atlassian | 5.0.5 | `test/` |
| Build and release | `tsc` to `dist/`, run from a local clone; no CI, no npm package, no lint config | none | `package.json` |

## 4. What I am confident about and what I am not

I am confident about how the code behaves against fakes. I am not confident about how it behaves against other users or real-sized inputs. You have used it against live Jira, Confluence, an org and a local repo, but the automated tests never touch a live system.

**Confident (read in the code and confirmed by passing tests):**

- The server exposes 20 tools and 4 prompts, all registered in `src/server.ts` and the `src/tools/` files.
- Contexts are JSON files under `SF_AGENT_WORKSPACE`, written atomically (temp file plus rename) and serialised per context within one process (`src/context/store.ts`).
- Publishing is two-step. The preview's token is an HMAC over the exact content, target and current page or issue state, so any drift forces a new preview (`src/publish/approval.ts`).
- Jira republishing is idempotent by stable ids (E1, S1), saves progress after every issue, and keeps labels, status and assignee set in Jira (`src/tools/backlog.ts`).
- The prompt text is defined once and reused by the MCP prompts, the `agent_workflow` tool and the generated host files, so they cannot drift (`src/hosts/files.ts`).

**Not sure (assumptions or untested):**

- **Live Jira:** whether the "Blocks" link direction is right (the code says inward means blocker, `atlassian.ts` line 127), and whether setting `parent` works in your Jira project type. You have used it live; worth a glance that links and parents came out the right way round.
- **Live Confluence:** publishing works live (you confirmed). Mermaid diagrams are published as code blocks, not drawings, which I assume you did not intend.
- **Live org:** `context_add_org` has run against a real org (you confirmed); Windows is still untested.
- **Host behaviour:** whether Cursor and Copilot pick up the generated files as intended, and which hosts support MCP elicitation today. Assumption: some hosts fall back to their own tool-approval prompt only.
- **Scale:** how a real org's metadata (thousands of fields, hundreds of flows) fits in the model's context window. Assumption: it will not, for a large org.
- **Output quality:** whether the designs and backlogs are good. The rubrics in `examples/` exist, but nothing runs them automatically.
- **Usage:** how often you have used it on real work since 23 October. Git history shows no change after 30 October.

## 5. Unfinished, broken, unused or contradictory

Nothing is broken in the sense of failing checks. The real problems are things that are claimed or assumed but not true, ranked roughly by how much they would hurt.

| # | Finding | Evidence | Kind |
| --- | --- | --- | --- |
| 1 | Live use is manual only. You have run it against live Jira, Confluence, an org and a local repo, but every automated test uses fakes, so a regression would go unnoticed. The user guide still says "Windows has not been tested yet". | `test/helpers.ts` fake fetch; `docs/user-guide.md` Troubleshooting | Unfinished |
| 2 | The approval token does not prove the user approved. The model receives the token in the preview and can pass it straight to publish. Only MCP elicitation, where the host supports it, puts a human in the loop. The token stops drift, not self-approval. | `src/tools/backlog.ts` preview and publish; `confirmWithUser` in `src/tools/shared.ts` returns silently without elicitation | Contradiction with README wording |
| 3 | No limit on what goes to the model. `context_read` returns every document in full, and the metadata inventory lists up to 50 fields for every object. A real org will flood or overflow the context window. | `src/tools/context.ts` `context_read`; `inventoryToMarkdown` in `src/metadata/inventory.ts` | Will break at scale |
| 4 | "Shared by every host pointed at the same workspace" is not safe. The lock is in-memory per process, so two hosts writing the same context at once lose one write. | `KeyedLock` in `src/util/lock.ts`; `README.md` Tools section | Contradiction |
| 5 | The org connector is shallow: custom object names plus describes of named objects. It does not read flows, Apex, validation rules or permissions from the org, so `org` documents cannot support the "impact on existing org" analysis the prompts ask for. | `src/connectors/salesforce.ts` | Unfinished |
| 6 | Metadata scan is source format only. It counts layouts, validation rules, record types and profiles but does not read them; MDAPI-format repos are not supported. | `src/metadata/inventory.ts`; README "Only the source format" | Unfinished |
| 7 | Common input formats are rejected: Word, PDF, Outlook `.msg`, PowerPoint. SAs receive most inputs in these. | `TEXT_EXTENSIONS` in `src/loaders/documents.ts`; user guide Troubleshooting | Gap |
| 8 | Mermaid diagrams in designs reach Confluence as code text, not as diagrams. | `markdownToStorage` in `src/publish/storage.ts` | Gap |
| 9 | Output quality is not measured. Rubrics and a reference backlog exist, but only the reference backlog is tested; no model output is ever scored. | `examples/*/rubric.md`; `test/packaging.test.ts` "sample scenarios" | Unfinished |
| 10 | No CI. CLAUDE.md requires typecheck and tests before every push, but nothing enforces it on GitHub. | No `.github/workflows/` | Gap |
| 11 | Not installable as a product: no npm package or release, users clone and build, and credentials are a personal Atlassian API token in plain host config. | `package.json` (no `files`, no publish); README Setup | Gap for the product goal |
| 12 | Version numbers disagree: the package says 0.1.0, the server reports 0.4.0. | `package.json` line 3; `src/server.ts` line 22 | Contradiction |
| 13 | `engines` allows Node 20, which reached end of life on 30 April 2026. | `package.json` `engines` | Minor |
| 14 | Industry templates are hard-coded prose in TypeScript, so changing them needs a code release, and product names will age. | `src/agents/industries.ts` | Design debt |

Nothing looked unused: every module is reachable from `src/server.ts` or the `init` command.

## 6. Phase 2: goal statement (confirmed)

**Purpose.** An open-source Salesforce Solution Architect and Product Owner agent. From a handful of inputs and a large existing org, it produces high-level designs, detailed designs and Jira-ready backlogs that the SA, PO and dev team accept with few edits.

**Users.** In-house Salesforce SAs and POs. They work in VS Code Copilot, Cursor and Claude Code (you will test them in that order). Each uses their own Atlassian Cloud API token and their own choice of model.

**Success criteria.**

- **Stories accepted:** a high share of generated stories are accepted by the PO, SA and dev team. Jira cannot measure this today, so the tool itself must record it (how is a Phase 4 decision).
- **Design relevance:** the SA judges the high-level and detailed designs relevant to the org and the inputs.
- **Any model:** answers are satisfying with any capable model (tested so far: Opus 5.5, GPT Sol 6.1, Grok 7.1). The product recommends no model.
- **Large orgs:** it works on orgs with more than 9,000 metadata components.

**Constraints.**

- Ships by 30 June 2027, with everything in scope: large-org handling, new input formats, quality, masking and packaging.
- Built by you and Claude. No hosting cost: everything runs on the user's machine.
- Personal data as defined by GDPR, PIPL and CCPA/CPRA, and credentials, are masked before any model sees them.
- Jira and Confluence on Atlassian Cloud only. Metadata repos can be local, GitHub, GitLab or Azure DevOps.
- Inputs: at most about 10 small documents per engagement, in today's formats plus images, PDF, DOCX, PPTX, XLSX, CSV and draw.io.
- A full rewrite and a new stack are allowed if they bring major gains.

**Out of scope for the first version:** a web app, Atlassian Data Center, Azure DevOps Boards.

**One limit to accept.** The tool can only mask what passes through its own tools. Text a user pastes into the chat, or a file the host attaches itself, goes straight to the model. The product can steer users to add inputs through its tools, but it cannot enforce that.

## 7. Decision: how much of the org the agents see

**Decided on 6 Nov 2026: option B**, server-computed scope, with query tools on top.

My recommendation is option B: the server works out the feature's scope from a local index of the metadata, and sends full detail for that scope plus a short summary of the rest. It is the only option that puts the same, right evidence in front of every model, and that is what both of your success criteria and the any-model goal depend on.

For scale: today's inventory format costs about 10 to 15 tokens per field line. At 9,000+ components, names alone come to roughly 100,000 tokens or more, and that still leaves out what flows and Apex actually do (my estimate, not measured).

|  | A. Whole org every time | B. Scope computed by the server (recommended) | C. Model explores with query tools |
| --- | --- | --- | --- |
| How it works | Send the full inventory, as today, extended with more metadata types | Build a local index and dependency graph. From the inputs, the model proposes the objects in scope and you confirm them. The server adds one or two hops of related fields, flows, triggers, Apex, validation rules and permissions. It sends that in full, plus a one- or two-page org summary | Same index, but no precomputed scope. The model calls tools (search, describe object, automation on an object, find references) until it decides it has enough |
| Pros | Simplest; nothing hidden by a scoping mistake | Fits any model's context window; the same evidence for every model; deterministic and testable; makes the "impact on existing org" section concrete (which automation fires on this object) | Flexible; no scoping step; strong models dig exactly where needed |
| Cons | Overflows or crowds out many models' windows; weaker models lose details in long input, so quality drops first where you need it to hold; slow and costly per run; flow and Apex logic would not fit at all | Anything outside the scope stays invisible unless the graph catches it (dynamic Apex, SOQL built from strings, long formula chains); deeper metadata parsing is the largest build item; adds one confirmation step | Quality depends on the model's tool-use skill, so weaker models stop early or wander; many tool calls, which means slow runs and approval prompts in Copilot; results vary between runs and are hard to test |
| Effort | Low | High | Medium (the index without the scoping logic) |
| Risk | High: poor quality on large orgs | Medium: missed dependencies | Medium to high: inconsistent across models |
| Fit with the goal | Poor | Strong | Partial: works with strong models only |

B and C are not exclusive. B needs the same index C uses, so the query tools come almost free on top. The model can then fetch something the scope missed.

**Impact on the final product if you choose B:**

- **A local metadata index becomes the core component.** It is probably an embedded database; the choice belongs to the stack decision in Phase 4.
- **The metadata parser goes much deeper.** It reads flow logic, Apex references, validation rules, record types, permission sets and layouts, in both source and MDAPI format. Org access moves from per-object describes to retrieving metadata into the same index.
- **Both workflows gain a scope step.** The agent proposes the objects in scope and you confirm them before it drafts.
- **Designs get a graph-driven impact section,** which can be tested against fixtures.
- **Masking applies to the index too.** Metadata is mostly not personal data, but descriptions, help text, picklist values and Apex comments can be.

## 8. Phase 3: assessment against the goal

The parts that are already proven on live systems are worth keeping: publishing, the backlog model and the prompt content. But the three hardest goal requirements are not started at all: masking, large orgs, and measuring quality across models. I estimate that about half of today's code carries forward as is or with light changes, mainly publishing, connectors, the backlog schema and the prompt content. The store, the metadata scan and the loaders need replacing (my estimate, by line count).

### Strengths worth keeping

1. **The host model does the reasoning and the server supplies tools.** This fits the goal exactly: any model, the user's choice, no hosting cost (`src/server.ts`).
2. **Publishing is safe and proven live.** It previews before writing, republishes idempotently by stable ids (E1, S1), saves progress after every issue, detects drift, merges labels and checks the Confluence version (`src/tools/backlog.ts`, `src/tools/confluence.ts`). This is the hardest part to get right, and it works.
3. **Backlogs are structured, with a deterministic quality check.** Stories are typed data, not free text, and the check catches vague criteria, generic personas, dependency cycles and untraced inputs. This directly serves the share of stories accepted (`src/artifacts/backlog.ts`).
4. **The domain content is the product's real value.** It covers SA principles, the two design templates, PO practices, the evidence rules (cite document ids, never claim a component exists without proof, raise conflicts as open questions) and 11 industry templates (`src/agents/`).
5. **Prompt text has one source** and is reused by the MCP prompts, the `agent_workflow` tool and the files for all three hosts, so they cannot drift (`src/hosts/files.ts`).
6. **Security habits are good.** No shell, validated arguments, credentials stripped from clone URLs, and `init` refuses to follow symbolic links out of the project (`src/util/exec.ts`, `src/metadata/sources.ts`, `src/hosts/init.ts`).
7. **The test harness is fast and realistic:** a real MCP client in memory against a fake Atlassian site, with 67 tests in under 2 seconds (`test/helpers.ts`).
8. **The project is ready to be open source:** MIT licence, a small dependency set and a thorough user guide.

### Weaknesses, debt and risks, ranked by impact on the goal

| # | Weakness | Why it matters for the goal | Evidence | Impact |
| --- | --- | --- | --- | --- |
| 1 | **No masking of any kind.** Emails, meeting notes, Jira issues and Confluence pages reach the model as written, with names, emails and phone numbers. Only credentials in clone URLs are removed. | Breaks a hard constraint. Masking also has to be reversible, so that what is published to Jira and Confluence carries the real names again. | `renderDoc` in `src/tools/shared.ts`; `redactLocation` in `src/metadata/sources.ts` is the only redaction | Critical |
| 2 | **The metadata model is too thin for decision B.** It has no index, no dependency graph and no scope. Flows are read for their header only, Apex for its line count, and validation rules, record types and layouts are only counted. Fields beyond 50 per object are silently dropped, and MDAPI format is not read. | Design relevance on a 9,000-component org depends on knowing what fires on the objects a feature touches. | `src/metadata/inventory.ts` | Critical |
| 3 | **Quality is not measured, and acceptance is not captured.** No evaluation runs the agents on the sample scenarios with different models, and nothing records which stories were accepted or how the SA rated a design. | Neither success criterion can be tracked, and any prompt change is a guess, especially for the any-model goal. | `examples/*/rubric.md` are only read by hand | High |
| 4 | **Designs have no structure and no checks.** A design is one Markdown string generated in a single pass. Nothing checks that it cites real components, covers every input or fills every template section, unlike backlogs. | Weaker models skip sections or invent components, and the SA judges exactly that. | `design_save` in `src/tools/design.ts` | High |
| 5 | **Input formats are missing:** PDF, DOCX, PPTX, XLSX, images and draw.io. CSV and JSON are read as raw text. Images are the hardest case: a model reading an image sees any personal data in it. | These are most of an SA's real inputs. | `TEXT_EXTENSIONS` in `src/loaders/documents.ts` | High |
| 6 | **The org connector is separate and shallow.** It describes objects one by one instead of retrieving metadata into the same model as the repo scan. | Two paths with different depth; neither feeds a graph. | `src/connectors/salesforce.ts` | High |
| 7 | **Approval is not enforced without elicitation.** The model holds the approval token and can publish on its own. | Open-source users will assume "approval-gated" means a human approved. Copilot, your first test host, is where to confirm elicitation works (my assumption: VS Code supports it). | `confirmWithUser` in `src/tools/shared.ts` | Medium |
| 8 | **The store is one JSON file per context,** holding every input in full plus every artifact, behind a lock that only works within one process. It has no schema version or migration. | Index, masking map and feedback all need a real store, and open-source users will upgrade across format changes. | `src/context/store.ts`, `src/util/lock.ts` | Medium |
| 9 | **Nothing is ready to ship:** no npm package, no CI, no release process, versions disagree (0.1.0 and 0.4.0), Node 20 is end of life, and Windows is untested. | Required to ship by 30 June 2027. | `package.json`, `src/server.ts` | Medium |
| 10 | **Industry content is hard-coded prose** in TypeScript, so contributors must change code to improve it. | Open-source contributors are mostly domain experts, not TypeScript developers (assumption). | `src/agents/industries.ts` | Low |
| 11 | **Mermaid diagrams reach Confluence as code text.** | The SA reads designs in Confluence. | `src/publish/storage.ts` | Low |
| 12 | **Large tool files mix concerns:** planning, preview, publish and prompts sit in one 443-line file. | Slows change for a team of one plus Claude. | `src/tools/backlog.ts` | Low |

### Gaps between today and the goal

Four requirements are met, three are partly met, and six need new work. The new work concentrates in three areas: the metadata index (decision B), masking, and measuring quality.

| Goal requirement | Today | Gap |
| --- | --- | --- |
| Mask personal data (GDPR, PIPL, CCPA/CPRA) and credentials before any model sees it | Nothing masked except credentials in clone URLs | New: detection, reversible pseudonyms, unmasking on publish, and the same rules for the metadata index |
| Work on orgs with 9,000+ components, scoped by the server (decision B) | Full inventory dumped as Markdown, capped at 50 fields per object | New: index, parsers for flows, Apex, validation rules and permissions, dependency graph, scope step, query tools, org summary |
| Satisfying output with any model, no recommended setup | Tuned by use, best on Opus 5.5; no evaluation | New: an evaluation run across models on the sample scenarios; designs broken into checked steps |
| Measure the share of stories accepted | Not captured; Jira cannot measure it | New: record accept, edit or reject per story inside the tool |
| SA judges design relevance | Not captured | New: SA rating per design, plus rubric scoring in the evaluation |
| Inputs: images, PDF, DOCX, PPTX, XLSX, CSV, draw.io | Markdown, text, HTML, `.eml`; CSV and JSON as raw text | New: extractors for each format, all passed through masking |
| Ships as an open-source product by 30 June 2027 | Clone and build; no CI, no npm package | Partial: packaging, CI, releases, store migrations, Windows support, contributor guide |
| Three hosts, tested Copilot, then Cursor, then Claude Code | Agent and command files generated for all three | Partial: verify on Copilot first; Cursor's move from commands to skills |
| Human approval before any write | Signed preview token, plus elicitation where the host supports it | Partial: confirm elicitation in each host, or add a gate the model cannot pass alone |
| Detailed designs and Jira-ready backlogs | Both work and publish live | Met; improves with the index and design checks |
| Jira and Confluence on Atlassian Cloud, personal API token | Works live | Met |
| Repos: local, GitHub, GitLab, Azure DevOps | Works for source format | Met, except MDAPI format (rolled into the index work) |
| No hosting cost, built by you and Claude | Runs locally inside the host | Met |

## 9. Phase 4.1: architecture decisions

**Decided on 6 Nov 2026: all five recommendations accepted** (AR1 a, AR2 a, AR3 b, AR4 as described, AR5 b).

Architecture has five decision points, AR1 to AR5. For each one I recommend an option, and none of them is decided until you choose. Phase 4 order (agreed 6 Nov): architecture, stack, design, features, migration.

### AR1. Where masking sits

I recommend masking at the moment an input enters the tool. The model then only ever sees pseudonyms, and only the final write to Jira or Confluence puts real values back.

|  | a. Mask on the way in (recommended) | b. Store raw, mask on every read |
| --- | --- | --- |
| How it works | Each input is masked when added: names, emails, phones, addresses and credentials become stable pseudonyms such as `[PERSON_3]`. The masked text is what the store serves. The original and the pseudonym map are kept encrypted on disk, so inputs can be masked again when the detector improves | The store keeps raw text. Every tool that returns text to the model must call the masker |
| Pros | One choke point, easy to test; no raw personal data on any path to the model; artifacts are written with pseudonyms, so they stay safe too | The detector can change at any time without re-adding inputs |
| Cons | A missed detection stays in the masked copy until re-masked; the encrypted vault needs a key, held in the OS keychain | Any new tool that forgets to mask leaks data; raw personal data sits in plain files in a workspace that may be a shared folder |
| Risk | Low to medium | High |

Two consequences follow from a, whatever the stack:

- **Previews must stay masked.** A preview returned to the model must not contain real names, so the human sees the unmasked version through the approval step (AR5), never through the chat.
- **One option is ruled out:** a proxy between the host and the model provider. Copilot and Cursor do not let you reroute their model traffic, as far as I know (assumption).

### AR2. How the server runs and indexes a large org

I recommend option a: one process per host, as today, with an embedded database that several processes can share safely. Long indexing runs as a background job with progress reporting, and also as a command for the terminal.

|  | a. One process plus embedded DB (recommended) | b. Local background service plus thin MCP adapters |
| --- | --- | --- |
| How it works | Each host starts the server as now. The index, store and vault live in one database file that handles concurrent processes. Indexing 9,000+ components runs in the background, and `sf-agent-po index` does the same in a terminal | One long-running local service owns the data; each host talks to it through a small MCP adapter |
| Pros | Install stays one command; fixes today's lost-write problem; no ports or services to manage | Long jobs and sharing between hosts are natural; one place for logs |
| Cons | A host restart cancels a running background index (it resumes from its checkpoint) | Service lifecycle, ports and start-up on Windows, macOS and Linux; much harder for open-source users to install and debug |
| Effort | Medium | High |

### AR3. How designs and backlogs are produced

I recommend option b, server-guided steps. It is the one most likely to give satisfying output on weaker models, which is the hardest part of your goal. Its cost is more tool calls per run.

|  | a. One pass, checked after saving | b. Server-guided steps (recommended) | c. The server calls a model itself |
| --- | --- | --- | --- |
| How it works | As today, the model writes the whole design from one prompt. On save, the server checks it: every template section present, every cited component exists in the index, every input cited | The server runs a workflow as steps: extract requirements as a list, confirm scope (decision B), draft each section or epic with only the evidence it needs, check it, then assemble. Each tool call returns the next step and its evidence. Designs become structured (sections, decisions, components, requirement links), like backlogs already are | Through MCP sampling or the user's own API key, the server asks a model for each step itself |
| Pros | Least work; strong models keep full freedom | Small, focused prompts suit weaker models; a check after every step; the same path for every model; requirement-to-design-to-story traceability comes for free | Full control of every prompt |
| Cons | Weaker models still have to hold the whole design at once, and checks only catch errors after the work is done | 10 to 30 tool calls per design instead of a few (my estimate), so slower runs and more approval prompts in Copilot; the largest build item after the index | Sampling support differs by host (unverified for Cursor and Copilot); an API key adds setup and cost, and moves model choice into the tool |
| Fit with "any model" | Partial | Strong | Strong, but at odds with "the host's model, user's choice" |

### AR4. Where quality and acceptance are recorded

There is one clearly best answer here, in two parts.

- **In the product:** record feedback locally. For each story, record accepted, edited or rejected; for each design, the SA's rating and comments. Also compare each published Jira issue with its current content when the user next refreshes. A story rewritten after publishing was not accepted as is, so this gives an acceptance signal without changing your Jira workflow.
- **In development:** an evaluation run for each release. It plays the sample scenarios on several models, scores the output against the rubrics with deterministic checks plus a model as judge, and compares the result with the last release. It runs on your machine with your own API keys, so no hosting is needed. The model calls cost money per run (amount not estimated).

### AR5. How a human approves each write

I recommend option b. It closes the self-approval gap in every host and also solves the masked-preview problem from AR1.

|  | a. Elicitation only | b. Elicitation, with a local approval page as fallback (recommended) | c. Keep today's token |
| --- | --- | --- | --- |
| How it works | Publishing requires the host's confirmation prompt; hosts without it cannot publish | Where the host supports elicitation, the confirmation goes there. Either way, the server opens a page on localhost showing the unmasked preview, and the write runs only after the user clicks Approve | Signed token plus elicitation where available, as now |
| Pros | Simple; approval comes from the user, not the model | A gate the model cannot pass in any host; the human sees real names and the model never does | No new work |
| Cons | Elicitation shows a short message, not the full unmasked preview; it may lock out a host | A small local web page to build and test; a browser tab opens for each publish | The model can approve itself where elicitation is missing; previews leak real names once masking exists |

## 10. Phase 4.2: technical stack decisions

**Decided on 6 Nov 2026: all five recommendations accepted** (ST1 a, ST2 to ST5 as described).

I recommend keeping TypeScript on Node. A rewrite in Python would gain better document and personal-data tooling, but it would lose Salesforce's own metadata libraries, which decision B depends on most. Package versions below were checked on npm on 6 Nov 2026.

### ST1. Language and runtime

|  | a. TypeScript on Node (recommended) | b. Python | c. TypeScript server plus a Python helper |
| --- | --- | --- | --- |
| Metadata (decision B, the largest build item) | Salesforce's own libraries: `@salesforce/source-deploy-retrieve` 13.12 reads source and MDAPI format with the full metadata type registry; `@apexdevtools/apex-parser` 5.3 parses Apex | No official Salesforce libraries; registry, MDAPI handling and the Apex parser would be built from scratch | As a |
| Documents and personal data | Adequate: `officeparser`, `unpdf`, `tesseract.js`, and NER models run locally through `@huggingface/transformers` | Strongest: Microsoft Presidio, `markitdown`, IBM `docling` | As b, for the parts in the helper |
| Install for users | `npx sf-agent-po`. SAs and POs mostly have Node already, because the `sf` CLI is built on it | `uvx` or `pip`; Python setups on locked-down corporate laptops are a common pain (assumption); NER models are large downloads | Both runtimes on every machine, the hardest install |
| Reuse of today's code | About half, as assessed in Phase 3 | None | About half |
| Your skills | You prefer TypeScript | New stack for you | Two stacks to maintain |
| Main risk | Personal-data detection quality in JavaScript, especially for Chinese names under PIPL | Rebuilding the Salesforce metadata layer | Install and support burden |

The main risk of option a should be tested first: a one-week spike that runs a local multilingual model on the sample inputs and measures what it misses. If the spike fails, option c becomes the fallback for the masking component only.

### ST2. Embedded database

The clear answer is **SQLite**, with full-text search (FTS5) for metadata search and a table of edges for the dependency graph, walked with recursive queries. It handles several processes on one file, which AR2 needs. DuckDB is the main alternative and is ruled out: it allows only one process to write at a time. The driver, Node's built-in `node:sqlite` or `better-sqlite3` 13.0, is settled in the spike by testing install on Windows, macOS and Linux.

### ST3. Metadata parsing and org access

I recommend a split. Use **`source-deploy-retrieve` to read metadata files** in both formats. Keep **the user's `sf` CLI to retrieve metadata from an org** (`sf project retrieve`), so the org's sign-in stays where users already manage it. Parse flows with the existing `fast-xml-parser` and Apex with `apex-parser`. The alternative of calling the org's API from the server through `@salesforce/core` saves a process per call. But it ties the tool to the CLI's internal sign-in files and adds a large dependency tree.

### ST4. Document extraction and personal-data detection

| Input | Recommended library | Note |
| --- | --- | --- |
| DOCX, PPTX, XLSX, ODF | `officeparser` 8.6 | One library for all Office formats (`exceljs` is left out: no release since Dec 2024) |
| PDF | `unpdf` 2.1 | Text-based PDFs; scanned pages go through OCR |
| Images and scanned PDFs | `tesseract.js` 7.0, run locally, then masked | The image itself never goes to the model. Diagrams in screenshots lose their layout and keep only their text |
| draw.io | Read its XML directly | Shapes and connectors become a list of nodes and edges the model can read |
| CSV | Built in | Parsed into rows, so masking can work column by column |

For detecting personal data, I recommend three layers, all local:

1. **Rules** for emails, phone numbers, IBANs, card numbers and credential patterns such as API keys and tokens.
2. **A dictionary** built from the identities the tool already sees: email senders and recipients, Jira assignees and reporters.
3. **A multilingual named-entity model** run through `@huggingface/transformers` for names, addresses and organisations in free text. The model is a one-time download of a few hundred MB (estimate).

### ST5. Runtime, packaging and CI

- **Runtime:** require **Node 24 LTS**. Node 22 reaches end of life on 30 April 2027, two months before your ship date.
- **Packaging:** publish to npm, run with `npx`.
- **CI:** GitHub Actions running typecheck, tests and an install check on Windows, macOS and Linux.
- **Tests and validation:** keep Vitest and Zod.
- **Versions:** take the version from `package.json` only, ending today's mismatch.

## 11. Phase 4.3: design decisions

**Decided on 6 Nov 2026: all four recommendations accepted** (DE1 b, DE2 as described, DE3 b, DE4 as described).

The design follows from the architecture and stack decisions. There are two real choices, DE1 and DE3; DE2 and DE4 have one clear answer each.

### DE1. Code organisation

I recommend option b. The web app you plan after v1 then reuses the same core without untangling it from the MCP server.

|  | a. One package, layered folders | b. A few packages in one repo (recommended) |
| --- | --- | --- |
| How it works | One npm package with folders `core/`, `adapters/`, `mcp/`, `cli/`, and lint rules stopping inner layers from importing outer ones | npm workspaces: `core` (masking, index, workflows, checks, artifacts, store), `connectors` (Atlassian, `sf`, git, document extractors), `mcp` (tools, prompts, approval page, host files: the package users install), and `eval` (development only, never published) |
| Pros | Simplest build and release | Boundaries the compiler enforces; the web app can depend on `core` and `connectors` directly; `eval` and its model API keys never ship to users |
| Cons | Boundaries hold only as long as the lint rules do; a web app later means splitting the package anyway | Workspace build setup; four `package.json` files to keep in step |
| Effort | Low | Low to medium |

### DE2. Data model

The clear answer is one SQLite database per workspace, with schema migrations from day one. It has these groups of tables:

- **Contexts and inputs:** contexts, documents (masked text, kind, source, hash), and an encrypted originals vault.
- **Masking:** pseudonyms (token, entity type, encrypted value), scoped to one context. The same person is `[PERSON_3]` everywhere in a context, but cannot be linked across contexts.
- **Metadata index:** snapshots (repo commit or org retrieve time), components (type, API name, attributes), edges (reads, writes, triggers on, references, grants access), and a full-text index.
- **Work:** requirements (extracted, with source document links), artifacts and their versions (structured JSON), and workflow runs (the step state AR3 needs).
- **Publishing:** Jira item to issue key, and Confluence page mappings, as today.
- **Feedback:** story verdicts, design ratings, and snapshots of Jira issues taken when published, to diff later.

Today's JSON contexts get a one-time importer, so your existing work carries over.

### DE3. The tool API the models see

I recommend option b. Weaker models choose tools less reliably as the list grows, and a step-driven flow (AR3) only works if the model cannot skip steps.

|  | a. Many specific tools | b. A small workflow-driven set (recommended) |
| --- | --- | --- |
| How it works | Today's 20 tools plus new ones for scope, steps, metadata queries and feedback: about 35 (estimate) | About 12: add input, show context, start workflow, submit step, metadata search, describe component, impact of a component, record feedback, preview and publish, list and remove. `workflow_start` returns the first step's instructions with only the evidence it needs; `workflow_submit` validates the output against a schema and returns either precise errors or the next step |
| Pros | Strong models can combine tools freely | Fewer choices for the model; the server, not the model, decides the order of steps; each response is short and focused |
| Cons | More tools to choose from, so weaker models pick wrong; the order of steps is up to the model; a large share of a host's tool budget (VS Code caps tools per request, as far as I know) | Less freedom for strong models; the step contracts need careful design and testing |

### DE4. Artifact and content formats

There is one clear answer, in two parts.

- **Designs become structured like backlogs.** Each design is JSON: its sections, decisions, risks and open questions, links to requirement ids, and references to components by index id. The Markdown view is rendered from it, for Confluence and for the other agent to read. The server can then check cited components and requirement coverage (AR3).
- **Domain content moves out of TypeScript into files.** SA principles, the templates, PO practices and industry guidance become Markdown with front matter in a `content/` folder. Domain experts can then contribute without touching code (Phase 3, weakness 10). Each step's instructions are built from these files.

## 12. Phase 4.4: feature decisions

**Decided on 6 Nov 2026: FE1, FE2 c and FE3 c accepted, with one change: sending images to the model is a Must.** How to do that safely is FE4, still open.

Most of v1 follows from the goal and the decisions so far. FE1 lists it with a priority for each item, which you confirm. FE2 and FE3 are new choices.

### FE1. The v1 feature list

Priorities are MoSCoW against 30 June 2027. Must means v1 does not ship without it.

| Feature | Change | Priority | Why |
| --- | --- | --- | --- |
| Masking of personal data and credentials, with encrypted originals | Add | Must | Hard constraint (AR1) |
| Local approval page with the unmasked preview | Add | Must | No self-approval; real names only for the human (AR5) |
| Metadata index, dependency graph, scope step, org summary, query tools | Add | Must | Decision B |
| Org metadata retrieved into the index; MDAPI format read | Add | Must | One deep path for repo and org (ST3) |
| Requirements extracted as a list, traced to inputs, designs and stories | Add | Must | Feeds the checks and design relevance |
| Designs produced in checked steps, as structured JSON | Add | Must | Any-model goal (AR3, DE4) |
| Inputs: PDF, DOCX, PPTX, XLSX, CSV, images (local OCR), draw.io | Add | Must | Your list from round 1 |
| Feedback: story verdicts, design ratings, Jira diff after publishing | Add | Must | Your success criteria (AR4) |
| Evaluation run across models per release (development only) | Add | Must | Know whether a change helps (AR4) |
| npm package, CI on three platforms, schema migrations, importer for today's contexts | Add | Must | Shipping as open source (ST5, DE2) |
| Host files verified on Copilot, then Cursor, then Claude Code | Improve | Must | Your test order; Cursor's file format needs checking when built |
| Backlog quality check and Jira or Confluence publishing | Keep, adapt to masking | Must | Proven live |
| Industry guidance and templates as content files | Improve | Must | Contributions without code (DE4) |
| `sf-agent-po doctor`: checks Node, `sf`, git CLIs, Atlassian token, model download and workspace | Add | Should | Cuts the support load from open-source users |
| Impact analysis workflow: "what does changing this component affect?" | Add | Should | Cheap once the index exists; a frequent SA question (assumption) |
| Contributor guide and templates for new industry content | Add | Should | Open-source contributions |
| Traceability matrix published to Confluence | Add | Could | Built from data the steps already hold |
| Jira sub-tasks from a detailed design | Add | Could | Useful, but not in your success criteria |
| `agent_workflow` tool, free-text `design_save`, JSON context files | Remove | Must | Replaced by the workflow tools, structured designs and SQLite |
| Web app, Atlassian Data Center, Azure DevOps Boards | Not in v1 | Won't | Out of scope by the goal |
| Telemetry of any kind | Not in v1 | Won't | Feedback stays on each user's machine. The trade-off: you will not see other users' acceptance rates unless they share them |
| Sending images to the model as images (for vision-capable models) | Add | Must | Your call on 6 Nov; how to keep masking intact is FE4 |

### FE2. Diagrams in Confluence

I recommend option c: use the diagram app the client's Confluence already has, with the code block as the fallback.

|  | a. Mermaid as a code block (today) | b. Render to images locally and attach them | c. Use a diagram app installed on the site (recommended) |
| --- | --- | --- | --- |
| How it works | The page shows the diagram's source text | Mermaid is drawn to PNG or SVG on the user's machine and attached to the page | The user names the site's diagram app once (a Mermaid app, for example). Diagrams are published into its macro; without one, they fall back to a code block |
| Pros | No work | Works on every Confluence site | A real diagram that people can edit in Confluence |
| Cons | Business readers see code, not a diagram | Needs a headless browser, a large extra download on every install; images cannot be edited | Depends on what each client has installed; each supported app is extra work, so v1 would support one |
| Effort | None | Medium | Low to medium per app |

### FE3. Output language

I recommend option c: a language setting per context, defaulting to English.

|  | a. English only | b. Follow the language of the inputs | c. A setting per context (recommended) |
| --- | --- | --- | --- |
| Pros | Simplest; every deterministic check works | Natural for local teams | Predictable, and the user decides; mixed-language inputs are not a problem |
| Cons | Excludes teams who deliver in French, German, Chinese and so on | Unpredictable when inputs mix languages, which is common | One more setting |

The content files stay in English under every option. One limit applies to b and c: today's checks for vague wording and generic personas are English word lists, so they would need word lists per language or would catch less.

### FE4. Sending images without breaking masking

**Decided on 6 Nov 2026: option c**, redact then the user confirms.

I recommend option c: redact the image on the user's machine, then show the redacted image on the approval page, and send it only after the user confirms. The model still sees layout, diagrams and screenshots, and a human checks what automatic redaction might miss.

|  | a. Redact automatically, then send | b. Send as is, with the user's confirmation | c. Redact, then the user confirms (recommended) |
| --- | --- | --- | --- |
| How it works | Local OCR finds every word and its position. The personal-data detector (ST4) flags names, emails, phones and keys, and those areas are blacked out before the image goes to the model | The approval page shows the original image; the user confirms it holds no personal data, and it goes to the model unchanged | As a, then the approval page shows the redacted image with its black boxes. The user confirms, or marks more areas to black out |
| Pros | Fully automatic; no extra click | Simple; the model sees everything | Automatic redaction plus a human check; the user sees exactly what the model will see |
| Cons | OCR misses handwriting, small or stylised text and faces, and anything missed goes to the model | Puts the whole constraint on the user's judgment, so one careless click leaks data | One confirmation per image (at most about 10 inputs per engagement); the most work of the three |
| Fit with the masking constraint | Partial | Weak | Strong |

All options share two limits:

- **Hosts:** the image reaches the model as image content in a tool result. Whether Copilot, Cursor and Claude Code all pass that to the model needs checking in the first spike (assumption: they do).
- **Models:** a model that cannot read images gets the OCR text, masked, as it would without this feature.

## 13. Phase 4.5: migration decisions

I recommend the strangler approach: build the new packages next to today's server in the same repo, move the proven parts into them with their tests, and retire the old server once the new one can do everything it does. You keep a working tool for live use the whole time, and the target structure exists from day one.

### MI1. Migration approach

|  | a. Refactor in place | b. Strangler in the same repo (recommended) | c. Full rewrite |
| --- | --- | --- | --- |
| How it works | Change today's package step by step: swap the JSON store for SQLite, add masking to each path, regroup tools, then split into packages | Create `core`, `connectors`, `mcp` and `eval` beside today's `src/`. Move the proven parts in first: Atlassian client, Jira and Confluence publishing, backlog schema and check, Markdown-to-Confluence converter, prompt content. Build the new parts in the packages. The old server stays usable until the new one reaches parity, then it is deleted | Start an empty repo and write everything again against the target design |
| Pros | Usable at every step; no duplication | Target structure from the start; live-proven code and its tests carry over; your live use is never interrupted | Cleanest result; no legacy constraints |
| Cons | The current shape (one package, JSON store, flat tools) fights the target, so much of the work is temporary glue; masking retrofitted path by path is easy to get wrong | Two servers in one repo for a few months; the old one must not grow new features | Throws away the parts proven live and their 67 tests; nothing usable until late; the highest risk for a team of one plus Claude |
| Risk | Medium | Low | High |
| Fit with 30 June 2027 | Medium | Strong | Weak |

### MI2. Order of work and releases

There is one clear answer, in two parts.

- **Risky unknowns first.** Before any building, run spikes on the four things that could change the plan:
  1. Personal-data detection quality in JavaScript, including Chinese names.
  2. Image redaction with OCR.
  3. Whether all three hosts pass images from tool results to the model.
  4. Installing the SQLite driver on Windows, macOS and Linux.
- **Release early to yourself, then to testers.** Publish pre-releases to npm under a `next` tag from the first usable milestone. You test on Copilot first, then Cursor, then Claude Code, and your in-house users join when masking works. Version 1.0 is tagged when every Must is done. Existing JSON contexts move over with the importer at the first pre-release you switch to.

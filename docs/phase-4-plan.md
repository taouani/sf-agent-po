# sf-agent-po phase 4 plan: guided workflows

> Copy of the [sf-agent-po phase 4 plan: guided workflows](https://claude.ai/artifact/BgGJWbS23gqMQLSXCXoLZV) Claude Doc, which stays the working version. Written on 7 Nov 2026 and agreed with Tarek on 8 Nov 2026 (decisions D1 to D7 in section 10). The diagram is only in the doc.

## 1. Goal and gate

Phase 4 makes the server, not the prompt, lead the work. Each design and backlog is built in small steps, and each step is checked before the next one starts. This is how a weaker model can still produce a design and backlog that pass. The phase ends at gate G3: a rubric score of at least 7/10 on each of three models, on the English and French luxury scenarios, measured on the v1 server.

In scope, from the [v1 plan](https://claude.ai/artifact/FHCBeeVFd6Y4pCsSkPpWG8):

- requirements extraction
- a step engine and workflow tools
- designs and backlogs as checked steps, with designs stored as structured JSON
- an output language per context, with English and French word lists for the checks
- diagrams as draw.io in Confluence
- two RM1 items: a traceability matrix in Confluence, and Jira sub-tasks from a detailed design

Out of scope:

- feedback (story verdicts, design ratings, the Jira diff)
- `doctor`
- removing the 0.x server

Those stay in phase 5.

The plan has 12 PRs (section 9). The roadmap allowed 6 weeks; at the pace of phases 0 to 3, I expect the build to take two to three weeks (assumption). What limits G3 is the evaluation credit.

## 2. Starting point

Today each agent is one long instruction text that the model follows in a single pass. The server checks only the backlog, and only at the end. I read this in the code on `main` on 7 Nov 2026.

| Area | What the v1 server does today | Gap phase 4 closes |
| --- | --- | --- |
| Workflow | Four MCP prompts plus the `agent_workflow` tool return one text: steps, rules and a 16-section template (`packages/mcp/src/prompts.ts`, `agents/`) | The server enforces no order and checks nothing between steps |
| Requirements | The prompt asks the model to list them with their sources, then the list is gone | No stored requirements to check against or trace |
| Designs | `design_save` stores free Markdown, masked and versioned; `confluence_publish` writes it on approval; Mermaid is shown as a code macro | Designs are unstructured and unchecked; no draw.io |
| Backlogs | `backlog_save` validates epics and stories with Given/When/Then criteria; `backlog_check` checks ids, story size, vague criteria, sources, cycles and uncited compliance inputs; `jira_publish` writes on approval | Word lists are English only; stories are not tied to requirements; no sub-tasks |
| Language | Only the eval adds "write in French" to the prompt | No setting per context |
| Scope and impact | `scope_propose`, `scope_show` and `metadata_impact` exist (phase 3); the prompt tells the model when to call them | Nothing makes sure they were called |
| Evaluation | The eval runs the four prompts against the 0.x server, and a judge scores the rubric | v1 is not measured |

What stays as it is: masking, the approval page, the context tools, the metadata tools, and Jira and Confluence publishing. Phase 4 builds on them.

## 3. Target flow

A run goes through six stages in order. The design and backlog stages are made of steps, and the server checks each step before the next one starts.

*Diagram in the Claude Doc: guided flow · 6 stages, one checked loop per step.*

The first three stages exist today, but only as advice in the prompt. Phase 4 makes them steps that the server tracks. A detailed design follows the same flow, starting from the stories and the high-level design instead of raw inputs.

## 4. Data model

Three things become stored records: requirements, workflow runs with their steps, and structured designs. Everything is stored masked, like inputs today. Trace links live inside the designs and backlogs, as requirement ids, so the matrix is computed and never drifts from them.

**Requirements** (new table, migration 9). One row per requirement in a context.

- Fields:
  - id such as R1
  - kind: functional, non-functional, constraint or compliance
  - statement
  - MoSCoW priority
  - status: proposed, confirmed or dropped
  - source document ids
- Ids stay stable when the list is extracted again, so links from designs and stories survive.

**Workflow runs and steps** (new tables, same migration). A run is one workflow on one context, for example a high-level design. It records:

- its steps in order
- the current step
- each step's status: pending, passed, passed with warnings, or failed
- the number of attempts
- the last answer, masked
- the last findings

A run can be resumed in a new chat, because its state is on disk and not in the conversation.

**Designs** (new JSON schema; the artifact stays a design document). The JSON has one part per section of today's template:

- context: goals, in scope and out of scope
- personas and licences
- current state
- components, each existing (named exactly as in the index) or new
- data model
- automations
- integrations
- security
- non-functional requirements
- impact
- decisions
- risks
- open questions
- diagrams, as nodes and edges

Each component, automation, decision and compliance measure carries the requirement ids it addresses. The detailed design adds:

- field tables
- the tests mapped to each acceptance criterion
- the deployment list

The Markdown that Confluence shows is generated from the JSON.

**Backlogs** (existing schema, extended). Each story gains:

- requirement ids
- optional sub-tasks, each naming the detailed-design component it builds

The 0.x import keeps working. An old Markdown design stays readable as a document, but it is not checked.

## 5. Workflow tools

Four new tools drive every workflow, and a fifth shows the traceability matrix. The four MCP prompts stay, but each one shrinks to "call `workflow_start`", because the steps now come from the server.

| Tool | What it does | Change |
| --- | --- | --- |
| `workflow_start` | Starts or resumes a run, given:<br>- the context<br>- the workflow (high-level design, detailed design, backlog, or story review)<br>- an optional focus and industry<br><br>Returns the first open step's brief | New |
| `workflow_step` | Returns the brief of the current step again:<br>- what to produce<br>- the JSON shape<br>- the evidence ids to read<br>- the rules for this step | New |
| `workflow_submit` | Takes the answer for one step and checks it:<br>- if it passes, saves it and returns the next brief<br>- if it fails, returns precise findings for a retry | New |
| `workflow_status` | Shows a run's steps, their status and open findings, and which artifacts it saved | New |
| `trace_show` | Shows the matrix: each requirement → its sources, design parts, stories and Jira keys | New (RM1) |
| `agent_workflow` | Returned the long instruction text | Removed; `workflow_start` replaces it |
| `design_save` | Saves free Markdown | Kept until the old server goes (phase 5), marked deprecated |
| `backlog_save`, `backlog_check` | Save and check a backlog outside a run | Kept; they share the step checks |
| Context, metadata, scope, impact, publish tools | As today | Kept |

The v1 server has 25 tools today; after phase 4 it has 29. Decision DE3 aimed for about 12. Getting there would mean merging the four `context_add_*` tools into one and the five metadata tools into two. I propose to do that only if the eval shows models picking the wrong tool (decision D6 in section 10).

**How a step works.** The brief gives the model only what that step needs:

- the confirmed requirements in scope
- the earlier steps' saved output, as ids and short summaries
- the evidence document ids
- the tool to call for more, for example `metadata_component` in the current-state step

The answer is JSON checked against the step's schema, then against the step's rules (section 6). Errors block the step; warnings pass and stay visible. After three failed attempts the step is saved with its findings and marked for you to look at, so a run never loops forever.

## 6. Checks and output language

Every step is checked by code, not by another model call, so a check costs nothing and gives the same answer each time. The table lists the checks I plan for each step. Errors block the step; warnings pass but stay visible.

| Step | Errors (block the step) | Warnings |
| --- | --- | --- |
| Requirements | No source, or a source that is not in the context; two requirements with the same statement | An input that no requirement cites; a compliance word (GDPR, PIPL, consent, retention) in an input with no compliance requirement; a statement joining two needs |
| Current state | A component named as existing that is not in the index | Process Builder or Workflow Rules in scope and not flagged as debt |
| Solution and components | A Must requirement that no component or decision addresses | A custom object with no reason a standard one does not fit; a Flow or Apex choice with no reason |
| Data model | A field type that Salesforce does not have; a custom API name without `__c`; an object marked existing that the index does not hold | A relationship with no lookup or master-detail reason |
| Automation | A trigger object that is in neither the index nor the new data model | Two automations on the same object and event with no order given |
| Integrations | A pattern outside the six named in the SA principles | No error handling, or no volume |
| Security | A compliance requirement with no measure | A new object with no org-wide default |
| Impact | A changed existing component that `metadata_impact` was not run on in this run | Weak links that the design does not mention |
| Decisions, risks | A decision with fewer than two options or no reason | An open question with no owner |
| Backlog | Today's errors, plus a Must requirement that no story covers, or a requirement id that does not exist | Today's warnings, now in English and French; a sub-task naming a component that is not in the detailed design |
| Detailed design | An acceptance criterion with no test mapped to it | A component with no deployment entry |

**Output language.** Each context gets a `language` setting: English by default, or French. It is set by `workflow_start` or a context tool, and every brief tells the model which language to write in. Two checks depend on the language:

- the word lists: vague acceptance-criteria words, generic personas, compliance terms and joined needs
- a check that the answer is written in the context's language

The word lists move out of the code into `content/checks/en.md` and `content/checks/fr.md`, so an expert can extend them without changing code. I write both lists, and the French one needs your review.

The integration patterns and the error-handling and volume checks come from the SA principles the agents already use. The thresholds, such as at most 8 acceptance criteria per story, are today's values in `backlog.ts`.

## 7. Publishing

All three outputs go through today's approval page: you see the real values, and nothing is written until you approve.

**Diagrams as draw.io.** A design holds its diagrams as nodes, edges and groups, not as drawing code, so the checks can verify that every node is a component of the design. The server turns them into draw.io XML with a simple layered layout. It attaches the file to the Confluence page and places the draw.io macro.

The host-kit spike tried two ways of attaching the file:

- (A) an attachment without an extension
- (B) an attachment with a `.drawio` extension

It also had a fallback (C): the XML in a code block. I need to know which of these rendered on your site (decision D3). A Mermaid code block stays as the fallback for sites without the draw.io app, chosen by a setting.

**Traceability matrix (RM1).** This is a Confluence page under the design page, rebuilt at each publish. It has one row per requirement:

- its source documents
- the design parts that address it
- the stories that cover it, with their Jira keys once published
- a status: covered, partly covered, or not covered

The page is computed from the requirement ids that the designs and backlogs carry. `trace_show` gives the same table in the chat.

**Jira sub-tasks (RM1).** A detailed design lists the components each story changes. On `jira_publish`, each story gets one sub-task per component change, for example "Create field Appointment\_\_c.Channel\_\_c" or "Build the record-triggered flow on Appointment\_\_c". Each sub-task has a short description from the design. The approval page lists the sub-tasks under their story.

Other rules:

- Their keys are stored like story keys today, so publishing again updates them instead of duplicating them.
- The sub-task issue type is read from the project, because Jira sites name it differently.
- A project without sub-tasks gets a warning, and the stories are still published.

## 8. Evaluation and G3

The eval moves to the v1 server and runs each workflow through `workflow_start`, the same way a user's host would. G3 passes when each of three models scores at least 7/10 on both luxury scenarios, English and French.

**Runner changes** (`packages/eval`):

- The default server becomes the v1 server, with a throwaway workspace per run.
- The prompt becomes the short v1 prompt plus today's no-user notice. The French scenario sets the context's language instead of adding "write in French" to the prompt.
- Steps that wait for you need special handling: input review, scope, requirements and publish approval. The runner opens the approval page on localhost and approves it, like a person would. The server gets no bypass, so nothing in it can approve without the page.
- The judge reads the saved design or backlog, rendered as today, plus `workflow_status`.
- The turn limit goes from 40 to about 80, because a stepped run makes more tool calls. I'll measure the real count on the first run.

**Rubrics.** Today's luxury rubrics stay, and I add three criteria to each:

- every Must requirement is traced to a design part or story
- the existing components named in the design are real
- the output is in the scenario's language

**Two numbers per model, not one.** The rubric score is the gate. The share of steps that pass on the first try shows where weaker models struggle, so I know which brief to improve.

**Models.** I suggest the three models in your goal, through OpenRouter: Opus 5.5, GPT Sol 6.1 and Grok 7.1. The judge stays the same model for every run, so scores stay comparable (decision D4).

**Cost.** I don't know it yet. I'll run one scenario on one model first, report what it cost, then ask before the full run. The 0.x baseline runs once, with the same settings, as the comparison point.

## 9. Delivery

Phase 4 ships as 12 PRs, in the order below.

- PR 3 can be built at any time, and PR 7 alongside PRs 5 and 6.
- Every PR gets a separate review agent, the typecheck and the tests on three systems before I merge, as for #6 to #43.
- Atlassian is tested with fakes. You test live at the two releases.

| # | PR | What it delivers | Depends on |
| --- | --- | --- | --- |
| 1 | Requirements | Migration 9 with the requirement table, the extraction step, the requirements view on the approval page, ids that stay stable when extracted again | — |
| 2 | Step engine | Run and step tables, step definitions, briefs, the checker interface, the three-try rule; `workflow_start`, `workflow_step`, `workflow_submit`, `workflow_status` | 1 |
| 3 | Output language | The `language` setting per context; word lists moved to `content/checks/en.md` and `fr.md`; backlog checks read them | — |
| 4 | High-level design | The JSON schema, the section steps, their checks, the Markdown renderer, publish from JSON | 2, 3 |
| 5 | Detailed design | Field tables, automation detail, tests mapped to criteria, the deployment list; their checks | 4 |
| 6 | Backlog as steps | Epics from requirements, stories per epic, criteria; requirement ids and the coverage check | 2, 3 |
| 7 | draw.io | Diagram nodes and edges to draw.io XML, attachment and macro on the page, Mermaid fallback | 4, your D3 answer |
| 8 | Traceability matrix | `trace_show` and the matrix page under the design page | 4, 6 |
| 9 | Jira sub-tasks | Sub-tasks from the detailed design on `jira_publish`, with stored keys and the issue type read from the project | 5, 6 |
| 10 | Agents on the new tools | Short prompts, new host files from `init`, `agent_workflow` removed, `design_save` marked deprecated | 4, 6 |
| 11 | Eval on v1 | The runner changes from section 8, rubric additions, the first measured run | 10, OpenRouter credit |
| 12 | Fixes from the eval | Brief and check changes that the first-try numbers point to; the G3 run | 11 |

**Releases.**

- 1.0.0-next.6 after PR 10, so you can try the guided workflows on Copilot. This is the first live check of the draw.io page, the matrix and the sub-tasks.
- 1.0.0-next.7 after PR 12, with the G3 result.

Nothing publishes without your trigger, as today.

## 10. Risks and decisions

Seven decisions shape the build. I recommend an option for each; your answers in a comment or in the chat are enough. D3 is the only one that blocks a PR (PR 7), so I can start PR 1 as soon as you give the green light.

| # | Decision | Options | I recommend |
| --- | --- | --- | --- |
| D1 | Do you confirm the requirement list before the design starts? | (a) Yes, on the approval page; (b) No, the model's list is used as is (a) | (a): every later check leans on the list, and a wrong list wastes the whole run |
| D2 | How big is a design step? | (a) One step per section, about 11 steps; (b) Four grouped steps (a) | (a): small steps are what weaker models handle; I'll measure the extra tool calls in the eval |
| D3 | Which draw.io variant rendered on your site in the host-kit check? | A (no extension), B (`.drawio`), or neither Send the command again please | Your answer from the check; if you did not run that part, I send you the one command again. |
| D4 | Which models and judge for G3? | Opus 5.5, GPT Sol 6.1 and Grok 7.1 through OpenRouter; judge fixed | These three, with Opus 5.5 as the fixed judge, and a sample of verdicts checked by a second judge to spot bias ok for me |
| D5 | When does `design_save` (free Markdown) go? | (a) With the old server in phase 5; (b) Now, in PR 10 | (a): current users keep a way to save until the guided workflow is proven ok for me |
| D6 | Cut the tool count toward DE3's 12? | (a) Only if the eval shows wrong tool choices; (b) Now | (a): merging tools now changes host files twice ok for me |
| D7 | How fine are Jira sub-tasks? | (a) One per component change; (b) One per layer: data, automation, UI, tests | (a): each one maps to a design part and can be checked ok for me |

**Risks.**

| Risk | Mitigation |
| --- | --- |
| A weaker model fails the JSON steps again and again | Small schemas, findings that say exactly what to fix, three tries then saved and flagged; the first-try numbers show which brief to fix |
| A stepped run costs more tokens and time than one long prompt | Briefs carry ids and summaries, not whole documents; measured per model in the eval; D2 can move to grouped steps if the cost is too high |
| More trips to the browser on hosts without elicitation | Requirements and scope can be confirmed on one page visit; the approval page stays the fallback |
| The French word lists are thin at first | You review them in PR 3; experts extend them as content, without code |
| G3 cannot be measured without credit | The build does not wait for it; only PRs 11 and 12 do |

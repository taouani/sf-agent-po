# sf-agent-po v1 plan

> Copy of the [sf-agent-po v1 plan](https://claude.ai/artifact/FHCBeeVFd6Y4pCsSkPpWG8) Claude Doc, which stays the working version. Agreed with Tarek on 6 Nov 2026; progress updated on 10 Nov 2026. The two diagrams are only in the doc.

sf-agent-po v1 ships as an open-source npm package by Jun 30, 2027: a rebuild in TypeScript that masks personal data, indexes orgs of 9,000+ components, guides any model through checked steps, and records whether its stories and designs are accepted. Every decision below was agreed on 6 or 7 Nov 2026; the analysis behind them is in the [Phase 1 to 4 review](phase-1-review.md).

**Status on 10 Nov 2026.** Phases 0 to 4 are built and merged (PRs #6 to #60), about five months ahead of the roadmap. 1.0.0-next.6, the first release with the guided workflows, is on npm since 10 Nov 2026. Phase 5 started the same day; its detailed plan, with your answers to D1 to D7, is the [phase 5 plan](phase-5-plan.md). Gate G3 is closed: on 10 Nov 2026 you accepted it on the three models measured (Opus 5.5 in English only, Haiku 5.5 and DeepSeek V4.1 Flash), instead of the three named in decision D4 of the [phase 4 plan](phase-4-plan.md#10-risks-and-decisions). Section 8 has the progress, evaluation results, limitations, backlog and what is needed from you.

## 1. Decision log

You made 21 decisions on 6 Nov 2026. You accepted every recommendation except one: sending images to the model became a Must, which led to FE4. Six more came during the build on 7 Nov 2026 (MA1, ST3a, RT1, KC1, PB1, RM1); ST3a and RT1 replace parts of ST3 and ST4. During the build, Apex and Office files also moved to our own readers instead of apex-parser and officeparser. On 10 Nov 2026 you accepted gate G3 on the three models measured instead of the D4 set (section 8).

| ID | Decision | Chosen | Why |
| --- | --- | --- | --- |
| SC | How much of the org the agents see | Server-computed scope: the model proposes objects, you confirm, the server adds 1 to 2 hops of related components, plus an org summary and query tools | The only option that gives every model the same, right evidence on 9,000+ components |
| AR1 | Where masking sits | Mask each input when it is added; originals and pseudonym map kept encrypted; real values return only in the final write | One choke point; nothing raw on any path to the model |
| AR2 | How the server runs | One process per host, as today, with an embedded database shared safely between processes; indexing in the background or from the terminal | Simple install; fixes today's lost writes |
| AR3 | How designs and backlogs are produced | Server-guided steps, each checked before the next | Small focused steps are what weaker models handle well |
| AR4 | Where quality is recorded | Local feedback (story verdicts, design ratings, Jira diff after publishing) plus an evaluation across models per release | Measures both success criteria without changing your Jira workflow |
| AR5 | How a human approves writes | Local approval page with the unmasked preview, plus elicitation where the host supports it | The model can never approve alone, and never sees real names |
| ST1 | Language | TypeScript on Node | Salesforce's own metadata libraries are JavaScript; about half of today's code carries over |
| ST2 | Database | SQLite with full-text search and a table of dependency edges | Handles several processes on one file |
| ST3 | Metadata access | `source-deploy-retrieve` for files, the user's `sf` CLI for org retrieval, `apex-parser` | Official registry for both formats; sign-in stays with the user's CLI |
| ST4 | Inputs and detection | `officeparser`, `unpdf`, `tesseract.js`, draw.io XML; detection by rules, a dictionary and a local multilingual model | All local; Python helper kept as a fallback for masking only |
| ST5 | Runtime and delivery | Node 24 LTS, npm with `npx`, CI on Windows, macOS and Linux | Node 22 ends 30 Apr 2027 |
| DE1 | Code organisation | npm workspaces: `core`, `connectors`, `mcp`, `eval` | Enforced boundaries; the later web app reuses `core` |
| DE2 | Data model | One SQLite database per workspace, migrations from day one, pseudonyms scoped per context, importer for today's contexts | Safe upgrades for open-source users |
| DE3 | Tool API | About 12 workflow-driven tools | Fewer choices for weaker models; the server owns the order of steps |
| DE4 | Formats | Designs as structured JSON; domain content as Markdown files | Designs become checkable; experts contribute without code |
| FE1 | v1 feature list | The MoSCoW list in the review's section 12 | Sized against 30 June 2027 |
| FE2 | Diagrams in Confluence | draw.io, which your users' sites have, falling back to a code block | Editable diagrams without a headless browser on every install |
| FE3 | Output language | A setting per context, English by default | Predictable for mixed-language inputs |
| FE4 | Images to the model | Redacted on the user's machine, then confirmed by the user on the approval page | Images reach the model without breaking masking |
| MI1 | Migration approach | Strangler in the same repo | Proven code carries over; your live use never stops |
| MI2 | Order and releases | Spikes first, then npm pre-releases under a `next` tag, 1.0 when every Must is done | Unknowns surface before they cost weeks |
| MA1 | What masking hides (7 Nov 2026) | Personal data and secrets only; city and company names stay visible, except inside a street address | A city alone isn't personal data, and hiding places and companies cost the model context (20% to 32% of image text in the spike) |
| ST3a | Reading metadata files (7 Nov 2026) | Our own reader on fast-xml-parser plus a vendored copy of Salesforce's metadata type registry (Apache-2.0); Apex is read by our own scanner; the user's sf CLI stays | source-deploy-retrieve would add about 80 MB and 240 packages |
| RT1 | Model runtime (7 Nov 2026) | The WebAssembly build of ONNX Runtime and a pure-JS tokenizer, bundled in the package (about 16 MB, no native code) | The native runtime added about 550 MB to every install; the cost is about 3 times slower masking and about 900 MB peak memory |
| KC1 | Where the vault key lives (7 Nov 2026) | OS tools (macOS security, Windows DPAPI, Linux secret-tool), a 0600 key file with a warning as fallback | No native keyring module to install |
| PB1 | How pre-releases ship (7 Nov 2026) | One sf-agent-po package on npm under the next tag, published only by a workflow you start; trusted publishing replaces the npm token before January 2027 | Nothing publishes without you; users run npx sf-agent-po@next |
| RM1 | Using the time gained (7 Nov 2026) | 1.0 stays on 30 June 2027; four items join v1: a traceability matrix in Confluence; Jira sub-tasks from a detailed design; incremental re-index; reports, dashboards and integrations in the index | Phases 0 to 3 finished about four months early; extra scope uses the time without moving the date |

## 2. Target architecture

Everything that enters the tool passes through masking before it is stored. Real values come back only on the way out to Jira or Confluence, after you approve in the browser.

*Diagram in the Claude Doc: target architecture · three packages, one masking boundary, one human gate.*

**How a run flows.** The connectors read inputs, metadata and Jira or Confluence content, and the masking layer replaces personal data with pseudonyms before anything is stored. The model drives a workflow through about 12 tools: the workflow engine hands it one step at a time with only the evidence that step needs, checks each answer, and saves structured artifacts. Query tools let the model look further into the metadata index when a step needs more. To publish, the server opens the approval page on localhost. You see the unmasked preview there, and only after you approve does the Atlassian client write, with real values restored.

**Packages.** `mcp` is what users install: the tools, prompts, approval page and host files. `core` holds masking, the index, the workflow engine, artifacts, feedback and the SQLite store. `connectors` holds everything that talks to the outside. A fourth package, `eval`, runs the evaluation across models and is never published.

## 3. Recommended tech stack

The stack stays TypeScript on Node. Every new component runs locally, so there is no hosting cost. Versions were checked on npm on 6 Nov 2026; the drivers marked "spike" are confirmed in the first two weeks.

| Layer | Choice | Status |
| --- | --- | --- |
| Language and runtime | TypeScript (strict), Node 24 LTS | Keep TypeScript; raise Node from 20 |
| Protocol | MCP over stdio, `@modelcontextprotocol/sdk` | Keep |
| Validation | Zod schemas for every step's output | Keep, extended to designs |
| Database | SQLite with FTS5 on `node:sqlite` | New; node:sqlite chosen by the spike on 7 Nov |
| Metadata | Our own reader on `fast-xml-parser` with a vendored copy of Salesforce's metadata type registry (ST3a), our own Apex scanner, the user's `sf` CLI for retrieval | New, plus the existing XML parser |
| Documents | Our own Office reader on `fflate` and `fast-xml-parser`, `unpdf` 2.1 (PDF), `tesseract.js` 7 (OCR), draw.io XML, `postal-mime` (email) | New, plus the existing email parser |
| Personal-data detection | Rules, a dictionary of known identities, and a multilingual model on the WebAssembly build of ONNX Runtime, bundled in the package (RT1) | New; confirmed by the spike on 7 Nov (97% of entities fully masked), no Python fallback needed |
| Secrets | Vault key through the OS tools (macOS security, Windows DPAPI, Linux secret-tool), a 0600 key file as fallback (KC1) | New |
| Approval page | A small page served on localhost by the server, no front-end framework | New |
| Atlassian | Jira REST v3, Confluence REST v2, the user's API token | Keep |
| Git hosts | The user's `gh`, `glab` and `git` CLIs | Keep |
| Markdown to Confluence | `marked`, plus the draw.io macro | Keep, extended |
| Tests and evaluation | Vitest; `eval` package calling model APIs with your own keys, or one OpenRouter key | Keep Vitest; evaluation is new |
| Delivery | npm workspaces, one `sf-agent-po` package run with `npx` (`next` tag published by a workflow you start, PB1), GitHub Actions on Windows, macOS and Linux | New |

## 4. Roadmap

At 40 hours a week with no holiday break, the plan fits 30 June 2027 with about five weeks of buffer. Each phase depends on the one before it, because one person builds them in sequence.

*Diagram in the Claude Doc: v1 roadmap · 7 phases, 4 gates, 1.0 on 30 June 2027.*

| Phase | Weeks | Delivers | Depends on | Gate at the end | Status on 10 Nov 2026 |
| --- | --- | --- | --- | --- | --- |
| 0 Spikes | 2 | Answers on detection quality (incl. Chinese), image redaction, images in tool results on all three hosts, SQLite driver install, elicitation in VS Code, a draw.io diagram the Confluence macro renders, the detection model's licence | Nothing | G0: each spike passes, or its fallback is chosen (Python helper for masking) | Done (PRs #6, #12). G0 passed; WebAssembly runtime chosen (RT1) |
| 1 Foundations | 4 | Workspaces and packages, CI on three platforms, Node 24, SQLite store with migrations, importer, proven code moved over, content as files, a luxury industry template, luxury evaluation scenarios in English and French, evaluation baseline measured on today's version | Phase 0 | None; your live use continues on the old server | Done (PRs #7 to #11, #39). The 0.x baseline was never run: the eval now measures v1 directly (backlog) |
| 2 Masking, inputs, approval | 5 | Masking with vault and keychain, new document readers, image redaction, approval page with unmasked preview and image confirmation, masked-input review (a setting, on by default in pre-releases), unmasking on publish | Phase 1 store | G1: first `next` pre-release; you test on Copilot; in-house users can join | Done (PRs #13 to #29). G1 met: 1.0.0-next.0 to next.5 on npm, host kit passed on Copilot and Cursor |
| 3 Metadata index, scope | 6 | Both metadata formats, flows, Apex references, validation rules and permissions, dependency graph, search, org retrieval, scope step, org summary, query tools, impact analysis | Phases 1 and 2 (metadata text is masked too) | G2: your 9,000+ component org indexed in under 30 minutes | Done (PRs #30 to #38, #40, #41, #58). G2 met: your UAT org, 15,266 components in about 20 minutes. #58 adds Visualforce, email templates, field sets and untyped Apex field uses |
| 4 Guided workflows | 6 | Requirements extraction, step engine, workflow tools, designs and backlogs as checked steps, structured designs, output language with English and French word lists for the checks, diagrams as draw.io in Confluence; added by RM1: a traceability matrix in Confluence, Jira sub-tasks from a detailed design | Phases 2 and 3 | G3: a rubric score of at least 7/10 on each of three models | Built (PRs #44 to #56), finished 8 Nov 2026. G3 accepted on 10 Nov 2026 on the three models measured, which score 8.1 to 10 on the luxury scenarios (Opus in English only; section 8) |
| 5 Feedback, hosts, hardening | 5 | Story verdicts, design ratings, Jira diff, host files verified on Copilot, Cursor and Claude Code, `doctor`, Windows fixes, docs and contributor guide, old server removed; added by RM1: incremental re-index, reports, dashboards and integrations in the index | Phase 4 | None | Started 10 Nov 2026 (phase 5 plan, 16 PRs). Partly done: trusted publishing (#64), key backup commands (#65), `doctor` and `server_status` (#66), parse cache (#67), incremental org re-index (#68), `index --repo` (#69), reports, dashboards and report types (#70), integrations (#71), reports and integrations in the impact, summary and search tools (#72), feedback store and Jira diff (#73), review page for story verdicts and design ratings (#74), `feedback_summary` and the `report` command (#75), kept model answers for repeated short texts (#76), Cursor skills in place of commands (#77), Windows fixes (#35, #36), Copilot and Cursor verified, clear model download errors (#57) |
| 6 Release candidate, buffer | 5.5 | Bug fixes, final evaluation, release notes | Everything | 1.0 on npm, 30 June 2027 | Not started |

Weeks are rough estimates for one person with Claude. If phase 3 or 4 overruns, Shoulds and Coulds are cut first, then the buffer.

## 5. Key risks and how to mitigate them

The two risks that could break the plan are masking quality and the schedule. Both are tested or bounded in the first weeks rather than discovered late.

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | Local personal-data detection misses too much, especially Chinese names (PIPL) or names inside free text | Medium | Critical: breaks the hard constraint | Spike in weeks 1 to 2 with labelled samples in several languages. The dictionary layer catches known people. A Python helper is the fallback for masking only. Masked-input review on the approval page, on by default during pre-releases |
| 2 | The schedule slips: 33 weeks at 40 hours a week for one person plus Claude | Medium | High | Strict MoSCoW: Shoulds and Coulds go first. About five weeks of buffer before 1.0. The strangler keeps a working tool throughout, so a slip delays 1.0 without breaking your live use |
| 3 | Weaker models still fail inside the guided steps | Medium | High: misses the any-model goal | Small step contracts with schema validation and precise errors. An evaluation on three models every release, against your thresholds: at least 7/10 per model, and 90% of stories accepted without major edits |
| 4 | The scope misses a dependency the graph cannot see (dynamic Apex, SOQL built from strings, long formula chains) | Medium | Medium: a less relevant design | The user confirms the scope. Query tools let the model fetch what is missing. An impact-analysis tool flags weak links. Fixtures with known traps go into the evaluation |
| 5 | Hosts behave differently or change: image content in tool results, elicitation, tool caps, Cursor's move to skills | High | Medium | Checked in the spike. Host files are generated from one source. Each pre-release is verified on Copilot, then Cursor, then Claude Code |
| 6 | Native dependencies (SQLite driver, the model runtime) fail to install on locked-down corporate laptops, or the model download is blocked by a proxy | Medium | Medium: users cannot start | Spike on three platforms. Prefer `node:sqlite` if it is solid. Allow a local model path for offline installs. `sf-agent-po doctor` names the problem |
| 7 | Indexing a 9,000+ component org is too slow | Low to medium | Medium | Measured on your real 9,000+ component org in phase 3, against the 30-minute target. Incremental re-indexing by changed files. A terminal command for the first full index |
| 8 | The vault key is lost, so published output cannot be unmasked | Low | Medium | Key in the OS keychain, `key export` and `key import` commands (#65), and a clear error that names the cause. Artifacts stay usable with pseudonyms |
| 9 | Open-source support load grows faster than one person can handle | Medium | Medium | `doctor`, issue templates, a troubleshooting guide, and contributions to content without touching code |

## 6. Open questions still to resolve

You answered all eight on 6 Nov 2026, and the roadmap, risks and gates above now use your answers. Two small points remain: the detection model's licence was checked in the spikes (AFL-3.0, section 7), and I assume Claude drafts the luxury scenarios for you to review.

- **1. Your time.** How many hours a week can you give this? The roadmap assumes close to full time with Claude doing most of the coding (assumption). Answer: 40h/week.
- **2. Pass thresholds.** What numbers count as success? For example, the share of stories accepted without major edits, and a minimum rubric score per model. The goal names the measures but not the targets. Answer: 90% of stories accepted without major edits. 7/10 as minimum rubric score.
- **3. Diagram app.** Which Confluence diagram app do your in-house users' sites have? v1 supports one (FE2). Answer: draw.io.
- **4. A large test org.** Can a real org or repo with 9,000+ components be used for index testing, and what indexing time is acceptable? Answer: yes, less than 30 minutes.
- **5. More evaluation scenarios.** Two samples exist (insurance, banking). Who writes three or four more, in which industries and languages? Answer: luxury, in English and French.
- **6. Holiday break.** The roadmap assumes no work from 21 Dec 2026 to 1 Jan 2027. Answer: I will be working.
- **7. Licences.** Confirm MIT stays, and check that the multilingual detection model's licence allows redistribution and commercial use. Answer: MIT stays, yes.
- **8. Masked-input review.** Should users see the masked version of each input before the agents use it? It would add a click per input, but catch detection misses on text as well as images. Answer: in the testing phase only (configurable if possible).

## 7. Phase 0 spike results

The spikes ran on 7 Nov 2026 on Windows, macOS and Linux with Node 24 ([PR #6](https://github.com/taouani/sf-agent-po/pull/6)). Every technical question is answered and gate G0 passes, except the host checks, which need you at a real Copilot, Cursor and Claude Code. Update: Copilot and Cursor passed; Claude Code is still open.

| Question | Result | What it means for the plan |
| --- | --- | --- |
| Personal-data detection in English, French and Chinese | Rules, dictionary and the DistilBERT multilingual model (138 MB) together fully mask 97% of 59 entities and at least half of every one. They find all 27 names, with no false positives, 1% of masked characters outside an entity, and 6 ms per sentence. Rules alone reach 58% and find 6 of 27 names | The three planned layers work, so the Python fallback is not needed. Street addresses are the weak spot (2 of 4 fully masked), so phase 2 adds address rules |
| Detection model licence | The base models are under AFL-3.0, which is permissive and allows redistribution and commercial use | Compatible with MIT. Assumption: the model is downloaded on first run, not bundled |
| Image redaction | `tesseract.js` with language data from npm (5.4 MB for English, French and Chinese) blacked out all 17 sensitive strings on all three OSes, at 0.1 to 0.4 s per image. The larger language data misreads Chinese | FE4 works as designed. With the model added, 20% to 32% of the other text was also blacked out, because it masks city and company names |
| SQLite driver | `node:sqlite` and `better-sqlite3` both pass on all three OSes. Both have FTS5 with accent folding and JSON. Four processes wrote at once with no errors. 10,000 components index in 0.3 s and a 2-hop scope query takes 1.5 ms | Use `node:sqlite`: it needs no native install (risk 6) and shows no warning on Node 24. Two-character Chinese words need a fallback search, which answers in 1 to 2 ms |
| Images, elicitation and the approval page in each host; draw.io in Confluence | The check kit is ready in `spikes/host-kit` | Passed on Copilot and Cursor; Claude Code still open |

**Install size: resolved (spike 6, 2026-11-07).** The native model runtime added about 550 MB to every install (300 MB on Windows and macOS, 760 MB on Linux with its CUDA download). On Linux, Windows and macOS, the WebAssembly build of ONNX Runtime with the pure-JS tokenizer gave detections identical to native for all 48 test sentences. Shipping its three runtime files in our package adds 16 MB and no native code. The cost is about 3 times the time (28 ms per sentence, about 0.5 s per page-sized chunk) and about twice the peak memory (about 900 MB). Tarek chose the bundled WebAssembly runtime for v1, so masking does not depend on @huggingface/transformers or onnxruntime-node.

**Review.** A separate review agent checked the spike code. All 11 of its findings were real and were fixed before merge. The two that mattered most: over-masking was not being counted, and the Chinese search check hid the two-character gap.

## 8. Progress on 10 November 2026

Phases 0 to 4 are built and merged (PRs #6 to #60). Phase 4 finished on 8 Nov 2026, against a roadmap that put G3 on 16 April 2027. Every PR had a separate review agent, and 618 tests pass on Windows, macOS and Linux, plus a job that runs the real name model. What limits the next steps is your live testing, not the build; the evaluation credit only limits the run on the D4 models.

**Decision RM1 (7 Nov 2026).** 1.0 stays on 30 June 2027, and the time gained goes to items that were Could or after 1.0. You confirmed four items the same day. The traceability matrix in Confluence and Jira sub-tasks from a detailed design went to phase 4 and are built. Incremental re-index, and reports, dashboards and integrations in the index, go to phase 5.

### Achieved

| Phase | PRs | What shipped |
| --- | --- | --- |
| Fixes from your testing (8 and 9 Nov) | #57 to #60 | The model download error gives its real cause and fix (proxy, company certificate, or placing the file by hand); the index reads Visualforce pages and components, email template merge fields (never their text), field sets and untyped Apex field uses, and links `Account.X__pc` to `Contact.X__c`; field types such as Currency are never masked as names; model runs wait their turn, which fixes the `failed to call OrtRun()` error on parallel tool calls |
| 4 Guided workflows | #44 to #56 | Requirements with stable ids, confirmed on the approval page; a step engine with `workflow_start`, `workflow_step`, `workflow_submit` and `workflow_status`; output language per context with English and French word lists; high-level and detailed designs as checked section steps; backlogs as checked steps with Must coverage; `trace_show` and the traceability matrix page; Jira sub-tasks from the detailed design; draw.io diagrams attached to the Confluence page, with a Mermaid fallback setting; agents and `init` host files on the workflow tools (`agent_workflow` removed, `design_save` deprecated); the eval on v1 with prompt caching and send-back reasons |
| 3 Metadata index, scope | #30 to #38, #40, #41 | Index of both metadata formats, flows, Apex, permissions, layouts and every other type from Salesforce's registry; org retrieval with your sf CLI; the `index` command; summary, search and component tools; the scope step on the approval page; impact analysis with weak links |
| 2 Masking, inputs, approval | #13 to #29 | Detection with rules, dictionary and the model on WebAssembly; pseudonym vault with the key in the OS keychain; PDF, Word, PowerPoint, Excel, CSV and draw.io readers; image redaction with local OCR; approval page; publishing to Confluence and Jira on approval; `init` for three hosts; the `next` package and its release workflow |
| 1 Foundations | #7 to #11, #39 | npm workspaces, SQLite store with migrations, importer for 0.x contexts, content as Markdown, luxury template and scenarios, eval runner with judge, eval through OpenRouter |
| 0 Spikes | #6, #12 | All spikes passed; WebAssembly model runtime chosen (RT1) |

### Evaluation results (8 Nov 2026)

The target is at least 7/10 per model. Every score below is one run per scenario, so a difference of about a point may be noise (my estimate). First try is the share of steps accepted without a send-back.

| Model | Judge | Luxury EN design / backlog | Luxury FR design / backlog | Other scenarios | First try |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | Opus 5.5 | 10 / 9.1 | Not run | Not run | 75% |
| Haiku 5.5 | Sonnet 5.5 | 9.4 / 9.1 | 8.8 / 8.2 | Banking 9 / 10, insurance 8 / 7.5 | 91% |
| DeepSeek V4.1 Flash | Sonnet 5.5 | 10 / 10 | 8.1 / 9.1 | Banking 5 / 8 (data model missing), insurance 8.7 / 7.5 | 66% |

- **Cost.** Prompt caching cut one Opus scenario from about $10 to about $4.60. The two cheap models cost about $1 to $2 for four scenarios each, judge included (estimate from token counts).
- **G3.** Three models pass on the luxury scenarios, but they are not the three D4 named (Opus 5.5, GPT Sol 6.1, Grok 7.1), and Opus ran in English only. D4 also fixed Opus 5.5 as the judge, but the two cheap runs used Sonnet 5.5 to save credit, so their scores are not strictly comparable with the Opus run. On 10 Nov 2026 you accepted G3 as measured; running the D4 set on both luxury scenarios, about $30, moved to the backlog.
- **Send-backs.** Every step sent back in the Opus runs went over a length limit; the briefs now show the limits (#56). The weaker model's send-backs cluster on the data model, integrations and security steps.

### Remaining

1. **Close phase 4.** G3 is accepted; what is left is the first live check of next.6 (a guided design and backlog on Copilot, the draw.io macro, the matrix page and the sub-tasks) and your review of the French word list.
2. **Phase 5, feedback, hosts, hardening (next).** Story verdicts, design ratings and the Jira diff after publish; the Claude Code host check; `doctor`; faster masking (batched calls); the v1 user guide (today's `docs/user-guide.md` describes 0.x) and a contributor guide; trusted publishing on npm; indexing remote repos in v1; removal of the 0.x server. Added by RM1: incremental re-index of changed files, and reports, dashboards and integrations in the index.
3. **Phase 6, release candidate.** Bug fixes, the final evaluation across models, release notes, 1.0 on npm.

### Limitations today

- **The index cannot see inside dynamic code.** Queries built from strings, classes named at run time and describe calls are flagged as weak links, not followed. Formula chains, report usage and outside integrations are not traced yet (phase 5).
- **Untyped Apex field uses are linked by name.** A use such as `getAccount().Foo__c` is linked only when one object has a field of that name, or, in an email template, the recipient types (Contact, Lead, User) list it.
- **Old indexes miss the #58 links.** An index built before next.6 has no Visualforce, email template, field set or untyped Apex links: re-index after updating.
- **Masking is slow on large inputs.** One detector call per string (a repeated short string's answer is kept, #76), on a WebAssembly runtime about three times slower than native, with about 900 MB peak memory. Since #60, tool calls that mask at the same time wait for each other.
- **The model download needs huggingface.co.** Behind a proxy or a company certificate it needs a setting, or the file placed by hand; the error now says which (#57).
- **Metadata text is masked on the way out, not when it is stored.** The index keeps it unmasked in the local, git-ignored workspace.
- **G3 was accepted on models other than the D4 set.** See above; the 0.x baseline was never run.
- **Some paths are tested with fakes only.** v1 publishing to Confluence and Jira, including draw.io, the matrix page and sub-tasks, has not been tried live.
- **Host memory is outside our control.** On 9 Nov, Copilot's memory brought facts from another repository into an answer in a clean workspace. Our masking and workspace do not cover what a host remembers.
- **Hosts.** Claude Code is not tested; Cursor reports its version as "cursor-vscode 1.0.0".
- **29 tools, against about 12 in DE3.** Decision D6 of the [phase 4 plan](phase-4-plan.md#10-risks-and-decisions) keeps them until the eval shows models picking the wrong tool.
- **Two loaders, local checkouts only, npm token.** The 0.x `context_add_file` still uses the old loader; v1 indexes an org or a local folder, not a remote repo; publishing uses an npm token, which npm stops accepting around January 2027.

### Backlog

| Item | Why it waits | Goes to |
| --- | --- | --- |
| G3 on the D4 models (GPT Sol 6.1, Grok 7.1, Opus in French) | About $30 of credit, which you are not adding now | When credit allows; it no longer blocks phase 4 |
| Eval baseline on 0.x | The eval measures v1 directly now | I suggest dropping it; your call |
| Copilot memory: a README note, an `init` host instruction, a check for untraced claims | You asked to discuss it only, on 9 Nov | Open, your call |
| Claude Code host check | You test it when ready | Phase 5 |
| Trusted publishing (no npm token) | Needs a setting on npmjs.com | Before January 2027 |
| Index GitHub, GitLab and Azure DevOps repos directly | v1 indexes an org or a local checkout | Phase 5, before the old server is removed |
| Batch masking calls | Speed only; correct today | Phase 5 |
| Fewer tools (D6) | Only if the eval shows wrong tool picks | Phase 5 |
| Move 0.x `context_add_file` to the new loader | Goes away with the old server | Phase 5 |
| Cursor version string | Cosmetic | Phase 5 |
| Metadata text on the input review page | Needs your call on whether to review it | Open question |
| Native model runtime as an option | RT1 chose WebAssembly for install size | After 1.0 |
| Web app, Atlassian Data Center, Azure DevOps Boards, telemetry | Won't for v1 in the feature list (FE1) | After 1.0, if ever |

### Inputs needed from you

- [ ] Start the Release next workflow for 1.0.0-next.6; PR #62 (merged) bumped the version. Your run on 8 Nov stopped because it was still next.5.
- [ ] Update, re-index your UAT org with `npx sf-agent-po@next index --org <alias>`, and run the Lifetime Spent check again.
- [ ] Try one guided design and backlog on Copilot with next.6, published to a test Confluence space and a test Jira project: the first live check of draw.io, the matrix page and the sub-tasks.
- [x] Decide on G3: done on 10 Nov 2026, accepted on the three models measured.
- [ ] Review the French word list in `packages/core/content/checks/fr.md`.
- [ ] Send the name of the Apex class that was missed in the Lifetime Spent check, or the line that reads the field, so I can confirm #58 covers it.
- [ ] Tell me the OpenRouter credit left after the 8 Nov runs.
- [ ] Set up trusted publishing for sf-agent-po on npmjs.com (steps in section 6 of the [phase 5 plan](phase-5-plan.md)), then start the Release next workflow for 1.0.0-next.7, bumped in #72. The workflow already uses trusted publishing (#64); the first publish must happen within 2 days of the setup.
- [ ] With next.7, re-index your UAT org in full (`npx sf-agent-po@next index --org <alias> --full`) and send the time it took: G2 again, now with reports and integrations, against 30 minutes. Then run it again without `--full` after a few changes, against 5 minutes.
- [ ] Test the Claude Code host when you are ready.
- [ ] Optional: two or three anonymised real requirement sets, in English and French, to use as scenarios.

# sf-agent-po phase 5 plan: feedback, hosts, hardening

> Copy of the [sf-agent-po phase 5 plan: feedback, hosts, hardening](https://claude.ai/artifact/UGobnF2AwGG2fMAxuM7mQs) Claude Doc, which stays the working version. Written and agreed with Tarek on 10 Nov 2026 (his answers to decisions D1 to D7 are in section 9).

This is the detailed plan for phase 5 of the v1 roadmap. You answered D1 to D7 on 10 Nov 2026 (section 9): the recommendation on all of them, and D6 kept open with LiteLLM as an option. The build started the same day. Section 8 lists what I need from you.

## 1. Goal and gate

Phase 5 turns the guided workflows into a product that other SAs and POs can install, trust and measure. It covers three things. First, it records whether stories and designs are accepted, which is the success measure the goal names (90% of stories accepted without major edits). Second, it makes installing and running the server reliable on every host. Third, it finishes the index with the two RM1 items. It ends with the 0.x server removed, so `npx sf-agent-po@next` is the only server.

In scope, from the [v1 plan](plan.md) (roadmap row 5, section 8 and its backlog):

- **Feedback (AR4).** Story verdicts, design ratings, and the Jira diff after publish.
- **Hosts.** Host files checked on Copilot, Cursor and Claude Code.
- **Hardening.** `doctor`, a key backup command and faster masking.
- **Index.** Incremental re-index, plus reports, dashboards and integrations (both RM1), and remote repos indexed directly.
- **Release.** Trusted publishing on npm, before npm stops accepting the token around January 2027.
- **Clean-up.** Removing the 0.x server, the v1 user guide, a contributor guide and a troubleshooting guide.

Out of scope:

- Copilot memory, which you parked on 9 Nov.
- A smaller tool set (D6 of the phase 4 plan), which waits for eval evidence that this phase cannot pay for.
- The native model runtime, which stays after 1.0.
- The final evaluation across models, which belongs to phase 6.

**Gate G4 (proposed, there was none).**

1. `doctor` passes on Windows, macOS and Linux in CI and on your laptop.
2. A re-index of your UAT org after a few changes takes under 5 minutes, and a full index with reports stays under 30 minutes (G2).
3. Feedback is recorded for one real backlog: verdicts, plus the Jira diff after your team has worked on it.
4. Host files are verified on Copilot, Cursor and Claude Code.
5. The repo holds no 0.x code.

**Size.** The roadmap gave phase 5 five weeks. The plan has 15 PRs (section 7). At the pace of phases 0 to 4, I expect the build to take three to four weeks (assumption). Your live checks set the end date, not the build.

## 2. Starting point

I read this in the code on `main` on 10 Nov 2026 (after PR #63).

| Area | Today | What it means for phase 5 |
| --- | --- | --- |
| Feedback | No table for verdicts or ratings (the store has 10 migrations). A published backlog keeps each Jira key, a hash of what was sent and the time it was last updated | The Jira diff can find edited stories without a new publish path |
| Commands | `init` and `index` only | `doctor`, `key` and `report` are new commands |
| Vault key | `exportVaultKey` and `importVaultKey` exist in core, but nothing calls them | A `key export` / `key import` command closes risk 8 |
| Index runs | Every run builds a new snapshot from scratch. An org run retrieves everything, about 20 minutes on your UAT org, and keeps the last retrieval in the workspace | Incremental runs reuse that retrieval and the parse results of unchanged files |
| Reports, dashboards | Not retrieved: the org type list leaves out reports on purpose, since their content is people's text | They need their own reader, and filter values must never be kept |
| Integrations | External service registrations are retrieved, but indexed by name only. Named credentials, remote sites, connected apps, outbound messages and Apex callouts are not read | A new reader and new link types |
| Remote repos | v1 indexes an org or a local folder. Cloning with your `gh`, `glab` or `git` already exists in connectors (`resolveMetadataSource`), but only 0.x uses it | `index --repo` reuses it |
| Masking | One model call per string, on the WebAssembly runtime, one call at a time since #60 | Batching short strings into one call is the main speed gain |
| 0.x server | `src/` (about 3,300 lines) and `test/`, published as the root `sf-agent-po` bin. `scripts/pack-next.mjs` takes `repository`, `homepage` and `bugs` from the root `package.json` | Removing 0.x keeps a private root `package.json` with those fields |
| npm | `next` is 1.0.0-next.6 (you released it). `latest` is still 1.0.0-next.0, the first publish, so `npx sf-agent-po` without `@next` runs a two-week-old version | See D5 |
| Input review | `context_review_inputs` exists; it is on by default in pre-releases, as you asked (open question 8) | Nothing to build; 1.0 turns the default off |

## 3. Feedback

The goal's success measure is the share of stories that the PO, SA and dev team accept without major edits. Jira cannot measure it, so the tool records it. Three sources feed one table.

1. **The Jira diff (automatic).** `feedback_jira_diff` reads each published story back from Jira: summary, description, acceptance criteria, story points and status. It compares each one with what was published and classifies it as unchanged, minor edit, major edit or deleted. It masks Jira's text before it stores or returns anything; the real text is shown only on the review page. The rule for a major edit is D2.
2. **Story verdicts (people).** `feedback_review` opens a review page on localhost, like the approval page. It lists the published stories of a backlog with the Jira diff's guess, and you set accepted, minor edit, major edit or rejected, and who decided (PO, SA or dev team). How verdicts are captured is D1.
3. **Design ratings (people).** The same page rates each design section from 1 to 5, with an optional comment, which is masked when it is saved.

**Data model (migration 11).** A `feedback` table holds context, artifact, item (story key or design section), kind (`jira_diff`, `verdict` or `rating`), value, role, a masked comment, the model label and the time. MCP does not tell a server which model a host uses, so the model label is a context setting (`model`). The review page asks for it once if it is empty.

**Report.** `feedback_summary` (tool) and `npx sf-agent-po@next report` (command) give the share of stories accepted without major edits, per context, model label and workflow, against the 90% target, plus the average design rating per section. `report --csv` writes the same numbers to a local file. Nothing leaves your machine.

## 4. Hosts and hardening

**`doctor`.** `npx sf-agent-po@next doctor` checks, in order:

- Node 24
- the workspace folder and its database (FTS5)
- the vault key and the OS tool that stores it (`security`, DPAPI, `secret-tool`)
- the name model file: present, and it loads and masks a test sentence. If the file is missing, doctor checks that huggingface.co is reachable through your proxy and certificate
- your `sf` CLI and the orgs it is logged in to
- the three Atlassian settings, and one call each to Jira and Confluence
- the `gh`, `glab` and `git` CLIs, for remote repos
- the host files in the current project
- the age of each index snapshot

Each line says pass, warn or fail, with the fix. The output never shows a token or a value from the vault, and paths show `~` instead of your user name, so it is safe to paste into a GitHub issue. A `server_status` tool returns the same checks to the model, apart from the Atlassian calls.

**Key backup.** `key export` prints the vault key, with a warning to keep it in a password manager. `key import` reads it back and refuses a key that does not open this workspace's vault. Both use the functions core already has.

**Hosts.**

- **Claude Code.** You run the host kit there; I fix what it finds.
- **Cursor.** Cursor is moving custom commands to skills, so `init` writes Cursor skills, keeping commands for older versions. I check Cursor's current file format first (assumption: `.cursor/skills/<name>/SKILL.md`).
- **Copilot.** Copilot's files are checked again on next.7.
- **Cursor's version string.** It stays as Cursor reports it; `doctor` shows it as reported.

**Faster masking.** Short strings, such as metadata text, table cells and Jira fields, are batched into one model call of up to 32 strings padded to the same length. Long texts keep their chunks. The target is twice as fast on a 50-page PDF and on a large `metadata_impact` answer, measured with the real model in the CI model job. Detections must stay identical: the spike's 48 sentences and the masking tests are the check.

## 5. Index

**Incremental re-index (RM1).**

- **Parse cache (migration 12).** A `metadata_file` table keeps each file's hash and the components read from it. A run reads only the files whose hash changed and copies the rest. Links are recomputed over the whole set, which takes seconds.
- **Orgs.** The run first lists each type with `sf org list metadata` and compares each member's last-modified date with the previous run. It then retrieves only the changed members into a copy of the last retrieval, and removes the deleted ones. Profiles and permission sets are always retrieved in full, because Salesforce does not change their date when only access changes (known quirk).
- **`--full`.** Forces a complete run. A run older than 7 days, or after an upgrade that changes a reader, is full by default.
- **Target.** Under 5 minutes on your UAT org with a few dozen changes.

**Reports, dashboards and report types (RM1).**

- **Readers.** Reports give their report type, columns, groupings and filter fields. Custom report types give their base object, joins and fields. Dashboards give their components and source reports. All become links, so `metadata_impact` on a field shows the reports and dashboards that use it.
- **What is kept.** Filter values are never kept, since they can name people; only the field a filter is on. Report and dashboard names and descriptions are masked on the way out, like all metadata text.
- **Org retrieval.** Reports sit in folders, so the run lists report and dashboard folders first, then their members. Private folders cannot be retrieved and are reported as skipped. Whether reports are retrieved by default is D3.

**Integrations (RM1).**

- **New types.** Named credentials, external credentials, remote site settings, connected apps (OAuth scopes and callback host only), external services (now read, not just named), outbound messages (endpoint host and fields sent) and platform event channels.
- **Apex.** The Apex scanner adds links for `callout:Name` endpoints, `setEndpoint` with a literal URL (host only) and `EventBus.publish` of platform events.
- **What is kept.** Endpoint paths and query strings are dropped, since they can hold keys, and no authentication parameter is ever kept.
- **Summary.** `metadata_summary` gains an integrations section: which systems the org talks to, through what, and from which classes and flows.

**Remote repos.** `index --repo github:owner/repo[#branch]` (also `gitlab:`, `azure-devops:<url>` and `git:<url>`) clones with your own CLI into the workspace and indexes the checkout. It pulls again on the next run, so the parse cache makes re-runs quick. The `metadata_index` tool takes the same source.

**G2 again.** The full UAT run is measured again with reports and integrations included, against 30 minutes.

## 6. Release, documents and the 0.x removal

**Trusted publishing.**

- **The workflow.** The release workflow publishes through GitHub's OIDC: `id-token: write` (already there), and npm 11.5.1 or later (Node 24 ships an older npm on some runners, so the job installs it). npm tries trusted publishing first, so the `NPM_TOKEN` secret works as a fallback until you delete it. Provenance becomes automatic; the provenance input stays for when Sigstore is down. The retry logic stays.
- **Your steps on npmjs.com.** After the workflow PR merges:
  1. Open the `sf-agent-po` package, then **Settings**, then **Trusted publishing**. Choose **GitHub Actions** and fill in "Organization or user" `taouani`, "Repository" `sf-agent-po`, "Workflow filename" `release-next.yml` and "Environment name" `npm-next`.
  2. Run Release next within two days, since npm drops an unused setup.
  3. When that release works, set **Publishing access** to "Require two-factor authentication and disallow tokens", then delete the `NPM_TOKEN` secret and the npm token itself.

**The `latest` tag.** D5.

**Documents.**

- **User guide.** `docs/user-guide.md` is rewritten for v1: install with `npx`, `init`, `index`, the guided workflows, approvals, feedback, `doctor` and key backup.
- **Contributor guide.** `CONTRIBUTING.md` covers workspaces, checks, append-only migrations, the masking rules every new reader must follow, and how domain experts add content without code.
- **Troubleshooting.** `docs/troubleshooting.md` gives one entry per `doctor` failure.
- **Issue templates.** These ask for the `doctor` output.

**Removing 0.x.**

- **What goes.** `src/`, `test/` and the root `dist/`, plus the 0.x README sections. The root `package.json` becomes the private workspace root and keeps `repository`, `homepage` and `bugs` for the pack script.
- **What stays.** The importer for 0.x JSON contexts stays, so 0.x users keep their contexts.
- **What it settles.** The backlog item on moving 0.x `context_add_file` to the new loader goes with it.
- **Before deleting.** The last 0.x commit gets a tag, `v0-final`, so the old server can still be built. D4.

## 7. Delivery

Fifteen PRs, in this order: the npm token deadline first, then the index (your re-index this week shows what to fix), then feedback, then hosts and clean-up. Each PR has a separate review agent, and `npm run typecheck` and `npm test` pass before every push.

| # | PR | What it delivers | Needs |
| --- | --- | --- | --- |
| 1 | Trusted publishing | Release workflow on OIDC; `latest` handling per D5 | D5 |
| 2 | Key backup | `key export` and `key import` |  |
| 3 | `doctor` | Command and `server_status` tool |  |
| 4 | Parse cache | Migration 12, incremental project re-index, `--full` |  |
| 5 | Incremental org re-index | Listing by date, partial retrieve, deletes | 4 |
| 6 | Remote repos | `index --repo`, `metadata_index` source | 4 |
| 7 | Reports and dashboards | Readers, folder listing in org retrieve, links | D3 |
| 8 | Integrations | Readers, Apex callout and event links, summary section |  |
| 9 | Impact and query tools | New types in `metadata_impact`, search and summary; G2 measured again | 7, 8 |
| 10 | Feedback store and Jira diff | Migration 11, `feedback_jira_diff` | D2 |
| 11 | Review page | Story verdicts and design ratings | D1, 10 |
| 12 | Report | `feedback_summary` and `report` | 11 |
| 13 | Batched masking | One model call for up to 32 short strings |  |
| 14 | Hosts | Cursor skills, Claude Code fixes from your host check | your host check |
| 15 | Remove 0.x | Tag `v0-final`, delete 0.x, v1 user guide, contributor and troubleshooting guides, issue templates | D4 |

**Releases.** next.7 after PR 9, for your G2 re-run. next.8 after PR 15. Each is bumped in its PR so the release check passes.

**Evaluation.** The OpenRouter credit is $0.49, so phase 5 makes no paid model runs. The judge's rubric does not change in this phase, so the 8 Nov scores still hold. D6 is how phase 6's final evaluation gets paid for. Your answer (A, C or LiteLLM) keeps it open until phase 6. To make all three possible, a 16th PR, small and free to test, lets the eval call any OpenAI-compatible endpoint: a LiteLLM proxy, your own keys behind it, or a local model.

## 8. What I need from you

- [x] Answers to D1 to D7 in section 9.
- [ ] After PR 1: the three npmjs.com steps in section 6, then a release within two days.
- [ ] The Claude Code host check, before PR 14.
- [ ] Your UAT re-index this week, with the time it took; after next.7, the same run with reports.
- [ ] One real backlog published through next.7 or later, so your team's edits feed the Jira diff, and your verdicts on the review page (gate item 3).

## 9. Risks and decisions

| Risk | Mitigation |
| --- | --- |
| Salesforce's last-modified dates miss a change, so an incremental run keeps a stale component | Profiles and permission sets always retrieved; `--full` at least weekly; `doctor` shows each snapshot's age |
| Reports make the full org run too slow | Folders listed once; a cap per run (D3); G2 measured again |
| The Jira diff calls edits major that the team sees as minor | The review page shows the guess and you override it; the threshold is a setting |
| Batching changes detections | Identical-output check on the spike sentences in the CI model job before merge |
| Removing 0.x breaks someone's setup | Tag `v0-final`, a note in the README and release notes |

| ID | Question | Options | My recommendation | Your answer |
| --- | --- | --- | --- | --- |
| D1 | How are story verdicts captured? | A: a review page on localhost, opened by a tool, with the Jira diff's guess filled in. B: Jira labels your team sets, read back by the diff. C: both | A. It works without changing your team's Jira habits; B can come later | A |
| D2 | When is a Jira edit "major"? | A: more than 30% of the words of the description and acceptance criteria changed, or an acceptance criterion added or removed. B: any change to acceptance criteria. C: only what people mark | A, shown as a guess you can override, with the 30% as a setting | A |
| D3 | Are reports retrieved by default? | A: on by default, private folders skipped, at most 5,000 reports per run (most recently changed first). B: only with `--reports` | A. Impact analysis on fields is the reason to have them | A |
| D4 | Can the 0.x server go? | A: yes, after tag `v0-final`, once you no longer use it. B: keep it until phase 6 | A, if your live use is all on `@next` now | A |
| D5 | What should `npx sf-agent-po` (no tag) run until 1.0? | A: move `latest` with each `next` release. B: leave it; the docs say `@next` | A. Today it runs next.0, which misses phases 3 and 4 | A |
| D6 | How is phase 6's final evaluation paid for? | A: you add about $30 of OpenRouter credit in June 2027. B: free OpenRouter models only (weaker judge, rate limits). C: your own API keys if you get some | A, decided closer to the date; nothing is spent in phase 5 | I am thinking A, C or/and litellm |
| D7 | Is metadata text shown on the input review page? | A: no; metadata is masked on the way out and is mostly not people's text. B: yes, for every index run | A | A |

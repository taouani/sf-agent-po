# sf-agent-po

An MCP server that gives Claude Code, Cursor and GitHub Copilot a Salesforce **Solution Architect** and **Product Owner**. The host's own model does the reasoning. The server supplies:

- a **requirement context** built from meeting notes, emails, PI planning output, Jira, Confluence, documents and images, with personal data and secrets **masked** before any model sees them;
- a **metadata index** of your Salesforce org or project, with search, scope and impact analysis;
- **guided workflows** for high-level and detailed designs, backlogs and story reviews, one checked step at a time, in English or French;
- **publishing** to Confluence and Jira that runs only after you approve, on a page the server opens in your browser, which shows exactly what will be written with the real values put back;
- **feedback**: story verdicts, design ratings and a Jira diff, measured against the goal of 90% of stories accepted without major edits.

This is version 1, in pre-release on npm as `sf-agent-po@next`. How to install and use it is in the [package README](packages/mcp/README.md).

The 0.x server (the root `dist/index.js` with JSON contexts) was removed in phase 5. Its last version is the tag [`v0-final`](https://github.com/taouani/sf-agent-po/tree/v0-final). Its contexts (`.sf-agent/contexts/*.json`) can be copied into a v1 workspace with `importLegacyWorkspace` in `packages/core`; no command runs it yet.

## Status

The [v1 plan](docs/plan.md) has the phases and their gates. Phases 0 to 4 are done (masking, approval, metadata index, scope and impact analysis, guided workflows; gate G3 accepted on 10 Nov 2026). Phase 5 (feedback, hosts, hardening) is in progress; its [plan](docs/phase-5-plan.md) lists the pull requests. The [phase 1 review](docs/phase-1-review.md) holds the analysis behind the plan, the [phase 4 plan](docs/phase-4-plan.md) details the guided workflows, and [Testing scope and impact tools](docs/testing-scope-and-impact.md) is a hands-on test guide.

## Quick start

Node.js 24 or later. Add the server to your AI tool, then write the agent files into your project:

```bash
claude mcp add sf-agent-po \
  -e ATLASSIAN_SITE_URL=https://your-company.atlassian.net \
  -e ATLASSIAN_EMAIL=you@company.com \
  -e ATLASSIAN_API_TOKEN=... \
  -- npx -y sf-agent-po@next
npx -y sf-agent-po@next init --host claude-code   # or cursor, copilot, all
npx -y sf-agent-po@next doctor                     # checks the set-up
```

For Cursor (`.cursor/mcp.json`) and VS Code Copilot (`.vscode/mcp.json`), the server is the command `npx` with the arguments `["-y", "sf-agent-po@next"]` and the same three variables in its `env`.

| Host | Files `init` writes | How to use |
| --- | --- | --- |
| Claude Code | `.claude/agents/salesforce-{solution-architect,product-owner}.md`, `.claude/commands/{sa-hld,sa-detailed,po-backlog,po-review}.md` | Subagents, plus `/sa-hld renewal integrations` etc. (the first word is the context) |
| Cursor (2.4 or later) | `.cursor/rules/salesforce-*.mdc` (agent-requested rules), `.cursor/skills/{sa-hld,sa-detailed,po-backlog,po-review}/SKILL.md` | `/sa-hld` etc. in Agent chat; name the context in your message, or the agent asks |
| GitHub Copilot (VS Code) | `.github/agents/salesforce-*.agent.md` (custom agents), `.github/prompts/*.prompt.md` | Pick the agent, or run `/sa-hld context=renewal` etc. |

## Sample scenarios

[`examples/`](examples/) has realistic input sets (an insurance renewal portal with existing metadata, and a business banking onboarding without any) with a rubric of what good SA and PO output contains. Use them to try the agents and to compare models or prompt changes with the [evaluation runner](packages/eval/README.md), which scores them with these rubrics.

## Development

```bash
npm test          # vitest
npm run typecheck
```

### Packages

The code lives in npm workspaces under `packages/`:

- `packages/core`: the workspace database (SQLite through `node:sqlite`, with migrations).
  It also holds masking, the metadata index and the workflow engine. It needs Node 24.
  `importLegacyWorkspace` copies the 0.x contexts (`.sf-agent/contexts/*.json`) into the
  database, keeping document ids and dates. It only reads the JSON files.
  Domain content (industry templates, including the new luxury one, the agents' roles and
  practices, and design templates) is Markdown in `packages/core/content`, so it can be reviewed
  and changed without touching code.
  `detect` finds what masking hides (personal data and secrets): rules for structured values
  and street addresses, a dictionary of names the context already knows, and the detection
  model for other names. Places and company names stay visible unless they are part of an address.
  `loadDetectionModel` downloads the model on first use (138 MB, checked against pinned
  SHA-256 checksums, cached in the user's cache folder or `SF_AGENT_PO_MODEL_DIR`) and runs it
  on the WebAssembly build of ONNX Runtime that the package ships in `vendor/` (no native code).
  The model's answers for short texts (up to 200 characters, the 5,000 most recently used) are kept in
  memory, so metadata keys, labels and Jira fields that come back are not run again; the model
  gives the same text the same answer, so this changes only the time. (Running short texts
  together was tried in #76: about half as fast, and it changed detections.)
  `npm test` copies those runtime files there first; set `SF_AGENT_PO_MODEL_TEST=1` to also
  run the test against the real model.
  `Vault` replaces what `detect` finds with stable pseudonyms per context (`[PERSON_1]`,
  `[EMAIL_1]`), keeps the originals encrypted (AES-256-GCM) in the workspace database, and
  puts the real values back for the final write after approval. Secrets stay masked even then.
  Phone numbers, IBANs and the like that differ only in format share a pseudonym and come back
  in the first spelling seen; names merge only when they differ by case, spacing or apostrophe style.
  Its key is 32 random bytes, one per workspace. `openVault` keeps it out of the workspace: in
  the macOS keychain, in a Windows DPAPI-encrypted file, or in the Secret Service keyring
  (GNOME Keyring, KWallet) on Linux, through the tools each OS ships. Where none of these
  works (a server without a keyring), it falls back to a key file only the user can read,
  and says so. `exportVaultKey` and `importVaultKey` back the key up as text and restore it,
  for example on a new computer; the `key export` and `key import` commands of the package
  call them. Without the key, masked documents cannot be unmasked, so back
  it up when it is created. The keychain protects the key at rest and while you are logged
  out; like any keychain item an app reads without a prompt, other programs running as you
  can read it too.
  `Masker` ties these together at the edges (AR1): it masks each document's title, content and
  metadata (keys, values and numbers) when it is added (`addDocuments`, or `maskContext` for
  contexts imported from 0.x), replaces its source with a pseudonym, records what it masked
  and whether the model ran, and puts real values back in approved output (`unmask`),
  listing what stays masked. Names and addresses a context has masked once are masked in
  every later document, even without the model (one-word names only in their own case).
  Images (PNG, JPEG) are masked locally too (FE4): `createRecognizer` starts an OCR worker
  (Tesseract in WebAssembly, with English, French and Simplified Chinese data shipped in the
  package, so nothing is downloaded), and `Masker.maskImage` reads the image's words, finds
  what to hide with the same detection, and blacks out each word that holds some of it (and
  text that looks like a pseudonym). Transparent pixels are laid on white first, so the OCR
  and every later reader see the same image, and a page the OCR reads poorly is tried turned.
  It returns the redacted image as an upright PNG with no metadata (EXIF can hold names and
  places), the OCR text masked for models that cannot see images, the words the OCR was
  unsure of, and whether the reading can be trusted, for the user to check before the image
  is used.
  Metadata index: `MetadataIndex` is the local metadata index (decision B, phase 3).
  `scanProject` reads a Salesforce project in source format (`sfdx-project.json` package
  folders) or metadata format (`objects/*.object`): objects, fields, record types and
  validation rules, with lookups, picklists and formulas. Each indexing run is a snapshot;
  the newest ready one of a source is used, and a failed run leaves the previous one in
  place. Components link by edges (`part_of`, `references`, and `reads` for the fields a
  formula or rule uses, followed through relationships such as `Parent__r.Owner.Email`);
  standard objects and fields that are only referenced become placeholders. `search` uses
  SQLite full-text search (trigram, accents folded) and `related` walks the graph up to
  three hops. Descriptions, help text, picklist values and messages (in `text`) and formulas
  are stored as the project holds them, and are masked by whatever passes them to a model.
  API names match without case. A project folder that cannot be read fails the run, so it
  never replaces a good index. Flows and processes are read too: what starts them
  (`triggers_on`, entry conditions included), the objects and fields they read and write
  through `$Record`, record variables, Get Records results and loops, and the Apex actions,
  subflows, email alerts, quick actions, external services and screen components they call
  (`calls`). Apex classes and triggers are scanned for the
  objects and fields they query and write (inline SOQL, DML, `record.Field`), the classes,
  flows and custom labels they use, and a trigger's object; comments are not kept, and
  queries built in strings (`Database.query`) are not read. Permission
  sets and profiles grant (`grants`) objects with their CRUD level, fields (read or edit),
  classes, pages, flows and layouts; permission set groups include (`includes`) permission
  sets; layouts show (`shows`) their fields, buttons, related lists and actions. Reports read
  (`reads`) their report type and the fields they show, group by, filter on, bucket and chart
  (custom report type columns `Object$Field`, standard ones `Object.Field__c`; Salesforce's
  capitalised names for standard columns are left out); dashboards read the reports their
  components show; custom report types read their base object and their columns' fields.
  Filter values and dashboards' running users are never kept: only the fields filters are
  on (the retrieved XML in the workspace still holds filter values; running users are taken
  out). Joined
  reports are read block by block. An org run retrieves reports, dashboards and report types
  too, with their dates and their folders' from three queries (`sf data query`), or one
  listing per folder when a query fails; past 5,000 reports only the most recently changed
  are retrieved, and the rest are reported. Reports in private folders are not listed by
  Salesforce, so they are not indexed. Integrations are read for where the org connects:
  named credentials (their host, and the external credential they use), external credentials
  (protocol, auth provider), remote site settings (host), connected apps (OAuth scopes and
  callback hosts), external services (the named credential they call through, their
  operations), outbound messages in workflows (host and the fields they send) and platform
  event channels and members. Apex adds `calls` to a named credential for each `callout:Name`,
  the host of each literal `setEndpoint` URL (`calloutHosts`), and `writes` to each platform
  event it publishes (`EventBus.publish` of a `new Foo__e`). Only hosts are kept of URLs,
  descriptions included, an IP address shows as "(an IP address)", and never a consumer key,
  certificate, parameter value, username or email; a host can still name a client. An org run
  takes those elements out of the files it keeps too. Auth providers hold a secret and are not
  retrieved: an external credential names its provider in its attrs. Every other
  type in Salesforce's metadata type registry (copied from source-deploy-retrieve 13.12.0,
  Apache-2.0, by `scripts/metadata-registry.mjs`; the library itself is not a dependency) is
  indexed by name and file, including bundles, static resources, sites, documents, folders
  and child types such as list views and bot versions. Report, dashboard, document and email
  template names come from folders people name, and are masked like `text`.
  A run parses only the files that changed since the last run of the same source: the
  `metadata_file` table keeps each file's hash and the components read from it, and links
  are recomputed over the whole set. A file is parsed again when it changed, when it was
  last parsed more than 7 days ago, or when the readers changed (`readerVersion`, a hash of
  their code and of the XML parser's version); `index --full` parses every file.
- `packages/connectors`: everything that talks to the outside: the Jira and Confluence
  client, the Salesforce CLI, git hosts for metadata, and local files (notes, emails).
  Local files can also be PDF, Word, PowerPoint, Excel, CSV/TSV or draw.io: each is read into
  Markdown that keeps its shape (headings, lists and tables; slides with their titles and
  notes; sheets by name; a diagram's shapes and connections), with no native code. Scanned
  PDFs need OCR, which comes with storing redacted images.
- `packages/mcp`: what users will install. `src/main.ts` starts the v1 server on stdio
  (workspace in `SF_AGENT_WORKSPACE`, else `.sf-agent`). Its context tools add files (images
  included), pasted text, Jira issues and Confluence pages through `Intake`, and return only
  pseudonyms: titles, sources, summaries and error messages are masked too, and inputs not
  masked yet are only counted. A call that needs the user opens the approval page in the
  browser itself (the link is never handed to the host, where the model might read it) and
  reports progress while it works or waits. Turning input review off needs the user's
  approval on the page. A folder gives at most 20 images per call. The name detection model
  loads on first use; if it cannot, nothing is added. `design_save` stores a design masked:
  the pseudonyms the agent used stay, names it wrote in clear are masked (`Masker.maskOutput`).
  `confluence_publish` puts the real values back only for the write: the user sees the page
  title, body and target with the real values on the approval page, secrets stay masked, and
  exactly what they approved is written. The page is made from the masked Markdown and the
  values are put in escaped afterwards, so no value can change its structure. The model gets back the masked title and a page link
  without its title part. `backlog_save` stores a backlog the same way, every text field
  masked with one run of the detection (`Masker.maskOutputs`), and runs the quality check;
  `backlog_get` and `backlog_check` read it back. `jira_publish` shows the user every epic
  and story as it will be written, with the real values, what Jira holds now (edited since
  the last publish, moved to another epic, deleted), the labels and the dependency links,
  and writes only once they approve. Descriptions are built from the masked backlog and the
  values go into their text nodes. Each issue is recorded as soon as it is written, so a
  failure part-way never duplicates issues on the next publish, and the model is told only
  Jira's status code and what was done, with pseudonyms. It keeps each story as it was sent,
  masked, in the `published_story` table (migration 12, deleted with the backlog), for
  `feedback_jira_diff`, which first checks that the login can see the project, then reads the
  published stories back from Jira in bulk once the team has worked on them and compares them in
  memory: unchanged, minor edit, major edit (by default more than 30% of the words of the summary
  and description changed, or an acceptance criterion added or removed; the share is the
  context's `majorEditShare` setting) or deleted. Only the result, how much changed and the
  status category are stored (the `feedback` table, per published version) and returned, never
  Jira's text; the model label passed with it (`model`) is kept as a context setting for the report.
  `feedback_review` opens a review page, like the approval page, for one role (PO, SA or dev
  team, its `role` argument): a verdict on each published story as it was sent (accepted, minor
  edit, major edit, rejected; that role's earlier verdict, or else the Jira diff's guess, is
  filled in, and saving confirms it) and a rating from 1 to 5 for each section of the designs
  behind the backlog. Ratings are kept by the section's heading without its number, so
  renumbering a design keeps them. Only what changed is written, a cleared verdict or rating is
  removed, and a comment is kept until a new one replaces it. Comments and the model label,
  which the page asks for once when the context has none, are masked before they are saved.
  `feedback_summary` and `npx sf-agent-po@next report` give the success measure: the share of
  published stories accepted without major edits against the 90% target, by context, model
  label (the one set when the backlog was published) and workflow, and the average rating of
  each section of each design's current version. Each story still in a published backlog
  counts once, at the version last sent to Jira; a person's verdict counts before the Jira
  diff's guess, the PO's first. `report --context <name>` keeps one context and `--csv <file>`
  writes the same numbers to a CSV file readable only by you, outside the workspace. The
  command opens the workspace read-only and reads only masked data, so it needs no vault key,
  and nothing leaves the machine. The four agent workflows
  (`sa_high_level_design`, `sa_detailed_design`, `po_backlog`, `po_review_stories`) are MCP
  prompts and, for hosts with agent files, the `agent_workflow` tool; they tell the agents to
  keep pseudonyms as written and that each publish waits for the user's approval in the
  browser. `industry_guidance` gives the industry templates. `npx sf-agent-po@next init` writes the
  agent files for Claude Code, Cursor and Copilot from the same text, with the v1 rules. For
  Cursor (2.4 or later) the workflows are skills, `.cursor/skills/<name>/SKILL.md`, run only
  when typed (`/sa-hld`); versions up to next.7 wrote `.cursor/commands/*.md`, and `init` and
  `doctor` name those files to delete, so Cursor does not offer each workflow twice.
  `npx sf-agent-po@next index --project <folder>`, `--repo <repository>` or `--org <alias>` fills the workspace's
  metadata index: an org is retrieved in metadata format with the user's own `sf` CLI (read
  only; the types the index uses, in parts of at most 9,000 files, with profiles merged back),
  under `<workspace>/orgs/<org id>-<suffix>/metadata`, the last complete one named by
  `<org id>.json` with each component's last-modified date (`sf org list metadata`). The next
  run retrieves only what changed since (an object with all its children and layouts), into a
  copy of the last retrieval, and removes what was deleted. Profiles and permission sets are
  retrieved every time, since Salesforce does not date a change of access. A permission set
  comes back whole and replaces its last copy; a profile is merged into its last copy: access
  to components retrieved again comes from this run, the rest stays. Labels, workflows and
  email templates are retrieved every time too, and a component the org did not return is
  asked for again next time. Everything is retrieved again with `--full`, a week after the last
  full run, when the types indexed changed, or when the last retrieval or a profile's last copy
  is missing (a new profile). What a standard object holds itself (its settings, overrides,
  search layouts) has no date, so it waits for the weekly full run. A repository
  (`github:owner/repo`, `gitlab:group/repo`, `azure-devops:<clone URL>` or `git:<clone URL>`,
  with `#<branch>`) is cloned with the user's own `gh`, `glab` or `git` into
  `<workspace>/repos`, and fetched again on the next run (a force push too), so the parse cache
  finds the files that did not change; it is named by its name, branch and a hash of where it
  is, without credentials. A project is named by its folder and a hash of its path,
  an org by its id. `BackgroundIndexer` runs the same without blocking, for the server, whose
  metadata tools let the agents index and read the org: `metadata_index` (in the background),
  `metadata_sources`, `metadata_summary` (types, the busiest objects with their fields,
  rules, flows and triggers that run on its records, and the integrations: each host the org
  calls, through which named credential, remote site setting, outbound message or Apex endpoint,
  from which classes and flows, busiest first, flagged when Apex calls a URL no active remote site
  setting allows; connected apps and event channels), `metadata_search` (a host finds what calls or allows it) and `metadata_component` (one
  component, its children and what it reads, writes, calls or grants, one or two links away).
  `scope_propose` puts the objects a piece of work touches in front of the user on the approval
  page (they untick, tick linked objects or type others); the confirmed objects are kept with the
  context, and `scope_show` gives them with their fields, rules, record types, the flows, triggers,
  code and layouts linked to them, what that automation calls (two hops), who grants access, and
  the objects outside the scope that it touches.
  `metadata_impact` takes the components a piece of work adds, changes or deletes and lists what
  depends on each, one or two links away, with the weak links: Apex the index cannot follow
  (queries built from strings, classes named at run time, describes, files too large to read),
  inactive flows, dependents outside the confirmed scope, and the automation that saves records a
  new rule or required field can stop. Reports and report types that use a component are counted
  apart and the first ten named, and what lies two links away (dashboards, reports on those report
  types) is counted; outbound messages that send a field and change data capture on its object
  are flagged as outside systems that receive the change; for an active remote site setting, the
  Apex that calls its host with an endpoint written in the code.
  API names are returned as they are; labels, descriptions, formulas, picklist values and the
  names of reports, dashboards, documents and email templates are masked before they are
  returned (masked names can be passed back), and long details are cut. `node scripts/pack-next.mjs --smoke` builds the
  installable pre-release, one `sf-agent-po` package with core, connectors, the model runtime
  and the content bundled inside, then installs it in an empty folder and runs it (CI does
  this on the three systems). Nothing is published by it: the `Release next` workflow
  publishes `sf-agent-po@next` to npm, only when started by hand from main, after the checks,
  the tests and both smoke tests, with provenance (retried when Sigstore's transparency log fails, and optional while it is down; it runs in the `npm-next` environment, which can require
  an approval, and publishes through npm trusted publishing, with no npm token once that is set up on npmjs.com; it also tries to move the `latest` tag to each pre-release until 1.0 (when npm refuses, the run's summary gives the command to run by hand), and it needs a new
  `-next.n` version in `packages/mcp/package.json` each time; it is a dry run by default). It also holds the approval page (AR5): a small
  server on 127.0.0.1, plain HTML forms and no script, where the user rather than the model
  approves each write with its real values, confirms each redacted image (or sends only its
  text), and checks masked inputs before the agents use them (on by default in pre-releases,
  `reviewInputs` per context). Values the user says are still in clear come back so they
  can be hidden and checked again. Each request opens through a single-use link that the
  browser trades for a cookie only it holds, so a link seen in a process list or history is
  worthless (a second use withdraws the request); the page refuses other host names and
  cross-site posts, shows a frozen copy of what was asked, returns its digest with the
  decision, and expires after 30 minutes. `openInBrowser` opens the link so it does not
  pass through the model. `Intake` adds inputs through it: each input is masked; while
  review is on, it is stored only once the user approved it as shown; an image is always
  confirmed, and stored as the redacted PNG the user saw (or as its masked text only).
  Values the user names, even alongside a reject, are hidden in that input and every later
  one of the context, as they wrote them, in any case and however short (two characters at
  least); a pseudonym copied with them is left out. The user then checks again, up to five
  times.
- `packages/eval`: measures the agents' output. It runs scenarios (inputs plus a rubric) against
  the MCP server with Anthropic, OpenAI or xAI models and has a judge model score the result.
  See [packages/eval/README.md](packages/eval/README.md).

`npm test` and `npm run typecheck` cover every package; `typecheck` also checks the tests
(`tsconfig.check.json`).

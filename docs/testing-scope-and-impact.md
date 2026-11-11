# Testing scope and impact tools

> Copy of the [Testing scope and impact tools](https://claude.ai/artifact/D8Z9UzTcWaTBoZbhpWebpZ) Claude Doc, which stays the working version. Written on 8 Nov 2026 for 1.0.0-next.5.

## What you test, and in which version

The scope and impact tools are in the published pre-release `sf-agent-po@next` (1.0.0-next.5). You can test them today, by asking your AI tool to call them in a chat.

| Tool | What it does |
| --- | --- |
| `metadata_index` | Fills the index from an org or a project folder (same as the `index` command). |
| `metadata_sources` | Lists what is indexed, and how far a run has got. |
| `metadata_summary` | Gives the objects of a source and their size, and where the org connects (hosts, connected apps, event channels). |
| `metadata_search` | Finds components by name or label, or what calls a host. |
| `metadata_component` | Shows one component and what links to it. |
| `scope_propose` | Opens the approval page where you confirm the objects the work touches. |
| `scope_show` | Shows the confirmed scope: objects, fields, rules, automation, code, access. |
| `metadata_impact` | Lists what depends on each change, and the weak links. |

The guided design workflow, which calls scope and impact as its own steps, comes with next.6, which is not released yet. Test 4 is for that release.

## Setup

1. Install Node.js 24 or later, and the Salesforce CLI (`sf`) if you want to index an org.
2. Add the server to your AI tool. For Claude Code, in the project folder's `.mcp.json`:

```json
{
  "mcpServers": {
    "sf-agent-po": { "command": "npx", "args": ["-y", "sf-agent-po@next"] }
  }
}
```

Jira and Confluence are not needed for these tests, so leave out the `ATLASSIAN_*` variables.

3. Optional: `npx -y sf-agent-po@next init --host claude-code` (or `cursor`, `copilot`) adds the agent files.
4. The workspace is `.sf-agent` in the folder you start from, or the folder in `SF_AGENT_WORKSPACE`. Use a fresh folder for the tests, so that nothing from earlier runs is mixed in.
5. Index the small sample project first. It has one object (`Policy__c`, with the fields `Account__c` and `Premium__c`), a record-triggered flow `Policy_Renewal`, the class `PolicyService`, the trigger `PolicyTrigger`, the permission set `Policy_Admin` and the component `policyCard`:

```bash
git clone https://github.com/taouani/sf-agent-po
npx -y sf-agent-po@next index --project sf-agent-po/examples/insurance-renewal/metadata
```

6. Then index a real org, a sandbox or a developer org. The org is only read:

```bash
sf org login web --alias my-sandbox
npx -y sf-agent-po@next index --org my-sandbox
```

You can also ask in the chat: "Index the org my-sandbox". The tool runs in the background; ask for `metadata_sources` to see how far it has got. Note how long a large org takes.

## Test 1: index and explore

Ask in the chat, one at a time:

1. "Which metadata sources are indexed?" (`metadata_sources`). Expect both sources, with the counts of components and the time of the run.
2. "Summarise the objects of my-sandbox" (`metadata_summary`).
3. "Search the index for renewal" (`metadata_search`). On the sample, expect the flow `Policy_Renewal` and `PolicyService`.
4. "Show the component `Policy__c`" (`metadata_component`). Expect its fields, the flow and the trigger on it, and the permission set.
5. Search for a name that does not exist, such as `Polcy__c`. Expect close matches, not an error.

Check that labels and help texts with personal data are masked in the chat (`[PERSON_1]` and so on).

## Test 2: confirm the scope on the approval page

Start with a small piece of work, for example: "We want to add a renewal date and a renewal status to policies. Propose the scope."

1. The model calls `scope_propose` with a list of objects and a reason. Your browser opens the page "Confirm what this work touches".
2. On the page, try each of these, then confirm:
   - Untick an object the model proposed.
   - Tick a linked object the page offers.
   - Type the API name of another object, then one that does not exist (expect it to be refused or shown as unknown).
   - Add a comment.
3. Ask "Show the scope" (`scope_show`). Expect only the objects you kept, with their fields, rules, record types, the flows, triggers, code and layouts linked to them, who gives access, and the objects outside the scope they touch.
4. Propose again and press Reject this time. Expect the model to be told you rejected it, and the earlier scope to stay.
5. Ask for a scope in the org with many objects (around ten) and note whether the page stays readable.

The approval link must never appear in the chat. If you see it there, send me a screenshot.

## Test 3: impact analysis

Ask the model to analyse the impact of a change (`metadata_impact`). Each case below says what to look for.

| Case | Ask | Expect |
| --- | --- | --- |
| Change a field used by automation | "What is the impact of changing `Policy__c.Premium__c`?" | What uses the field, one or two links away. |
| New rule on a saved object | "Impact of adding a validation rule on `Policy__c`" | The flow `Policy_Renewal` and the trigger `PolicyTrigger` named as automation that saves records the rule can stop. |
| New required field | "Impact of adding a required field `Renewal_Date__c` on `Policy__c`" | The same warning about the automation that saves records. |
| Delete a referenced field | "Impact of deleting `Policy__c.Account__c`" | Its dependents listed as breaking. |
| Add something that exists | "Impact of adding the class PolicyService" | A note that it already exists. |
| Outside the scope | A change on an object you did not confirm | Its dependents flagged as outside the confirmed scope. |
| Unknown name | A field that is not indexed | Close matches. |
| Weak links (real org) | A field used by dynamic SOQL, or an object with an inactive flow | The Apex the index cannot follow, and the inactive flow that would break once activated. |
| Reports (real org, next.7) | A field shown or filtered on in reports | The number of reports and dashboards, and the first ten named. |
| Integrations (real org, next.7) | A field sent by an outbound message, or an object with change data capture on | A weak link naming the outbound message and its host, or the change data capture channel. |

The sample project is small, so the weak links can only be seen on a real org. For each case, note anything missing that you know is there, and anything listed that is wrong.

## Test 4: inside the guided design (next.6)

When next.6 is released, start a high-level design with the guided workflow (`workflow_start`). Check that:

1. The scope step opens the same approval page, and the design only names the objects you confirmed.
2. The impact step lists the changes of the design and calls `metadata_impact` for them.
3. If the design changes a component the impact step did not look at, the answer is sent back with a reason, and the model fixes it.
4. The design's impact section matches what you saw in Test 3.

## What to send back

- For each test, what you asked and the tool's answer (copy from the chat; it is masked).
- Screenshots of the approval page, before and after your changes.
- How long the index of your org took, and roughly how many objects it has.
- Anything wrong, missing or hard to read, and any error message as it appeared.
- Which AI tool and model you used.

# Sample scenarios

Each folder is a realistic set of inputs for the agents, plus a rubric describing what good output looks like. Use them to try the agents, to compare models or prompt changes, and as a regression set.

| Scenario | Industry | What it exercises |
| --- | --- | --- |
| `insurance-renewal` | `insurance` | Meeting notes, PI planning, a security email, a business owner email that overrides the PI plan, and a metadata repository with existing automation on the same object |
| `banking-onboarding` | `financial-services` | Workshop notes, compliance non-negotiables, existing Jira epics, and no metadata (unknown current state) |

## Running a scenario

In Claude Code, Cursor or Copilot with the sf-agent-po server configured:

1. Ask the agent to add the scenario's `inputs/` folder (and `metadata/` with provider `local`, when there is one) to a context named after the scenario.
2. Run the Solution Architect's high-level design, then the Product Owner's backlog, with the scenario's industry.
3. Score the output against `rubric.md`, by hand or with a model as judge.

`insurance-renewal/reference-backlog.json` is a hand-written backlog that meets the rubric. The automated tests load it to check that the quality check accepts a good backlog and that each of the security team's six requirements is covered by a story citing their email. In it, `{{inputs/<file>}}` stands for the id of that input document, which depends on where the scenario is stored.

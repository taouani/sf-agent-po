# Business banking onboarding: evaluation rubric

This scenario has no metadata repository or org, so it also tests how the agents handle an unknown current state. Load `inputs/` into a context such as `banking-onboarding`, and use the `financial-services` industry template.

## High-level design (sa_high_level_design)

- [ ] States that the current org is unknown (no metadata or org documents) and suggests adding them, rather than inventing existing components.
- [ ] Proposes Financial Services Cloud (already licensed) and checks which data model applies (managed package or core objects) as an open question.
- [ ] Models the business, its directors and beneficial owners (relationships with ownership percentage) and the onboarding case.
- [ ] Integrates the screening provider for identity verification and sanctions/PEP checks, with error handling and re-screening.
- [ ] Integrates with core banking for account opening and returns the account number to Salesforce, naming the pattern.
- [ ] Uses Experience Cloud for client document upload and status, with a suitable licence and MFA.
- [ ] Enforces segregation of duties: only operations approves, RMs cannot approve their own clients (permission sets, approval process or validation).
- [ ] Applies RM and regional operations visibility (sharing model, for example Compliant Data Sharing or criteria-based sharing).
- [ ] Addresses 5-year retention of screening evidence after the relationship ends, and EU data residency (Hyperforce region).
- [ ] Traces every compliance requirement to the design, and cites source ids.

## Backlog (po_backlog)

- [ ] Epics align with ONB-1 and ONB-2, and stories can be published under them (jiraKey on the epics).
- [ ] Stories cover online application, document upload, status tracking, director and beneficial owner capture, automated screening, approval by operations, account opening and the account number coming back.
- [ ] Each compliance requirement (25% threshold, screening before opening, 5-year retention, segregation of duties, EU residency) is traced to stories or acceptance criteria.
- [ ] Acceptance criteria cover failure paths: a screening hit, a document rejected, core banking unavailable.
- [ ] `backlog_save` reports no errors.

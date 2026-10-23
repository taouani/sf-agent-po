# Insurance renewal portal: evaluation rubric

Use this rubric to judge the agents' output for this scenario, by hand or with a model as judge. Each line is one point. A good run scores at least 80% in each section.

## Inputs

Load the scenario with `context_add_file` on `inputs/` and `context_add_metadata` with provider `local` on `metadata/`, into a context such as `insurance-renewal`.

## High-level design (sa_high_level_design)

- [ ] Treats the policy administration system (PAS) as the system of record for policies and renewal quotes; Salesforce does not price.
- [ ] Integrates with the PAS renewal quote API through Named Credentials, names the pattern (request and reply, or a cached copy refreshed in batch) and addresses the December peak of about 4,000 renewals a day.
- [ ] Uses Experience Cloud for the customer portal and names a suitable external licence.
- [ ] Restricts policyholders to their own policies and documents (external org-wide defaults, sharing sets or equivalent), and excludes broker-managed policies from online renewal.
- [ ] Meets MFA for portal logins.
- [ ] Keeps card data out of Salesforce with the hosted payment page, reducing PCI DSS scope.
- [ ] Handles "encrypted at rest" correctly: the platform already encrypts at rest; Shield Platform Encryption only if InfoSec requires customer-managed keys or field-level encryption, with its trade-offs.
- [ ] Notices that 7-year auditability exceeds standard retention (field history, login history) and proposes Field Audit Trail, Event Monitoring or export to an archive or SIEM.
- [ ] Designs the renewals agent worklist (policies due in 30 days, customers who have not acted).
- [ ] Creates an agent task when a policyholder abandons an online renewal.
- [ ] Blocks online renewal and routes to an agent when the premium rises by more than 20%.
- [ ] Records the conflict about mid-term changes (PI stretch objective vs the business owner's email) and follows the business owner: out of scope for phase 1.
- [ ] Uses the existing metadata: `Policy__c`, the `Policy_Renewal` record-triggered flow and `PolicyTrigger` on the same object, and flags the order-of-execution risk of mixing them.
- [ ] Plans a penetration test before go-live and the deadline of 1 November.
- [ ] Cites source document ids, and lists open questions with owners (for example: does InfoSec require customer-managed keys? who owns the renewal quote cache?).

## Backlog (po_backlog)

- [ ] The backlog covers the committed PI objectives 1 to 3, as epics or as stories within them; objective 4 (mid-term adjustments) is out of scope.
- [ ] Stories cover: view the renewal quote, accept it, pay the first instalment through the hosted payment page, the broker-managed message, the more-than-20% rule, the abandonment task, the agent worklist.
- [ ] Every InfoSec requirement (MFA, own data only, no card data, encryption, 7-year audit of both logins and renewal acceptances, penetration test) is traced to at least one story or acceptance criterion.
- [ ] Details the inputs do not give (for example when a renewal counts as abandoned) are recorded as assumptions or open questions.
- [ ] Acceptance criteria are Given/When/Then, testable, and include permission and error paths (for example a broker-managed policy, an expired quote, a failed payment).
- [ ] Personas are specific (Policyholder, Renewals agent, Security officer), not "user".
- [ ] A spike covers PAS API performance at peak, or the quote caching approach.
- [ ] `backlog_save` reports no errors.

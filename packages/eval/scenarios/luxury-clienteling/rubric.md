# Clienteling for client advisors: evaluation rubric

Use this rubric to judge the agents' output for this scenario, by hand or with a model as judge. Each line is one point. The scenario has no metadata or org documents, uses the `luxury` industry (the retail and consumer goods template in v1), and contains two traps: the retail director's email changes the kick-off scope (Milan joins phase 1, China waits, no WhatsApp messaging), and the DPO's requirements cannot be met by training alone.

## High-level design (sa_high_level_design)

- [ ] States that the current org is unknown beyond Sales Cloud for wholesale (no metadata or org documents) and does not invent existing components.
- [ ] Follows the retail director's email over the kick-off: phase 1 is Paris, London and Milan; Shanghai and Tokyo wait for the China hosting decision.
- [ ] Keeps Cegid (POS) and the e-commerce platform as systems of record for sales and stock, and brings purchase history in as integrated or summarised data, naming the pattern and the mechanism.
- [ ] Models clients as Person Accounts (or explains another choice) with relationships to family and assistants, preferences, important dates, wishlists or holds, and appointments.
- [ ] Computes the client tier from 24-month spend and shows advisors the tier without the exact spend (for example field-level security or a summary in Data 360).
- [ ] Designs client ownership and sharing across boutiques and countries: advisors can see clients who buy elsewhere, but only their own boutique edits notes.
- [ ] Restricts public figures' profiles to their advisor and boutique manager (for example a restricted record type with sharing rules, or a private ownership model).
- [ ] Prevents sensitive data in advisor notes with a technical control (structured fields instead of free text, validation or scanning), not only training.
- [ ] Enforces marketing consent per channel and per country before an advisor can contact a client.
- [ ] Anonymises clients inactive for 3 years with a scheduled process, and says what counts as activity.
- [ ] Keeps Chinese clients' data in China and out of phase 1, and treats China hosting and any transfer to Europe (consent, CAC filing) as an open question for Legal.
- [ ] Does not design WhatsApp messaging from the CRM in phase 1; logs contacts made through WhatsApp Business.
- [ ] Shows advisors whether identity documents are on file for cash payments, and leaves cash checks at the till with Finance (AML).
- [ ] Covers offline access to the client book on mobile, and appointment booking from the website.
- [ ] Cites source document ids, and lists open questions with owners (for example the tier thresholds, the Data 360 licence, the China hosting decision).
- [ ] Is written in English.
- [ ] Traces every must-have requirement in the inputs to a part of the design (by requirement id, or by naming the requirement and its source), or says why it is left out.
- [ ] Every existing org component it names (object, field, flow, Apex class, integration) is one the inputs show; everything else is presented as new.

## Backlog (po_backlog)

- [ ] The backlog covers phase 1 only (Paris, London, Milan) and leaves Shanghai, Tokyo and WhatsApp messaging out of scope, saying why.
- [ ] Stories cover the client profile, the client book with reminders, wishlists or holds, appointments, after-sales status, event invitations and attendance, and purchase history.
- [ ] Every DPO requirement (sensitive notes, consent per channel and country, 3-year anonymisation, China data, public figures) is traced to at least one story or acceptance criterion.
- [ ] Personas are specific roles (for example Client advisor, Boutique manager, Data Protection Officer), not "user".
- [ ] Acceptance criteria are Given/When/Then and include permission and error paths (for example an advisor from another boutique editing a note, contact without consent, offline use).
- [ ] The success measures (70% of sales linked to a client, every VIC contacted each quarter) become reports, dashboards or acceptance criteria.
- [ ] A spike or open question covers the POS integration (Cegid data, volumes, latency) or the tier calculation.
- [ ] The server's quality check of the saved backlog reports no errors (in the save result or the workflow status).
- [ ] Is written in English.
- [ ] Every must-have requirement in the inputs is delivered by at least one story, or is listed as a gap with a reason.
- [ ] Technical notes name only existing org components the inputs or the design show, or mark them as new.

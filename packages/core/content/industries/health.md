---
id: health
name: Healthcare and life sciences
aliases: [healthcare, life-sciences, pharma]
---

## Salesforce products to consider

Health Cloud (patient and member management, care management, utilization management), Life Sciences Cloud for pharma and medtech, Experience Cloud for patient portals, Data 360 (formerly Data Cloud).

## Data model

Person Accounts for patients and members, care plans and care programs with enrollees, clinical objects aligned to FHIR R4 (conditions, observations, medications, procedures), providers and payers. Verify the clinical data model version in the org.

## Regulation and compliance

HIPAA in the US (a signed BAA with Salesforce and only covered services for PHI), GDPR special-category health data in the EU, consent management, and for life sciences GxP and 21 CFR Part 11 for validated processes.

## Typical integrations

EHR/EMR systems through HL7 v2 or FHIR APIs (often via MuleSoft or an integration engine), payer claims systems, pharmacy and lab systems, identity proofing.

## Watch for

Minimum-necessary access to PHI (sharing, field-level security, Shield Platform Encryption, Event Monitoring), patient consent and its enforcement, not copying full clinical records when a summary or virtualisation is enough.

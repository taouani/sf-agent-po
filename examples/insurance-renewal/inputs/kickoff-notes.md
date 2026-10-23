# Renewal portal kickoff, 14 October 2026

Attendees: Head of Personal Lines (business owner), product manager, renewals team lead, solution architect.

## Problem
- 60% of home and motor renewals are handled by phone. Agents spend most of November and December on renewal calls.
- Policyholders cannot see their renewal quote before it arrives by post.

## Goals
- Policyholders renew online in the customer portal, including paying the first instalment.
- Renewals agents see which policies are due in the next 30 days and which customers have not acted.
- Reduce renewal calls by 40% within 12 months.

## Discussion
- Renewal quotes are produced by the policy administration system (PAS) 45 days before expiry. Salesforce does not price.
- Policies already sync nightly from the PAS into Policy__c.
- Some policyholders have more than one policy; they should see all of them.
- Brokers handle about 15% of policies. Broker-managed policies must not be renewable in the portal; the policyholder should be told to contact their broker.
- The renewals team lead wants a task created for the agent when a policyholder abandons the online renewal.
- Payments go through the existing payment provider used by the website.

## Actions
- Product manager to confirm whether mid-term changes (address, cover level) are in scope for phase 1.
- Architect to propose how the portal gets the renewal quote from the PAS.

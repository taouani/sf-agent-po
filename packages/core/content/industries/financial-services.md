---
id: financial-services
name: Financial services (banking, wealth, lending)
aliases: [banking, wealth-management, fsi]
---

## Salesforce products to consider

Financial Services Cloud, Experience Cloud for client portals, OmniStudio for guided processes, Data 360 (formerly Data Cloud) for a unified client profile, Marketing Cloud, Agentforce for service.

## Data model

Person Accounts, households and relationship groups, financial accounts and holdings, financial goals, account-contact relationships, action plans for onboarding. Check whether the org uses the managed-package (FinServ namespace) or the newer core standard objects.

## Regulation and compliance

KYC and AML, GDPR or CCPA, PCI DSS for card data, SOX, and local regulators (for example FINRA and SEC, FCA, MiFID II, DORA in the EU). Expect audit, data retention and segregation-of-duties requirements.

## Typical integrations

Core banking, loan origination, payments, KYC/identity providers, document management and e-signature, market data. Usually through middleware with strict security reviews.

## Watch for

Data visibility between advisors, branches and business lines (Compliant Data Sharing), large volumes of transactions (keep them off-platform or summarised), encryption of personal financial data, and record ownership skew on household accounts.

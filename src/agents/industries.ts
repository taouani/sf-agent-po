/**
 * Industry templates: what an SA or PO should keep in mind in each industry.
 * They point the agents at the right Salesforce industry products, data model
 * areas, regulations and integration landscape. Product and object names
 * change between releases and licences, so the agents are told to confirm them
 * against the org before relying on them.
 */
export interface IndustryTemplate {
  id: string;
  name: string;
  products: string;
  dataModel: string;
  regulations: string;
  integrations: string;
  watchFor: string;
}

export const INDUSTRIES: IndustryTemplate[] = [
  {
    id: "financial-services",
    name: "Financial services (banking, wealth, lending)",
    products: "Financial Services Cloud, Experience Cloud for client portals, OmniStudio for guided processes, Data Cloud for a unified client profile, Marketing Cloud, Agentforce for service.",
    dataModel:
      "Person Accounts, households and relationship groups, financial accounts and holdings, financial goals, account-contact relationships, action plans for onboarding. Check whether the org uses the managed-package (FinServ namespace) or the newer core standard objects.",
    regulations: "KYC and AML, GDPR or CCPA, PCI DSS for card data, SOX, and local regulators (for example FINRA and SEC, FCA, MiFID II, DORA in the EU). Expect audit, data retention and segregation-of-duties requirements.",
    integrations: "Core banking, loan origination, payments, KYC/identity providers, document management and e-signature, market data. Usually through middleware with strict security reviews.",
    watchFor:
      "Data visibility between advisors, branches and business lines (Compliant Data Sharing), large volumes of transactions (keep them off-platform or summarised), encryption of personal financial data, and record ownership skew on household accounts.",
  },
  {
    id: "insurance",
    name: "Insurance (P&C, life, health insurers, brokers)",
    products: "Financial Services Cloud with its insurance data model, OmniStudio for quoting and claims intake, Experience Cloud for policyholder and agent/broker portals, Data Cloud.",
    dataModel:
      "Insurance policies with participants, coverages and assets, claims, producers (agents and brokers), quotes. Confirm the insurance objects licensed in the org; policy administration often stays in an external system of record.",
    regulations: "GDPR or local privacy law, Solvency II (EU) or state insurance regulation (US, NAIC), IFRS 17 reporting (finance systems, not Salesforce), fair-treatment and complaints-handling rules, record retention.",
    integrations: "Policy administration and billing systems (for example Guidewire, Duck Creek, Sapiens), rating engines, claims systems, document generation, payment providers.",
    watchFor:
      "Which system owns the policy and the premium, renewal and endorsement processes, broker and agent access in the portal, consent for marketing, and claims data sensitivity (health data in life and health insurance).",
  },
  {
    id: "health",
    name: "Healthcare and life sciences",
    products: "Health Cloud (patient and member management, care management, utilization management), Life Sciences Cloud for pharma and medtech, Experience Cloud for patient portals, Data Cloud.",
    dataModel:
      "Person Accounts for patients and members, care plans and care programs with enrollees, clinical objects aligned to FHIR R4 (conditions, observations, medications, procedures), providers and payers. Verify the clinical data model version in the org.",
    regulations: "HIPAA in the US (a signed BAA with Salesforce and only covered services for PHI), GDPR special-category health data in the EU, consent management, and for life sciences GxP and 21 CFR Part 11 for validated processes.",
    integrations: "EHR/EMR systems through HL7 v2 or FHIR APIs (often via MuleSoft or an integration engine), payer claims systems, pharmacy and lab systems, identity proofing.",
    watchFor:
      "Minimum-necessary access to PHI (sharing, field-level security, Shield Platform Encryption, Event Monitoring), patient consent and its enforcement, not copying full clinical records when a summary or virtualisation is enough.",
  },
  {
    id: "manufacturing",
    name: "Manufacturing",
    products: "Manufacturing Cloud (sales agreements, account-based forecasting, rebates, warranty), Sales and Service Cloud, Field Service, Experience Cloud for partner and distributor portals, Data Cloud for connected products.",
    dataModel: "Sales agreements and their schedules, account forecasts, rebate programs, assets and warranty terms, partner accounts. ERP remains the system of record for products, prices and orders.",
    regulations: "Export control and sanctions screening, product safety and recall traceability, GDPR for contacts, industry quality standards (for example ISO 9001) for service processes.",
    integrations: "ERP (SAP, Oracle) for products, pricing, orders and invoices, PLM, IoT platforms for connected assets, distributor and channel data feeds.",
    watchFor:
      "Product and price master data ownership, forecast volumes and recalculation jobs, partner data visibility, and large asset and service history volumes.",
  },
  {
    id: "automotive",
    name: "Automotive",
    products: "Automotive Cloud, Sales and Service Cloud, Experience Cloud for dealer portals, Data Cloud for vehicle and driver data, Marketing Cloud.",
    dataModel: "Vehicles and vehicle definitions, ownership and driver relationships, dealers as partner accounts, leads and test drives, service and warranty history.",
    regulations: "Privacy for connected-vehicle and driver data (GDPR, CCPA), consumer finance rules for captive finance, recall obligations.",
    integrations: "Dealer management systems, OEM order and allocation systems, telematics, captive finance platforms.",
    watchFor: "Dealer versus OEM data ownership and sharing, volumes of vehicle telemetry (keep it in Data Cloud or off-platform), recall campaign scale.",
  },
  {
    id: "energy-utilities",
    name: "Energy and utilities",
    products: "Energy and Utilities Cloud, Service Cloud, Field Service, Experience Cloud for customer self-service, OmniStudio.",
    dataModel: "Premises, service points and meters, service accounts, programmes and enrolments (for example energy efficiency), field work orders.",
    regulations: "Regulator rules on customer protection and vulnerable customers, critical infrastructure security, privacy of consumption data.",
    integrations: "Customer information and billing systems (for example SAP IS-U), meter data management, outage management, GIS.",
    watchFor: "Billing and meter data stay in the CIS and MDM; design for read-through or summaries. Very large customer bases mean data volume and query selectivity matter.",
  },
  {
    id: "public-sector",
    name: "Public sector",
    products: "Public Sector Solutions (licensing and permitting, inspections, benefits and case management, grants), Experience Cloud for citizen portals, OmniStudio, Service Cloud.",
    dataModel: "Individuals and business accounts, applications, licences and permits, inspections, cases, benefits and grants.",
    regulations:
      "Government security frameworks (for example FedRAMP with Government Cloud Plus in the US, or national equivalents), accessibility (WCAG 2.1 AA, Section 508), data residency, records management and freedom-of-information obligations.",
    integrations: "Identity providers (for example Login.gov or national digital identity), payment gateways, legacy case and finance systems, GIS.",
    watchFor: "Hosting and residency constraints may limit which features and AI services can be used; confirm before designing. Citizen portals need accessibility and high-volume guest or authenticated access patterns.",
  },
  {
    id: "nonprofit",
    name: "Nonprofit",
    products: "Nonprofit Cloud (fundraising, programs and case management, grantmaking, volunteer management) or the older Nonprofit Success Pack, Experience Cloud, Marketing Cloud, Data Cloud.",
    dataModel:
      "Donors as Person Accounts and households, gift commitments and gift transactions, campaigns, programs, enrolments and benefits, volunteers. NPSP uses a different, package-based model: confirm which one the org runs before designing.",
    regulations: "GDPR and consent, fundraising regulation, tax relief rules (for example Gift Aid in the UK), PCI DSS for online donations.",
    integrations: "Payment processors and donation platforms, finance systems, email marketing, wealth screening.",
    watchFor: "Migration between NPSP and Nonprofit Cloud is a redesign, not an upgrade. Small admin teams favour configuration over code.",
  },
  {
    id: "education",
    name: "Education",
    products: "Education Cloud (recruitment and admissions, student success, advancement) or the older Education Data Architecture, Experience Cloud for student portals, Marketing Cloud.",
    dataModel: "Learners and contacts, academic programs and terms, applications, enrolments, advising and success plans, alumni and advancement.",
    regulations: "FERPA in the US, GDPR, safeguarding for minors, accessibility.",
    integrations: "Student information systems (for example Banner, Ellucian, SITS), learning management systems, identity providers.",
    watchFor: "The SIS is usually the system of record for academic data; agree data ownership. Confirm whether the org is on Education Cloud or EDA.",
  },
  {
    id: "retail-consumer-goods",
    name: "Retail and consumer goods",
    products: "Commerce Cloud (B2C and B2B), Consumer Goods Cloud for retail execution, Loyalty Management, Service Cloud, Marketing Cloud, Data Cloud for a unified customer profile, Order Management.",
    dataModel: "Person Accounts or contacts for shoppers, orders and order items, loyalty programs and members, store visits and audits for field reps, products and price books.",
    regulations: "PCI DSS for payments, GDPR and CCPA, consent and preference management, consumer protection.",
    integrations: "ERP and order management, POS, e-commerce platforms, payment providers, logistics and returns, product information management.",
    watchFor: "Peak-season volumes, identity resolution across channels, and keeping transactional history in Data Cloud or the data platform rather than CRM records.",
  },
  {
    id: "communications",
    name: "Communications and media",
    products: "Communications Cloud (Enterprise Product Catalog, Industries CPQ, Industries Order Management), Service Cloud, Experience Cloud, Media Cloud for advertising sales.",
    dataModel: "Billing and service accounts, product catalog with offers and bundles, quotes, orders and assets for installed services.",
    regulations: "Telecom regulator rules, privacy of usage data, lawful-intercept and data-retention obligations handled in network systems.",
    integrations: "BSS/OSS stacks, billing, provisioning and network inventory, often through TM Forum Open APIs.",
    watchFor: "Catalog complexity and order decomposition, very large asset volumes, and clear ownership between CRM and BSS.",
  },
];

export const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id);

export function industryGuidance(id: string | undefined): string {
  if (!id) return "";
  const t = INDUSTRIES.find((i) => i.id === id);
  if (!t) throw new Error(`Unknown industry "${id}". Use one of: ${INDUSTRY_IDS.join(", ")}.`);
  return `## Industry: ${t.name}

- **Salesforce products to consider:** ${t.products}
- **Data model:** ${t.dataModel}
- **Regulation and compliance:** ${t.regulations}
- **Typical integrations:** ${t.integrations}
- **Watch for:** ${t.watchFor}

Product names and object names differ between releases and licences. Before relying on an industry object or feature, confirm it is licensed and present in the metadata or org documents; if it is not, say so and treat it as an option to evaluate.`;
}

/** The guidance followed by a blank line, or nothing when no industry is chosen. */
export function industryBlock(industry: string | undefined): string {
  const guidance = industryGuidance(industry);
  return guidance ? `${guidance}\n\n` : "";
}

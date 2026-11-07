---
id: luxury
name: Luxury (fashion, leather goods, jewellery, watches, beauty)
aliases: [luxury-goods, luxury-retail, fashion, jewellery, jewelry, watches, maison]
---

## Salesforce products to consider

Sales Cloud or Service Cloud as the client relationship core, with a clienteling app for client advisors on the Salesforce mobile app (Salesforce's own retail clienteling offer or a partner app; confirm which is licensed), Data 360 (formerly Data Cloud) for one client profile across boutiques, e-commerce and countries, Marketing Cloud for personalised outreach, Salesforce Scheduler for boutique appointments, Service Cloud with Digital Engagement for messaging and after-sales, Commerce Cloud and Order Management for online and omnichannel orders, and Agentforce for client service and advisor assistance. Points-based Loyalty Management rarely fits a maison; recognition usually rests on client tiers and service.

## Data model

Clients as Person Accounts, with relationships to family members, personal assistants and gift recipients; the assigned client advisor and home boutique (record owner or account team); client tier or segment (for example VIC) and lifetime and yearly spend, usually computed from transaction history held in Data 360 or the data platform rather than in CRM records; preferences (sizes, styles, materials, colours), important dates and wish lists; appointments; boutiques as locations or accounts; registered products as assets with serial numbers and certificates of authenticity; after-sales services and repairs (estimate, client approval, workshop status, return) as cases or work orders; outreach tasks and invitations to launches, private sales and events.

## Regulation and compliance

GDPR in the EU, CCPA and CPRA in California, PIPL in China (separate consent for each purpose and for cross-border transfer, plus a security assessment, standard contract or certification before personal data leaves China), and APPI in Japan and PIPA in South Korea for the large Asian client base. Anti-money-laundering rules for high-value goods: in the EU, dealers who accept cash of 10,000 EUR or more must run customer due diligence, and from July 2027 the EU AML Regulation caps cash payments at 10,000 EUR; in the US, cash over 10,000 USD needs IRS Form 8300. CITES permits for exotic skins and other protected materials, which affect cross-border sales, shipping and repairs. Tax-free shopping for travellers (VAT refunds through providers such as Global Blue or Planet), consent per channel and per country for marketing, and the EU Ecodesign regulation's coming digital product passports.

## Typical integrations

Point of sale in the boutiques (for example Cegid or Oracle Retail Xstore), ERP (often SAP) for products, stock, prices and invoices, order management and e-commerce, a product information system for product data and images, after-sales workshop and repair systems, messaging apps that advisors use with clients (WhatsApp, LINE and Apple Messages for Business through Digital Engagement; WeChat and KakaoTalk usually through partners), appointment booking on the website, tax-free and payment providers, and product authenticity or traceability platforms (for example the Aura Blockchain Consortium).

## Watch for

Who owns a client and who sees them: clients travel and buy in several boutiques and countries, so agree how advisors share one global profile while keeping their own client book, and how ownership moves when an advisor leaves. Duplicate clients across countries and scripts (Latin, Chinese, Japanese, Korean, Arabic names) need identity resolution. Advisors write free-text notes that can hold sensitive data (health, religion, family events); limit and classify these fields, and restrict access to high-profile clients. Conversations on personal messaging apps outside the CRM are a compliance risk and are lost when an advisor leaves. Plan for boutiques with poor connectivity (offline mobile), several languages and currencies, country price lists, and peaks around launches and private sales. Keep transaction history in Data 360 or the data platform and bring summaries into CRM.

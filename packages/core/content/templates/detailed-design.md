# <Feature or epic>: detailed design

## 1. Scope
The stories or epics covered, with their Jira keys or backlog ids, and the high-level design this refines.

## 2. Data model changes
For each new relationship: lookup or master-detail, and why (sharing inheritance, cascade delete, roll-up summaries). A table per object: field API name, label, type and length, required, default, picklist values (or the global value set), external ID, unique, help text, data classification (sensitivity, compliance category), field-level security by permission set. Include record types, validation rules and page layout or Dynamic Forms changes.

## 3. Automation
For each flow: type, trigger object and event, before-save or after-save, entry criteria, run context (user or system), main steps, fault handling. For each Apex class or trigger: responsibility, entry point, sharing (with sharing, and user-mode database operations for CRUD and field-level security), synchronous or asynchronous (Queueable, Batch, Scheduled, Platform Event subscriber), bulk behaviour, test class. Note the order of execution with existing automation on the same objects.

## 4. User interface
Lightning pages, components (LWC with their inputs and events), quick actions, list views, Experience Cloud pages.

## 5. Integrations
Per interface: endpoint and authentication (Named and External Credentials), the integration user (a dedicated API-only user with least-privilege permission sets), payload mapping, error and retry handling, logging, limits.

## 6. Security
Permission sets and permission set groups to create or change, internal and external org-wide defaults, sharing rules, field-level security, custom permissions, and guest-user access for public Experience Cloud pages.

## 7. Test approach
Apex tests and coverage, Flow tests, acceptance tests mapped to each story's acceptance criteria, test data.

## 8. Deployment
Metadata components to deploy (in package.xml or source format terms), pre and post-deployment steps, data loads, rollback.

## 9. Open questions and risks

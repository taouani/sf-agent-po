// Reports, dashboards and custom report types: the fields, objects and reports they use, so
// that the impact of a field change reaches the reports and dashboards built on it. Filter
// values are never kept, since they can name people (a filter on Owner = "Jane Doe"): only
// the field a filter is on. Running users (a username) are left out for the same reason.

import type { ParsedComponent, Ref } from "./model.js";
import { list, obj, str } from "./xml.js";

const joinText = (...parts: (string | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join("\n");

const NAME = /^[A-Za-z]\w*$/;
const CUSTOM_FIELD = /^[A-Za-z]\w*__c$/i;

/**
 * What a report column names, as a reference to the field it reads:
 * - `Policy__c$Premium__c` (a custom report type): the field of the report type's object, or
 *   with a path (`Policy__c.Claims__r$Amount__c`), a custom field of a related object, named
 *   alone and linked when one object has it;
 * - `Policy__c.Premium__c` or `FK_$Account.Foo__c` (a standard report type, or the lookup's
 *   parent): the field of that object;
 * - `ACCOUNT.NAME`, `CUST_NAME`, `AMOUNT` (standard report columns): Salesforce's own names
 *   for standard fields, which the index cannot tell apart; left out.
 */
export function reportColumnRef(column: string, kind: Ref["kind"] = "reads"): Ref | undefined {
  const dollar = column.lastIndexOf("$");
  if (dollar > 0 && !column.startsWith("FK_$")) {
    const path = column.slice(0, dollar).split(".");
    const field = column.slice(dollar + 1);
    if (!NAME.test(field) || !path.every((p) => NAME.test(p))) return undefined;
    if (path.length === 1) return { kind, object: path[0]!, path: field };
    return CUSTOM_FIELD.test(field) ? { kind, field } : undefined;
  }
  const m = /^(?:FK_\$)?([A-Za-z]\w*)\.([A-Za-z]\w*)$/.exec(column);
  // Standard columns are written in capitals (ACCOUNT.NAME); fields keep their API name's case.
  if (!m || m[1] === m[1]!.toUpperCase() || !/[a-z]/.test(m[2]!)) return undefined;
  return { kind, object: m[1]!, path: m[2]! };
}

/**
 * The report type a report is built on: a custom report type by name, or the objects of a
 * standard type on custom objects (`CustomEntity$Policy__c`, `CustomEntityCustomEntity$Policy__c$Claim__c`).
 * Standard types (AccountList, Opportunity) are Salesforce's and are not linked.
 */
function reportTypeRefs(reportType: string): Ref[] {
  const entity = /^(?:CustomEntity)+\$(.+)$/.exec(reportType);
  if (entity) return entity[1]!.split("$").filter((o) => NAME.test(o)).map((object) => ({ kind: "reads" as const, object }));
  // A custom report type is named with __c in reports, without it in its own file.
  const custom = /^([A-Za-z]\w*)__c$/.exec(reportType);
  return custom ? [{ kind: "reads", type: "ReportType", name: custom[1]! }] : [];
}

/**
 * A report ("Folder/Name"): it reads its report type and the fields it shows, groups by,
 * filters on (not the values), buckets and charts. Its label and description are people's
 * words, kept as text and masked on the way out.
 */
export function readReport(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const column = (c: unknown) => {
    const text = str(c)?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    const ref = reportColumnRef(text);
    if (ref) refs.push(ref);
  };
  const reportType = str(root.reportType);
  if (reportType) refs.push(...reportTypeRefs(reportType));
  for (const c of list(root.columns)) column(obj(c).field);
  for (const g of [...list(root.groupingsDown), ...list(root.groupingsAcross)]) column(obj(g).field);
  const filters = obj(root.filter);
  const filterFields: string[] = [];
  for (const item of list(filters.criteriaItems).map(obj)) {
    const c = str(item.column);
    if (c) filterFields.push(c);
    column(c);
  }
  for (const cross of list(filters.crossFilters).map(obj)) {
    column(cross.primaryTableColumn);
    for (const item of list(cross.criteriaItems).map(obj)) column(item.column);
  }
  column(obj(root.timeFrameFilter).dateColumn);
  for (const b of list(root.buckets).map(obj)) column(b.sourceColumnName);
  const chart = obj(root.chart);
  column(chart.groupingColumn);
  column(chart.secondaryGroupingColumn);
  for (const s of list(chart.chartSummaries).map(obj)) column(s.column);
  const attrs: Record<string, unknown> = {};
  if (reportType) attrs.reportType = reportType;
  const format = str(root.format);
  if (format) attrs.format = format;
  if (filterFields.length) attrs.filterFields = [...new Set(filterFields)].sort();
  return { type: "Report", name, label: str(root.name), file, attrs, refs, text: joinText(str(root.description)) };
}

/**
 * A dashboard ("Folder/Name"): it reads the reports its components show, in a classic
 * dashboard's sections or a Lightning one's grid. Filter values and the running user are
 * left out.
 */
export function readDashboard(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const reports = new Set<string>();
  const component = (c: Record<string, unknown>) => {
    const report = str(c.report);
    if (report) reports.add(report);
  };
  for (const section of ["leftSection", "middleSection", "rightSection"]) {
    for (const c of list(obj(root[section]).components).map(obj)) component(c);
  }
  for (const g of list(obj(root.dashboardGridLayout).dashboardGridComponents).map(obj)) component(obj(g.dashboardComponent));
  for (const r of [...reports].sort()) refs.push({ kind: "reads", type: "Report", name: r });
  const filterFields: string[] = [];
  for (const f of list(root.dashboardFilters).map(obj)) {
    for (const c of list(f.dashboardFilterColumns).map(obj)) {
      const col = str(c.column);
      if (col) filterFields.push(col);
    }
  }
  const attrs: Record<string, unknown> = { reports: reports.size };
  const type = str(root.dashboardType);
  if (type) attrs.dashboardType = type;
  if (filterFields.length) attrs.filterFields = [...new Set(filterFields)].sort();
  return { type: "Dashboard", name, label: str(root.title), file, attrs, refs, text: joinText(str(root.description)) };
}

/**
 * A custom report type: it reads its base object, the objects it joins (by relationship,
 * named in attrs), and the fields of each section's columns.
 */
export function readReportType(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const base = str(root.baseObject);
  if (base && NAME.test(base)) refs.push({ kind: "reads", object: base });
  const joins: string[] = [];
  for (let j = obj(root.join), depth = 0; Object.keys(j).length && depth < 10; j = obj(j.join), depth++) {
    const relationship = str(j.relationship);
    if (relationship) joins.push(`${relationship}${str(j.outerJoin) === "true" ? " (with or without)" : ""}`);
  }
  let fields = 0;
  for (const section of list(root.sections).map(obj)) {
    for (const c of list(section.columns).map(obj)) {
      const field = str(c.field);
      const table = str(c.table);
      if (!field || !table) continue;
      fields++;
      // The base object's own fields name it; a joined object's, its relationship path.
      if (!table.includes(".") && NAME.test(table) && NAME.test(field)) refs.push({ kind: "reads", object: table, path: field });
      else if (CUSTOM_FIELD.test(field)) refs.push({ kind: "reads", field });
    }
  }
  const attrs: Record<string, unknown> = { fields };
  if (base) attrs.baseObject = base;
  if (joins.length) attrs.joins = joins;
  const category = str(root.category);
  if (category) attrs.category = category;
  return { type: "ReportType", name, label: str(root.label), file, attrs, refs, text: joinText(str(root.description)) };
}

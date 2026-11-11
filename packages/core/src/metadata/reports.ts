// Reports, dashboards and custom report types: the fields, objects and reports they use, so
// that the impact of a field change reaches the reports and dashboards built on it. Filter
// values are never kept, since they can name people (a filter on Owner = "Jane Doe"): only
// the field a filter is on. Running users (a username) are left out for the same reason.

import type { ParsedComponent, Ref } from "./model.js";
import { list, obj, str } from "./xml.js";

const joinText = (...parts: (string | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join("\n");

const NAME = /^[A-Za-z]\w*$/;
const CUSTOM_FIELD = /^[A-Za-z]\w*__c$/i;
/** Historical trending objects and fields, which the Metadata API never returns. */
const TRENDING = /__h(?:d|st)$/i;
/** Standard lookups a report names by relationship ("Account$Owner"): the field is <name>Id. */
const STANDARD_LOOKUPS = new Set(["Owner", "CreatedBy", "LastModifiedBy", "RecordType", "Account", "Contact", "Parent"]);

/** A field path of a report column as the index's path resolver reads it: lookups by relationship ("Holder__r.Segment__c"). */
function fieldPath(segments: readonly string[]): string {
  return segments.map((s, i) => (i < segments.length - 1 ? s.replace(/__c$/i, "__r") : STANDARD_LOOKUPS.has(s) && segments.length === 1 ? `${s}Id` : s)).join(".");
}

/**
 * What a report column names, as a reference to the field it reads:
 * - `Policy__c$Premium__c` (a custom report type): the field of the report type's object, or
 *   through its lookups (`Policy__c$Holder__c.Segment__c`, `Opportunity$Account.Industry`);
 *   `Account$Owner` is the lookup field (OwnerId);
 * - `Policy__c.Claims__r$Amount__c` (a related object of the report type): a custom field
 *   named alone, linked when one object has it;
 * - `Policy__c.Premium__c` or `FK_$Account.Foo__c` (a standard report type, or the lookup's
 *   parent): the field of that object;
 * - `ACCOUNT.NAME`, `CUST_NAME`, `AMOUNT` (standard report columns): Salesforce's own names
 *   for standard fields, which the index cannot tell apart, and historical trending columns:
 *   left out.
 */
export function reportColumnRef(column: string, kind: Ref["kind"] = "reads"): Ref | undefined {
  const dollar = column.indexOf("$");
  if (dollar > 0 && !column.startsWith("FK_$")) {
    const path = column.slice(0, dollar).split(".");
    const field = column.slice(dollar + 1).split(".");
    if (![...path, ...field].every((p) => NAME.test(p)) || [...path, ...field].some((p) => TRENDING.test(p))) return undefined;
    if (path.length === 1) return { kind, object: path[0]!, path: fieldPath(field) };
    return field.length === 1 && CUSTOM_FIELD.test(field[0]!) ? { kind, field: field[0]! } : undefined;
  }
  const m = /^(?:FK_\$)?([A-Za-z]\w*)\.([A-Za-z]\w*)$/.exec(column);
  // Standard columns are written in capitals (ACCOUNT.NAME); fields keep their API name's case.
  if (!m || m[1] === m[1]!.toUpperCase() || !/[a-z]/.test(m[2]!) || TRENDING.test(m[1]!) || TRENDING.test(m[2]!)) return undefined;
  return { kind, object: m[1]!, path: m[2]! };
}

/** The columns a summary or row-level formula uses ("Policy__c.Premium__c:SUM / RowCount"). */
function formulaColumns(formula: string): string[] {
  return [...formula.matchAll(/(?:FK_\$)?[A-Za-z]\w*(?:[.$][A-Za-z]\w*)+/g)].map((m) => m[0]);
}

/**
 * The report type a report is built on: a custom report type by name, or the objects of a
 * standard type on custom objects (`CustomEntity$Policy__c`, `CustomEntityCustomEntity$Policy__c$Claim__c`,
 * `CustomEntity$Policy__c@Policy__c.Holder__c` with its lookup). Standard types
 * (AccountList, Opportunity) are Salesforce's and are not linked.
 */
function reportTypeRefs(reportType: string): Ref[] {
  const entity = /^(?:CustomEntity)+\$(.+)$/.exec(reportType);
  if (entity) {
    const [objects, lookup] = entity[1]!.split("@");
    const refs: Ref[] = objects!.split("$").filter((o) => NAME.test(o)).map((object) => ({ kind: "reads" as const, object }));
    const ref = lookup ? reportColumnRef(lookup) : undefined;
    return ref ? [...refs, ref] : refs;
  }
  // A custom report type is named with __c in reports, without it in its own file.
  const custom = /^([A-Za-z]\w*)__c$/.exec(reportType);
  return custom ? [{ kind: "reads", type: "ReportType", name: custom[1]! }] : [];
}

/**
 * A report ("Folder/Name"): it reads its report type and the fields it shows, groups by,
 * filters on (not the values), buckets, charts and uses in formulas, in each block of a joined
 * report too. Its label and description are people's words, kept as text and masked on the
 * way out.
 */
export function readReport(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const add = (ref: Ref | undefined) => {
    const key = ref && JSON.stringify(ref);
    if (ref && !seen.has(key!)) {
      seen.add(key!);
      refs.push(ref);
    }
  };
  const column = (c: unknown) => {
    const text = str(c)?.trim();
    if (text) add(reportColumnRef(text));
  };
  const filterFields = new Set<string>();
  const reportTypes = new Set<string>();
  // A joined report keeps each block's report type, columns and filters in its <block>.
  for (const part of [root, ...list(root.block).map(obj)]) {
    const reportType = str(part.reportType);
    if (reportType) {
      reportTypes.add(reportType);
      for (const r of reportTypeRefs(reportType)) add(r);
    }
    for (const c of list(part.columns)) column(obj(c).field);
    for (const g of [...list(part.groupingsDown), ...list(part.groupingsAcross)]) column(obj(g).field);
    const filters = obj(part.filter);
    for (const item of list(filters.criteriaItems).map(obj)) {
      const c = str(item.column);
      if (c) filterFields.add(c);
      column(c);
    }
    // Cross filters ("with" or "without" related records) name their related object's fields alone.
    for (const cross of [...list(filters.crossFilters), ...list(part.crossFilters)].map(obj)) {
      column(cross.primaryTableColumn);
      const related = str(cross.relatedTable);
      const join = str(cross.relatedTableJoinColumn);
      if (related && NAME.test(related) && join && NAME.test(join)) add({ kind: "reads", object: related, path: join });
      for (const item of list(cross.criteriaItems).map(obj)) {
        const c = str(item.column);
        if (!c) continue;
        if (related && NAME.test(related) && NAME.test(c)) add({ kind: "reads", object: related, path: c });
        else column(c);
      }
    }
    column(obj(part.timeFrameFilter).dateColumn);
    for (const b of list(part.buckets).map(obj)) column(b.sourceColumnName);
    for (const f of [...list(part.aggregates), ...list(part.customDetailFormulas)].map(obj)) {
      for (const c of formulaColumns(str(f.calculatedFormula) ?? "")) column(c.replace(/:\w+$/, ""));
    }
    const chart = obj(part.chart);
    column(chart.groupingColumn);
    column(chart.secondaryGroupingColumn);
    for (const s of list(chart.chartSummaries).map(obj)) column(s.column);
  }
  const attrs: Record<string, unknown> = {};
  if (reportTypes.size) attrs.reportType = [...reportTypes].join(", ");
  const format = str(root.format);
  if (format) attrs.format = format;
  if (filterFields.size) attrs.filterFields = [...filterFields].sort();
  return { type: "Report", name, label: str(root.name), file, attrs, refs, text: joinText(str(root.description)) };
}

/**
 * A dashboard ("Folder/Name"): it reads the reports its components show, in a classic
 * dashboard's sections or a Lightning one's grid, and the fields its filters are on. Filter
 * values and the running user are left out.
 */
export function readDashboard(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const reports = new Set<string>();
  const filterFields = new Set<string>();
  const component = (c: Record<string, unknown>) => {
    const report = str(c.report);
    if (report) reports.add(report);
    // Each component says which column of its report each dashboard filter applies to.
    for (const f of list(c.dashboardFilterColumns).map(obj)) {
      const col = str(f.column);
      if (col) filterFields.add(col);
    }
  };
  for (const section of ["leftSection", "middleSection", "rightSection"]) {
    for (const c of list(obj(root[section]).components).map(obj)) component(c);
  }
  for (const g of list(obj(root.dashboardGridLayout).dashboardGridComponents).map(obj)) component(obj(g.dashboardComponent));
  for (const r of [...reports].sort()) refs.push({ kind: "reads", type: "Report", name: r });
  for (const col of [...filterFields].sort()) {
    const ref = reportColumnRef(col);
    if (ref) refs.push(ref);
  }
  const attrs: Record<string, unknown> = { reportCount: reports.size };
  const type = str(root.dashboardType);
  if (type) attrs.dashboardType = type;
  if (filterFields.size) attrs.filterFields = [...filterFields].sort();
  return { type: "Dashboard", name, label: str(root.title), file, attrs, refs, text: joinText(str(root.description)) };
}

/**
 * A custom report type: it reads its base object, the objects it joins (by relationship,
 * named in attrs), and the fields of each section's columns. A joined object's field is
 * named alone and linked when one object has it: the index cannot follow a child
 * relationship to its object.
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
      const segments = field.split(".");
      if (!segments.every((s) => NAME.test(s))) continue;
      // The base object's own fields (through its lookups too) name it; a joined object's,
      // its relationship path.
      if (!table.includes(".") && NAME.test(table)) refs.push({ kind: "reads", object: table, path: fieldPath(segments) });
      else if (segments.length === 1 && CUSTOM_FIELD.test(field)) refs.push({ kind: "reads", field });
    }
  }
  const attrs: Record<string, unknown> = { fields };
  if (base) attrs.baseObject = base;
  if (joins.length) attrs.joins = joins;
  const category = str(root.category);
  if (category) attrs.category = category;
  return { type: "ReportType", name, label: str(root.label), file, attrs, refs, text: joinText(str(root.description)) };
}

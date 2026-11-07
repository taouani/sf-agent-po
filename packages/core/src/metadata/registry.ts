// Which metadata type a file holds, from Salesforce's metadata type registry (copied from
// source-deploy-retrieve, decision ST3a). Used for every type the index does not read in
// detail, so that the index knows each component exists and where its file is.

import { REGISTRY_TYPES } from "./registry-data.js";

export interface RegistryType {
  /** The Metadata API name: "ApexClass", "Flow". */
  name: string;
  /** The file suffix: "cls" for Foo.cls(-meta.xml). Bundles have none. */
  suffix?: string;
  /** The folder the type lives in: "classes", "flows". */
  directoryName: string;
  /** Components sit in named folders (reports, dashboards, documents, email templates). */
  inFolder?: boolean;
  /** The folder name is required (bundles, static resources). */
  strict?: boolean;
  /** How files make up a component: "bundle", "matchingContentFile", "mixedContent", "decomposed"... */
  adapter?: string;
  metaFileSuffix?: string;
  /** Child types written as their own files in source format (fields of an object...). */
  children?: Record<string, { name: string; suffix: string; directoryName: string }>;
}

export interface RegistryMatch {
  /** The Metadata API type name. */
  type: string;
  /** Full name: "Foo", "Folder/Report", "Account.All_Accounts" for a child. */
  name: string;
  /** The parent component's full name, for a child type. */
  parent?: string;
  /** The parent's type, for a child type. */
  parentType?: string;
}

interface Lookups {
  bySuffix: Map<string, RegistryType[]>;
  childBySuffix: Map<string, { parent: RegistryType; child: { name: string; suffix: string; directoryName: string } }[]>;
  bundlesByDir: Map<string, RegistryType>;
}

let lookups: Lookups | undefined;
function tables(): Lookups {
  if (lookups) return lookups;
  const bySuffix = new Map<string, RegistryType[]>();
  const childBySuffix: Lookups["childBySuffix"] = new Map();
  const bundlesByDir = new Map<string, RegistryType>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const t of Object.values(REGISTRY_TYPES)) {
    if (t.suffix) push(bySuffix, t.suffix.toLowerCase(), t);
    if (t.adapter === "bundle") bundlesByDir.set(t.directoryName, t);
    for (const c of Object.values(t.children ?? {})) push(childBySuffix, c.suffix.toLowerCase(), { parent: t, child: c });
  }
  return (lookups = { bySuffix, childBySuffix, bundlesByDir });
}

export const registryTypeCount = () => Object.keys(REGISTRY_TYPES).length;

/**
 * The component a file belongs to, or undefined for a file that is not metadata (README,
 * package.json, an LWC test). Works on both formats: "classes/Foo.cls-meta.xml" (source)
 * and "classes/Foo.cls" (metadata format) both give ApexClass Foo. `rel` is relative to the
 * project, with forward slashes.
 */
export function classifyFile(rel: string): RegistryMatch | undefined {
  const { bySuffix, childBySuffix, bundlesByDir } = tables();
  const parts = rel.split("/");
  const base = parts.at(-1)!;
  const dirs = parts.slice(0, -1);

  // A bundle: lwc/myCmp/anything, aura/myCmp/anything.
  for (let i = dirs.length - 2; i >= 0; i--) {
    const bundle = bundlesByDir.get(dirs[i]!);
    if (bundle) {
      const name = dirs[i + 1]!;
      if (name.startsWith(".") || name.startsWith("__")) return undefined;
      return { type: bundle.name, name };
    }
  }

  const meta = base.endsWith("-meta.xml");
  const stem = meta ? base.slice(0, -"-meta.xml".length) : base;
  const dot = stem.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const name = stem.slice(0, dot);
  const suffix = stem.slice(dot + 1).toLowerCase();
  const parent = dirs.at(-1);

  // A child written as its own file: objects/Account/listViews/All.listView-meta.xml.
  for (const { parent: owner, child } of childBySuffix.get(suffix) ?? []) {
    if (meta && parent === child.directoryName && dirs.at(-3) === owner.directoryName && dirs.at(-2)) {
      return { type: child.name, name: `${dirs.at(-2)}.${name}`, parent: dirs.at(-2), parentType: owner.name };
    }
  }

  const candidates = bySuffix.get(suffix);
  if (!candidates?.length) return undefined;
  // Several types share some suffixes ("settings", "site"): the folder tells them apart.
  const pick = (t: RegistryType) => dirs.lastIndexOf(t.directoryName);
  const type = candidates.reduce((best, t) => (pick(t) > pick(best) ? t : best));
  const at = pick(type);
  if (at < 0) return undefined;
  if (type.inFolder) {
    // reports/Sales/Pipeline.report-meta.xml is "Sales/Pipeline"; a folder's own file is
    // reports/Sales.reportFolder-meta.xml, another type.
    const folders = dirs.slice(at + 1);
    if (!folders.length) return undefined;
    return { type: type.name, name: [...folders, name].join("/") };
  }
  // A metadata-only type must sit right in its folder, as a content file (Foo.cls) does;
  // a decomposed one sits in a folder of its own name (bots/MyBot/MyBot.bot-meta.xml).
  if (at === dirs.length - 1 || (at === dirs.length - 2 && dirs.at(-1) === name)) return { type: type.name, name };
  return undefined;
}

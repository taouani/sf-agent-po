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
  /** How a decomposed type lays out its children: "topLevel" (beside the parent's file) or "folderPerType". */
  decomposition?: string;
  /** The type of the folders this type sits in: ReportFolder for Report, Territory2Model for Territory2. */
  folderType?: string;
  /** For a folder type, the type it holds: Report for ReportFolder. */
  folderContentType?: string;
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
  /**
   * The type's folder the file was found in ("force-app/main/default/classes"): two files of
   * one component share it, and the same name in another one is another definition.
   */
  home: string;
}

/** Adapters whose folder belongs to the type whatever it holds: a bundle's files, a static resource's. */
const OWNING_ADAPTERS = new Set(["bundle", "mixedContent", "digitalExperience", "uiBundles"]);

interface Lookups {
  bySuffix: Map<string, RegistryType[]>;
  byName: Map<string, RegistryType>;
  childBySuffix: Map<string, { parent: RegistryType; child: { name: string; suffix: string; directoryName: string } }[]>;
  owners: Map<string, RegistryType>;
}

let lookups: Lookups | undefined;
function tables(): Lookups {
  if (lookups) return lookups;
  const bySuffix = new Map<string, RegistryType[]>();
  const byName = new Map<string, RegistryType>();
  const childBySuffix: Lookups["childBySuffix"] = new Map();
  const owners = new Map<string, RegistryType>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const t of Object.values(REGISTRY_TYPES)) {
    byName.set(t.name, t);
    if (t.suffix) push(bySuffix, t.suffix.toLowerCase(), t);
    if (t.adapter && OWNING_ADAPTERS.has(t.adapter) && !owners.has(t.directoryName)) owners.set(t.directoryName, t);
    for (const c of Object.values(t.children ?? {})) push(childBySuffix, c.suffix.toLowerCase(), { parent: t, child: c });
  }
  return (lookups = { bySuffix, byName, childBySuffix, owners });
}

export const registryTypeCount = () => Object.keys(REGISTRY_TYPES).length;

/** Test folders, mocks and dotfiles: in a bundle's folder, but not part of the component. */
const notPart = (segment: string) => segment.startsWith(".") || segment.startsWith("__");

/**
 * The component a file belongs to, or undefined for a file that is not metadata (README,
 * package.json, an LWC test). Works on both formats: "classes/Foo.cls-meta.xml" (source)
 * and "classes/Foo.cls" (metadata format) both give ApexClass Foo. `rel` is relative to the
 * project, with forward slashes.
 */
export function classifyFile(rel: string): RegistryMatch | undefined {
  const { bySuffix, byName, childBySuffix, owners } = tables();
  const parts = rel.split("/");
  const base = parts.at(-1)!;
  const dirs = parts.slice(0, -1);
  const homeAt = (i: number) => dirs.slice(0, i + 1).join("/");

  // A folder that belongs to one type, whatever it holds: lwc/myCmp/anything,
  // staticresources/myRes/anything, experiences/MySite1/anything. The outermost wins, so an
  // expanded static resource holding an "lwc" or "classes" folder is still one resource.
  for (let i = 0; i < dirs.length; i++) {
    const owner = owners.get(dirs[i]!);
    if (!owner) continue;
    const below = dirs.slice(i + 1);
    if ([...below, base].some(notPart)) return undefined;
    const home = homeAt(i);
    if (owner.inFolder) {
      // documents/Folder/logo.png with logo.document-meta.xml (source) or logo.png-meta.xml
      // (metadata format): Document "Folder/logo"; documents/Folder.documentFolder-meta.xml or
      // documents/Folder-meta.xml: its folder.
      const stem = base.endsWith("-meta.xml") ? base.slice(0, -"-meta.xml".length) : base;
      const folderSuffix = owner.folderType && byName.get(owner.folderType)?.suffix;
      const isFolder = !!folderSuffix && stem.endsWith(`.${folderSuffix}`);
      if (isFolder || (!below.length && base.endsWith("-meta.xml") && !stem.includes("."))) {
        const folder = isFolder ? stem.slice(0, -folderSuffix.length - 1) : stem;
        return owner.folderType && folder ? { type: owner.folderType, name: [...below, folder].join("/"), home } : undefined;
      }
      if (!below.length) return undefined;
      const dot = stem.lastIndexOf(".");
      const name = dot > 0 ? stem.slice(0, dot) : stem;
      return { type: owner.name, name: [...below, name].join("/"), home };
    }
    // digitalExperiences/site/MySite1/...: DigitalExperienceBundle "site/MySite1".
    if (owner.adapter === "digitalExperience") return below.length >= 2 ? { type: owner.name, name: `${below[0]}/${below[1]}`, home } : undefined;
    if (below.length) return { type: owner.name, name: below[0]!, home };
    // A bundle is a folder: a file beside them (lwc/jsconfig.json) is not one.
    if (owner.adapter !== "mixedContent") return undefined;
    // staticresources/logo.png with logo.resource-meta.xml, experiences/MySite1.site-meta.xml.
    const name = base.split(".")[0]!;
    return name ? { type: owner.name, name, home } : undefined;
  }

  const meta = base.endsWith("-meta.xml");
  const stem = meta ? base.slice(0, -"-meta.xml".length) : base;
  const dot = stem.lastIndexOf(".");
  const name = dot > 0 ? stem.slice(0, dot) : stem;
  const suffix = dot > 0 ? stem.slice(dot + 1).toLowerCase() : "";

  if (dot > 0) {
    // A child written as its own file: objects/Account/listViews/All.listView-meta.xml (a
    // folder per child type), or bots/MyBot/v1.botVersion-meta.xml (beside the parent's file).
    for (const { parent: owner, child } of childBySuffix.get(suffix) ?? []) {
      if (!meta) continue;
      const perType = dirs.at(-1) === child.directoryName && dirs.at(-3) === owner.directoryName && dirs.at(-2);
      const topLevel = owner.decomposition === "topLevel" && dirs.at(-2) === owner.directoryName && dirs.at(-1);
      const parent = perType ? dirs.at(-2)! : topLevel ? dirs.at(-1)! : undefined;
      if (parent) return { type: child.name, name: `${parent}.${name}`, parent, parentType: owner.name, home: homeAt(dirs.lastIndexOf(owner.directoryName)) };
    }
  }

  // Several types share some suffixes ("settings", "site"): the folder tells them apart.
  const candidates = dot > 0 ? bySuffix.get(suffix) : undefined;
  const pick = (t: RegistryType) => dirs.lastIndexOf(t.directoryName);
  const type = candidates?.length ? candidates.reduce((best, t) => (pick(t) > pick(best) ? t : best)) : undefined;
  const at = type ? pick(type) : -1;
  if (!type || at < 0) {
    // A folder's file in metadata format has no suffix: reports/Sales-meta.xml,
    // reports/Sales/Sub-meta.xml are report folders.
    if (!meta || dot > 0) return undefined;
    for (let i = dirs.length - 1; i >= 0; i--) {
      const folderType = [...byName.values()].find((t) => t.folderContentType && t.directoryName === dirs[i] && byName.get(t.folderContentType)?.inFolder);
      if (folderType) return { type: folderType.name, name: [...dirs.slice(i + 1), name].join("/"), home: homeAt(i) };
    }
    return undefined;
  }
  const home = homeAt(at);
  const folders = dirs.slice(at + 1);
  if (type.inFolder) {
    // reports/Sales/Pipeline.report-meta.xml is "Sales/Pipeline"; a folder's own file is
    // reports/Sales.reportFolder-meta.xml, another type.
    if (!folders.length) return undefined;
    return { type: type.name, name: [...folders, name].join("/"), home };
  }
  // Folders nest: reports/Sales/Sub.reportFolder-meta.xml is "Sales/Sub".
  if (type.folderContentType) return { type: type.name, name: [...folders, name].join("/"), home };
  // A territory's name starts with its model's: territory2Models/M1/territories/T1 is "M1.T1".
  const folderType = type.folderType ? byName.get(type.folderType) : undefined;
  if (folderType && at === dirs.length - 1 && at >= 2 && dirs[at - 2] === folderType.directoryName) {
    return { type: type.name, name: `${dirs[at - 1]}.${name}`, home };
  }
  // A metadata-only type must sit right in its folder, as a content file (Foo.cls) does;
  // a decomposed one sits in a folder of its own name (bots/MyBot/MyBot.bot-meta.xml).
  if (at === dirs.length - 1 || (at === dirs.length - 2 && dirs.at(-1) === name)) return { type: type.name, name, home };
  return undefined;
}

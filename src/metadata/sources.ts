import { access, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "../util/exec.js";

export const METADATA_PROVIDERS = ["local", "github", "gitlab", "azure-devops", "git"] as const;
export type MetadataProvider = (typeof METADATA_PROVIDERS)[number];

export interface MetadataSourceSpec {
  provider: MetadataProvider;
  /**
   * local: a folder path (a shared drive works too).
   * github / gitlab: "owner/repo" or a full URL.
   * azure-devops / git: a clone URL.
   */
  location: string;
  /** Branch or tag to check out. Defaults to the repository's default branch. */
  ref?: string;
}

/**
 * Every provider resolves to a local checkout, so metadata analysis is the same
 * whatever the source. Remote repositories are cloned with the provider's own
 * CLI, which reuses the credentials the user already has (gh auth, glab auth,
 * git credential manager for Azure DevOps).
 */
export async function resolveMetadataSource(spec: MetadataSourceSpec, workspaceDir: string): Promise<string> {
  if (spec.provider === "local") {
    const dir = path.resolve(spec.location);
    if (!(await stat(dir)).isDirectory()) throw new Error(`${dir} is not a directory.`);
    return dir;
  }

  for (const [field, value] of [["location", spec.location], ["ref", spec.ref]] as const) {
    // A leading "-" would be read by gh/glab/git as an option rather than a repository or branch.
    if (value?.startsWith("-")) throw new Error(`Invalid ${field} "${value}": it must not start with "-".`);
  }

  const dest = path.join(workspaceDir, "repos", slug(spec));
  if (await exists(path.join(dest, ".git"))) {
    await run("git", ["-C", dest, "pull", "--ff-only"]);
    return dest;
  }

  const gitFlags = ["--depth", "1", ...(spec.ref ? ["--branch", spec.ref] : [])];
  try {
    switch (spec.provider) {
      case "github":
        await run("gh", ["repo", "clone", spec.location, dest, "--", ...gitFlags]);
        break;
      case "gitlab":
        await run("glab", ["repo", "clone", spec.location, dest, "--", ...gitFlags]);
        break;
      case "azure-devops":
      case "git":
        await run("git", ["clone", ...gitFlags, "--", spec.location, dest]);
        break;
    }
  } catch (err) {
    throw new Error((err as Error).message.split(spec.location).join(redactLocation(spec.location)));
  }
  return dest;
}

/**
 * Removes credentials embedded in a clone URL (e.g. an Azure DevOps PAT in
 * https://<PAT>@dev.azure.com/...) so they never reach titles, folder names,
 * saved contexts or the model.
 */
export function redactLocation(location: string): string {
  try {
    const url = new URL(location);
    if (!url.username && !url.password) return location;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return location;
  }
}

function slug(spec: MetadataSourceSpec): string {
  const base = redactLocation(spec.location)
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^\w.-]+/g, "_");
  return `${spec.provider}_${base}${spec.ref ? `@${spec.ref.replace(/[^\w.-]+/g, "_")}` : ""}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

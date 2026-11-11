import { createHash } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "./exec.js";

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

/** The remote providers `index --repo` and the metadata_index tool take, as `<provider>:<location>[#<ref>]`. */
export const REPO_PROVIDERS = ["github", "gitlab", "azure-devops", "git"] as const;
export type RepoProvider = (typeof REPO_PROVIDERS)[number];

export const REPO_SPEC_HELP =
  "github:owner/repo, gitlab:group/repo, azure-devops:<clone URL> or git:<clone URL>, with #<branch or tag> to pick one";

/** A branch or tag: nothing git could read as an option, a range or a path out of the repository. */
const REF = /^(?!-)(?!.*\.\.)[\w./-]+$/;
/** owner/repo, or group/subgroup/repo on GitLab. */
const SLUG = /^[\w.-]+(?:\/[\w.-]+)+$/;

/**
 * Reads `github:owner/repo[#ref]`, `gitlab:group/repo[#ref]`, `azure-devops:<url>[#ref]` or
 * `git:<url>[#ref]`. A clone URL is https, ssh, `user@host:path` or file; git's transport
 * helpers (`ext::`, `fd::`) are refused, as is anything git could read as an option.
 */
export function parseRepoSpec(text: string): MetadataSourceSpec & { provider: RepoProvider } {
  const colon = text.indexOf(":");
  const provider = text.slice(0, colon) as RepoProvider;
  if (colon < 0 || !REPO_PROVIDERS.includes(provider)) throw new Error(`"${redactLocation(text)}" is not a repository: give ${REPO_SPEC_HELP}.`);
  let location = text.slice(colon + 1).trim();
  let ref: string | undefined;
  const hash = location.lastIndexOf("#");
  if (hash >= 0) {
    ref = location.slice(hash + 1);
    location = location.slice(0, hash);
    if (!REF.test(ref)) throw new Error(`"${ref}" is not a branch or tag name.`);
  }
  const shown = redactLocation(location);
  if (!location || location.startsWith("-")) throw new Error(`"${shown}" is not a repository: give ${REPO_SPEC_HELP}.`);
  if (provider === "github" || provider === "gitlab") {
    if (!SLUG.test(location) && !/^https:\/\/[^\s]+$/.test(location)) throw new Error(`"${shown}" is not a ${provider} repository: give owner/repo or its https URL.`);
  } else if (location.includes("::") || !/^(?:https:\/\/|ssh:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)\S+$/.test(location)) {
    throw new Error(`"${shown}" is not a clone URL: give an https, ssh or file URL, or user@host:path.`);
  }
  return { provider, location, ...(ref ? { ref } : {}) };
}

/**
 * A remote repository's source name in the index: its name, its branch or tag, and a short
 * hash of where it is, so that two repositories of one name stay apart. Credentials in a
 * clone URL are left out first, so the name stays the same when a token changes.
 */
export function repoSource(spec: MetadataSourceSpec): string {
  const where = redactLocation(spec.location).replace(/\.git$/, "").replace(/\/+$/, "");
  const name = where.split(/[/:]/).filter(Boolean).pop() ?? spec.provider;
  const key = `${spec.provider}:${where.toLowerCase()}#${spec.ref ?? ""}`;
  return `repo:${name}${spec.ref ? `@${spec.ref}` : ""}#${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/**
 * Every provider resolves to a local checkout, so metadata analysis is the same
 * whatever the source. Remote repositories are cloned with the provider's own
 * CLI, which reuses the credentials the user already has (gh auth, glab auth,
 * git credential manager for Azure DevOps). On the next call the checkout is
 * brought to the remote's latest commit (a force push included); when that
 * fails, it is cloned again.
 */
export async function resolveMetadataSource(spec: MetadataSourceSpec, workspaceDir: string, options: { progress?: (message: string) => void } = {}): Promise<string> {
  if (spec.provider === "local") {
    const dir = path.resolve(spec.location);
    if (!(await stat(dir)).isDirectory()) throw new Error(`${dir} is not a directory.`);
    return dir;
  }

  for (const [field, value] of [["location", spec.location], ["ref", spec.ref]] as const) {
    // A leading "-" would be read by gh/glab/git as an option rather than a repository or branch.
    if (value?.startsWith("-")) throw new Error(`Invalid ${field} "${value}": it must not start with "-".`);
  }

  const shown = redactLocation(spec.location);
  const redacted = (err: unknown) => new Error(((err as Error)?.message ?? String(err)).split(spec.location).join(shown));
  const dest = path.join(workspaceDir, "repos", slug(spec));
  if (await exists(path.join(dest, ".git"))) {
    options.progress?.(`Fetching ${shown}`);
    try {
      // gh's own credential helper, as gh repo clone used it, after the user's own helpers.
      const helper = spec.provider === "github" ? ["-c", "credential.helper=!gh auth git-credential"] : [];
      await run("git", [...helper, "-C", dest, "fetch", "--quiet", "--depth", "1", "origin", spec.ref ?? "HEAD"], { timeoutMs: 15 * 60_000 });
      await run("git", ["-C", dest, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
      return dest;
    } catch {
      // A checkout git cannot bring up to date (a broken one, a remote that moved) is cloned again.
      await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }

  options.progress?.(`Cloning ${shown}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const gitFlags = ["--depth", "1", ...(spec.ref ? ["--branch", spec.ref] : [])];
  const timeoutMs = 30 * 60_000;
  try {
    switch (spec.provider) {
      case "github":
        await run("gh", ["repo", "clone", spec.location, dest, "--", ...gitFlags], { timeoutMs });
        break;
      case "gitlab":
        await run("glab", ["repo", "clone", spec.location, dest, "--", ...gitFlags], { timeoutMs });
        break;
      case "azure-devops":
      case "git":
        await run("git", ["clone", ...gitFlags, "--", spec.location, dest], { timeoutMs });
        break;
    }
  } catch (err) {
    // A clone that failed halfway would be taken for a checkout next time.
    await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    throw redacted(err);
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

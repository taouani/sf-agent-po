import { createHash } from "node:crypto";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
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
const REF = /^(?!-)(?!.*\.\.)(?!HEAD$)(?!.*\.lock$)[\w./-]*[\w-]$/;
/** owner/repo, or group/subgroup/repo on GitLab. */
const SLUG = /^[\w.-]+(?:\/[\w.-]+)+$/;

/**
 * Reads `github:owner/repo[#ref]`, `gitlab:group/repo[#ref]`, `azure-devops:<url>[#ref]` or
 * `git:<url>[#ref]`. A clone URL is https, ssh, `user@host:path` or file; git's transport
 * helpers (`ext::`, `fd::`) are refused, as is anything git could read as an option.
 */
export function parseRepoSpec(text: string): MetadataSourceSpec & { provider: RepoProvider } {
  // Nothing after the provider is quoted back until it is known to hold no credentials.
  const colon = text.indexOf(":");
  const provider = text.slice(0, colon) as RepoProvider;
  if (colon < 0 || !REPO_PROVIDERS.includes(provider)) {
    const named = /^[\w-]{1,30}$/.test(provider) ? ` "${provider}" is not one:` : "";
    throw new Error(`That is not a repository:${named} give ${REPO_SPEC_HELP}.`);
  }
  let location = text.slice(colon + 1).trim();
  let ref: string | undefined;
  const hash = location.lastIndexOf("#");
  if (hash >= 0) {
    ref = location.slice(hash + 1);
    location = location.slice(0, hash);
    if (!REF.test(ref)) throw new Error("The branch or tag after # is not a name git takes.");
  }
  const shown = redactLocation(location);
  if (!location || location.startsWith("-")) throw new Error(`"${shown}" is not a repository: give ${REPO_SPEC_HELP}.`);
  if (provider === "github" || provider === "gitlab") {
    if (!SLUG.test(location) && !(/^https:\/\//.test(location) && cloneUrl(location))) throw new Error(`"${shown}" is not a ${provider} repository: give owner/repo or its https URL.`);
  } else if (!cloneUrl(location)) {
    throw new Error(`"${shown}" is not a clone URL: give an https, ssh or file URL, or user@host:path.`);
  }
  return { provider, location, ...(ref ? { ref } : {}) };
}

/**
 * Whether git may be given `location` to clone: an https, ssh or file URL that parses, with a
 * host that cannot be read as an option, or `user@host:path`. Transport helpers (`ext::`) are
 * not URLs and are refused.
 */
function cloneUrl(location: string): boolean {
  if (/\s/.test(location) || location.includes("::")) return false;
  if (/^[\w.-]+@\w[\w.-]*:(?!\/\/)\S+$/.test(location)) return true;
  if (!/^(?:https|ssh|file):\/\//.test(location)) return false;
  try {
    const url = new URL(location);
    return !url.hostname.startsWith("-") && (url.protocol === "file:" || url.hostname !== "");
  } catch {
    return false;
  }
}

/**
 * A remote repository's source name in the index: its name, its branch or tag, and a short
 * hash of where it is, so that two repositories of one name stay apart. Credentials in a
 * clone URL are left out first, so the name stays the same when a token changes.
 */
export function repoSource(spec: MetadataSourceSpec): string {
  const where = redactLocation(spec.location).replace(/\.git$/, "").replace(/\/+$/, "");
  const name = where.split(/[/:]/).filter(Boolean).pop() ?? spec.provider;
  // GitHub and GitLab do not care about case in names; other servers may.
  const key = `${spec.provider}:${spec.provider === "github" || spec.provider === "gitlab" ? where.toLowerCase() : where}#${spec.ref ?? ""}`;
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
export async function resolveMetadataSource(
  spec: MetadataSourceSpec,
  workspaceDir: string,
  options: {
    progress?: (message: string) => void;
    /** Let git and gh ask for credentials (a run in a terminal). */
    interactive?: boolean;
    /**
     * A folder set's name: the set gets a checkout of its own, so that runs of the whole
     * repository and of each set, which hold different leases, never share one.
     */
    checkout?: string;
  } = {},
): Promise<string> {
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
  const redacted = (err: unknown, prefix = "") => new Error(prefix + ((err as Error)?.message ?? String(err)).split(spec.location).join(shown));
  // One folder per source: names that differ only by a character the folder name cannot hold
  // stay apart.
  const dest = path.join(workspaceDir, "repos", `${checkoutName(spec)}${options.checkout ? `_${options.checkout.replace(/[^\w.-]+/g, "_")}` : ""}`);
  const quiet = { ...(options.interactive ? {} : { env: NON_INTERACTIVE }) };
  let fetchError: unknown;
  if (await exists(path.join(dest, ".git"))) {
    options.progress?.(`Fetching ${shown}`);
    try {
      // gh's own credential helper, set as gh repo clone sets it.
      const helper = spec.provider === "github" ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
      await run("git", [...helper, "-C", dest, "fetch", "--quiet", "--depth", "1", "origin", spec.ref ?? "HEAD"], { timeoutMs: 15 * 60_000, ...quiet });
      await run("git", ["-C", dest, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
      return dest;
    } catch (err) {
      // A checkout git cannot bring up to date (a broken one, a remote that moved) is cloned
      // again, beside it: the old one goes only once the new one is complete.
      fetchError = err;
    }
  }

  options.progress?.(`Cloning ${shown}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const next = fetchError ? `${dest}.next` : dest;
  await rm(next, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  const gitFlags = ["--depth", "1", ...(spec.ref ? ["--branch", spec.ref] : [])];
  const cloning = { timeoutMs: 30 * 60_000, ...quiet };
  try {
    switch (spec.provider) {
      case "github":
        await run("gh", ["repo", "clone", spec.location, next, "--", ...gitFlags], cloning);
        break;
      case "gitlab":
        await run("glab", ["repo", "clone", spec.location, next, "--", ...gitFlags], cloning);
        break;
      case "azure-devops":
      case "git":
        await run("git", ["clone", ...gitFlags, "--", spec.location, next], cloning);
        break;
    }
  } catch (err) {
    // A clone that failed halfway would be taken for a checkout next time.
    await rm(next, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    if (fetchError) throw redacted(err, `${redacted(fetchError).message}\nCloning again failed too: `);
    throw redacted(err);
  }
  if (fetchError) {
    await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await rename(next, dest);
  }
  return dest;
}

/**
 * What keeps git, gh and Git Credential Manager from asking for a password or a sign-in where
 * no one answers (the server's background runs): the run fails, and says why, instead.
 */
const NON_INTERACTIVE: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GCM_INTERACTIVE: "never" };

/**
 * Removes credentials embedded in a clone URL (e.g. an Azure DevOps PAT in
 * https://<PAT>@dev.azure.com/...) so they never reach titles, folder names,
 * saved contexts or the model.
 */
export function redactLocation(location: string): string {
  let out = location;
  try {
    const url = new URL(location);
    if (url.username || url.password || url.search) {
      url.username = "";
      url.password = "";
      url.search = "";
      out = url.toString();
    }
  } catch {
    // Not a URL Node can read, though git may: credentials go by pattern instead.
  }
  // What a URL holds before its host, and its query (a token as private_token=...).
  return out.replace(/([a-z][\w+.-]*:\/\/)[^/\s]*@/gi, "$1").replace(/(:\/\/[^\s?#]*)\?[^\s#]*/g, "$1");
}

/** A checkout's folder: the source name, as a folder name. */
function checkoutName(spec: MetadataSourceSpec): string {
  const [, name, hash] = /^repo:(.*)#([0-9a-f]{8})$/.exec(repoSource(spec))!;
  return `${spec.provider}_${name!.replace(/[^\w.-]+/g, "_").slice(0, 60)}_${hash}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

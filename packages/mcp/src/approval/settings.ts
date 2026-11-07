// Masked-input review (open question 8): the user checks each masked input before the agents
// use it. On by default in pre-releases, where detection misses are most likely to be found,
// and a setting of each context either way.

/** Whether a version is a pre-release ("1.0.0-next.3"). */
export const isPrerelease = (version: string) => /^\d+\.\d+\.\d+-/.test(version);

/** Whether inputs of a context are reviewed: its `reviewInputs` setting, else on in pre-releases. */
export function reviewsInputs(settings: Record<string, unknown> | undefined, version: string): boolean {
  const own = settings?.reviewInputs;
  return typeof own === "boolean" ? own : isPrerelease(version);
}

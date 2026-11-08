// Every string in a value the agent wrote (a design section), masked in one call: the pseudonyms
// it used stay, and what it wrote in clear is masked, with the same pseudonym for the same value.

import type { Masker } from "@sf-agent-po/core";

/** The value with each string masked; numbers, booleans and the shape stay as they are. */
export async function maskDeep<T>(masker: Masker, context: string, value: T): Promise<T> {
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(value);
  if (!strings.length) return value;
  const { texts } = await masker.maskOutputs(context, strings);
  let i = 0;
  const rebuild = (v: unknown): unknown => {
    if (typeof v === "string") return texts[i++]!;
    if (Array.isArray(v)) return v.map(rebuild);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebuild(x)]));
    return v;
  };
  return rebuild(value) as T;
}

/** Every string in a value, for the language check. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

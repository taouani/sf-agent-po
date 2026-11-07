// Writes spike results to stdout, to the GitHub Actions job summary when present, and to out/.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUT_DIR = join(import.meta.dirname, '..', 'out');

/**
 * Saves a report to out/. A summary is also printed and added to the GitHub Actions job summary;
 * a detail report (`summary: false`) only goes to out/, which CI uploads as an artifact.
 */
export function writeReport(name: string, markdown: string, data?: unknown, { summary = true } = {}): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.md`), markdown);
  if (data !== undefined) writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2));
  if (!summary) return;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}% (${n}/${d})`);

export function platform(): string {
  return `${process.platform}-${process.arch}, Node ${process.version}`;
}

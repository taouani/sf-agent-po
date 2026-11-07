// Renders the OCR fixtures to PNG, plus one mask per sensitive string (the string's pixels
// only, at the same position) so the spike can measure exactly how much of it was covered.
// Run once on a machine with the listed fonts; the output is committed.
import sharp from 'sharp';
import { join } from 'node:path';
import { FIXTURES, maskName, type Fixture } from './fixtures.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svg(f: Fixture, only?: string): string {
  const lineHeight = Math.round(f.fontSize * 1.7);
  const grey = f.file.includes('grey') && !only;
  const ink = grey ? '#4a4f57' : '#16181d';
  const lines = f.lines.map((l, i) => {
    let body = esc(l);
    if (only !== undefined) {
      const at = l.indexOf(only);
      // Draw the whole line so layout is identical, but only the target string is visible.
      body =
        at < 0
          ? `<tspan fill="none">${esc(l)}</tspan>`
          : `<tspan fill="none">${esc(l.slice(0, at))}</tspan><tspan fill="#000">${esc(only)}</tspan><tspan fill="none">${esc(l.slice(at + only.length))}</tspan>`;
    }
    return `<text x="24" y="${lineHeight * (i + 1)}" font-family="${f.font}" font-size="${f.fontSize}" fill="${ink}" xml:space="preserve">${body}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${lineHeight * (f.lines.length + 1)}">
  <rect width="100%" height="100%" fill="${grey ? '#eef0f3' : '#ffffff'}"/>
  ${lines.join('\n  ')}
</svg>`;
}

const dir = join(import.meta.dirname, 'fixtures');
for (const f of FIXTURES) {
  await sharp(Buffer.from(svg(f))).png({ compressionLevel: 9, palette: true }).toFile(join(dir, f.file));
  for (const [i, s] of f.sensitive.entries()) {
    await sharp(Buffer.from(svg(f, s))).greyscale().png({ compressionLevel: 9, palette: true, colours: 4 }).toFile(join(dir, maskName(f.file, i)));
  }
  console.log('wrote', f.file, 'and', f.sensitive.length, 'masks');
}


// Spike 4, draw.io part: creates one Confluence page with three ways of showing a draw.io
// diagram, so you can see which one the draw.io app renders on your site.
//
// Run from the spikes folder with your own credentials (nothing is stored):
//   ATLASSIAN_SITE=https://your-site.atlassian.net ATLASSIAN_EMAIL=you@example.com \
//   ATLASSIAN_API_TOKEN=... CONFLUENCE_SPACE_KEY=ABC node host-kit/drawio-confluence.ts

import { DIAGRAM_NAME, DRAWIO_XML } from './drawio.ts';

const need = (k: string) => process.env[k] ?? (console.error(`Missing ${k}`), process.exit(1));
const site = need('ATLASSIAN_SITE').replace(/\/$/, '');
const auth = 'Basic ' + Buffer.from(`${need('ATLASSIAN_EMAIL')}:${need('ATLASSIAN_API_TOKEN')}`).toString('base64');
const spaceKey = need('CONFLUENCE_SPACE_KEY');

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${site}/wiki${path}`, { ...init, headers: { authorization: auth, accept: 'application/json', ...(init.headers ?? {}) } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function attach(pageId: string, name: string, type: string, content: string): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  form.append('minorEdit', 'true');
  await api(`/rest/api/content/${pageId}/child/attachment`, { method: 'PUT', headers: { 'X-Atlassian-Token': 'no-check' }, body: form });
}

const macro = (diagramName: string) =>
  `<ac:structured-macro ac:name="drawio" ac:schema-version="1">` +
  `<ac:parameter ac:name="diagramName">${diagramName}</ac:parameter>` +
  `<ac:parameter ac:name="diagramDisplayName">${diagramName}</ac:parameter>` +
  `<ac:parameter ac:name="revision">1</ac:parameter>` +
  `<ac:parameter ac:name="contentVer">1</ac:parameter>` +
  `<ac:parameter ac:name="simpleViewer">false</ac:parameter>` +
  `<ac:parameter ac:name="lbox">true</ac:parameter>` +
  `<ac:parameter ac:name="width">600</ac:parameter>` +
  `</ac:structured-macro>`;

const space = (await api(`/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`)).results?.[0];
if (!space) throw new Error(`Space ${spaceKey} not found`);
const title = `sf-agent-po draw.io check ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
const page = await api('/api/v2/pages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spaceId: space.id, status: 'current', title, body: { representation: 'storage', value: '<p>Setting up…</p>' } }),
});

// The draw.io app stores a diagram as an attachment named after the diagram, without extension.
await attach(page.id, DIAGRAM_NAME, 'application/vnd.jgraph.mxfile', DRAWIO_XML);
await attach(page.id, `${DIAGRAM_NAME}-b.drawio`, 'application/vnd.jgraph.mxfile', DRAWIO_XML);

const esc = (s: string) => s.replace(/]]>/g, ']]]]><![CDATA[>');
const body = [
  '<h2>A. draw.io macro, attachment without extension</h2>',
  macro(DIAGRAM_NAME),
  '<h2>B. draw.io macro, attachment with .drawio extension</h2>',
  macro(`${DIAGRAM_NAME}-b.drawio`),
  '<h2>C. Fallback: diagram source in a code block</h2>',
  `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">xml</ac:parameter><ac:plain-text-body><![CDATA[${esc(DRAWIO_XML)}]]></ac:plain-text-body></ac:structured-macro>`,
].join('\n');
await api(`/api/v2/pages/${page.id}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: page.id, status: 'current', title, body: { representation: 'storage', value: body }, version: { number: 2 } }),
});
console.log(`Created ${site}/wiki${page._links?.webui ?? `/pages/${page.id}`}`);
console.log('Open it and note which of A, B and C shows the diagram (Account, Contact, Opportunity), and whether A or B opens in the draw.io editor.');

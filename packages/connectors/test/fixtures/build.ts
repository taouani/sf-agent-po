// Builds small Office, PDF and draw.io files for the reader tests, so no binary fixture is checked in.

import { deflateRawSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const zip = (parts: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]))));
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (...r: string[]) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join("")}</Relationships>`;
const core = (title: string, author: string) =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></cp:coreProperties>`;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const wp = (text: string, style?: string, list = false) =>
  `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const wstyle = (id: string, name: string, inner = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;

/** A Word file with styles, structured rows, merged cells, moves, text boxes and footnotes. */
export function docxFeatures(): Buffer {
  const cell = (text: string, span = 1) => `<w:tc>${span > 1 ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ""}${wp(text)}</w:tc>`;
  const body = [
    wp("Exigences", "Exig"),
    wp("Not a heading", "Kop1"),
    `<w:p><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Numbering removed</w:t></w:r></w:p>`,
    wp("Bullet from style", "Puce"),
    `<w:p><w:r><w:t>Client&#8217;s &#x2014; </w:t></w:r><w:moveFrom><w:r><w:t>moved </w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>arrived</w:t></w:r></w:moveTo></w:p>`,
    `<w:p><w:r><mc:AlternateContent ${MC}><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${wp("Box text")}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${wp("Box text")}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    `<w:tbl><w:tr>${cell("A")}${cell("B")}${cell("C")}</w:tr><w:sdt><w:sdtContent><w:tr>${cell("Merged", 2)}${cell("Last")}</w:tr></w:sdtContent></w:sdt></w:tbl>`,
  ].join("");
  return zip({
    "word/document.xml": `${XML}<w:document ${W} ${MC}><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": `${XML}<w:styles ${W}>${[
      wstyle("Heading2", "heading 2"),
      wstyle("Exig", "Exigence", '<w:basedOn w:val="Heading2"/>'),
      wstyle("Kop1", "Kop 1"),
      wstyle("Puce", "List Bullet", '<w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr>'),
    ].join("")}</w:styles>`,
    "word/footnotes.xml": `${XML}<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${wp("---")}</w:footnote><w:footnote w:id="1">${wp("See the 2025 audit.")}</w:footnote></w:footnotes>`,
  });
}

export function docx(): Buffer {
  const body = [
    wp("VIP clienteling", "Heading1"),
    wp("Sarah Whitfield wants the VIP flag &amp; a private sale."),
    `<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>Deleted words</w:delText></w:r></w:del><w:r><w:tab/><w:t>after tab</w:t></w:r><w:r><w:instrText> HYPERLINK "x" </w:instrText></w:r></w:p>`,
    wp("Clienteling book", undefined, true),
    wp("Private appointments", undefined, true),
    wp("Besoins", "Titre2"),
    `<w:tbl><w:tr><w:tc>${wp("Field")}</w:tc><w:tc>${wp("Owner")}</w:tc></w:tr><w:tr><w:tc>${wp("VIP__c")}</w:tc><w:tc>${wp("Tom | Baker")}</w:tc></w:tr></w:tbl>`,
  ].join("");
  return zip({
    "[Content_Types].xml": `${XML}<Types/>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    "word/comments.xml": `${XML}<w:comments ${W}><w:comment w:id="0" w:author="Tom Baker">${wp("Check with legal")}</w:comment></w:comments>`,
    "docProps/core.xml": core("VIP spec", "Sarah Whitfield"),
  });
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const shape = (paras: string[], ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
const slide = (inner: string, hidden = false) => `${XML}<p:sld ${A}${hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

export function pptx(): Buffer {
  const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>KPI</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Target</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>NPS</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>70</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  return zip({
    "ppt/presentation.xml": `${XML}<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(rel("rId2", "slide", "slides/slide1.xml"), rel("rId3", "slide", "slides/slide2.xml")),
    // slide2.xml comes first in the deck: the order is the presentation's, not the file names'.
    "ppt/slides/slide2.xml": slide(shape(["Programme VIP"], "ctrTitle") + shape(["Owner: Sarah Whitfield"], "subTitle") + shape(["3"], "sldNum")),
    "ppt/slides/_rels/slide2.xml.rels": rels(rel("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")),
    "ppt/notesSlides/notesSlide1.xml": slide(shape(["Mention the budget"], "body") + shape(["3"], "sldNum")),
    "ppt/slides/slide1.xml": slide(shape(["Goals"], "title") + shape(["Grow retention", "Know every client"]) + table, true),
    "docProps/core.xml": core("", "Tom Baker"),
  });
}

/** A deck whose shapes are wrapped in AlternateContent, with a SmartArt diagram and a chart. */
export function pptxGraphics(): Buffer {
  const MCX = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
  const frame = (inner: string) => `<p:graphicFrame><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
  const inner = [
    shape(["Roadmap"], "title"),
    `<mc:AlternateContent><mc:Choice Requires="p14">${shape(["New shape"])}</mc:Choice><mc:Fallback>${shape(["New shape"])}</mc:Fallback></mc:AlternateContent>`,
    frame('<dgm:relIds r:dm="rId2" r:lo="rId3"/>'),
    frame('<c:chart r:id="rId4"/>'),
  ].join("");
  const pt = (text: string, type?: string) => `<dgm:pt modelId="${text}"${type ? ` type="${type}"` : ""}><dgm:t><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
  const ser = (name: string) =>
    `<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat></c:ser>`;
  return zip({
    "ppt/presentation.xml": `${XML}<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(rel("rId1", "slide", "slides/slide1.xml")),
    "ppt/slides/slide1.xml": `${XML}<p:sld ${A} ${MCX}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": rels(rel("rId2", "diagramData", "../diagrams/data1.xml"), rel("rId4", "chart", "../charts/chart1.xml")),
    "ppt/diagrams/data1.xml": `${XML}<dgm:dataModel ${A} ${MCX}><dgm:ptLst>${pt("Discover")}${pt("Build")}${pt("x", "parTrans")}</dgm:ptLst></dgm:dataModel>`,
    "ppt/charts/chart1.xml": `${XML}<c:chartSpace ${A} ${MCX}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>${ser("Paris")}${ser("Lyon")}</c:plotArea></c:chart></c:chartSpace>`,
  });
}

/** A sheet with dates, cells without a reference, escaped text and more columns than are kept. */
export function xlsxDates(columns: number): Buffer {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const wide = Array.from({ length: columns }, (_, i) => `<c><v>${i}</v></c>`).join("");
  return zip({
    "xl/workbook.xml": `${XML}<workbook ${S}><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
    "xl/styles.xml": `${XML}<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet ${S}><sheetData><row><c t="inlineStr"><is><t>Due &amp; owner &#8217;</t></is></c><c t="inlineStr"><is><t>When</t></is></c></row><row><c><v>1</v></c><c s="1"><v>46000</v></c><c s="2"><v>46000.5</v></c><c s="3"><v>46000</v></c></row><row>${wide}</row></sheetData></worksheet>`,
  });
}

export function xlsx(): Buffer {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip({
    "xl/workbook.xml": `${XML}<workbook ${S}><sheets><sheet name="Clients" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(rel("rId1", "worksheet", "worksheets/sheet1.xml"), rel("rId2", "worksheet", "worksheets/sheet2.xml"), rel("rId9", "sharedStrings", "sharedStrings.xml")),
    "xl/sharedStrings.xml": `${XML}<sst ${S}><si><t>Name</t></si><si><t>Phone</t></si><si><r><t>Sarah </t></r><r><t>Whitfield</t></r><rPh><t>ignored</t></rPh></si></sst>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet ${S}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>VIP</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>33612345678</v></c><c r="D2" t="b"><v>1</v></c></row><row r="3"/></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `${XML}<worksheet ${S}><sheetData/></worksheet>`,
  });
}

/** A two-page PDF with text in Helvetica, a title and an author. */
export function pdf(pages: string[] = ["Hello Sarah Whitfield", "Second page"]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const font = 3 + pages.length * 2;
  const info = font + 1;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Title (Clienteling spec) /Author (Tom Baker) >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const graph = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="&lt;b&gt;Store&lt;/b&gt; associate" style="rounded=1;html=1;" vertex="1" parent="1"/>
<object id="b" label="Client book" owner="Sarah Whitfield"><mxCell vertex="1" parent="1"/></object>
<mxCell id="e" edge="1" source="a" target="b" parent="1"/>
<mxCell id="l" value="updates" vertex="1" parent="e"/>
<mxCell id="f" value="notifies" edge="1" source="b" parent="1"/>
</root></mxGraphModel>`;

/** A draw.io page with plain-text labels, a wrapped edge and placeholders. */
export function drawioFeatures(): string {
  return `<mxfile><diagram name="Plain"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="a &lt; b &amp; &lt;i&gt;c&lt;/i&gt;" style="rounded=1;" vertex="1" parent="1"/>
<UserObject id="b" label="%role%: %name%" placeholders="1" role="Owner" name="Tom Baker"><mxCell style="html=1;" vertex="1" parent="1"/></UserObject>
<object id="e" label="approves" status="draft"><mxCell edge="1" source="a" target="b" parent="1"/></object>
</root></mxGraphModel></diagram></mxfile>`;
}

/** A draw.io file with one page inline and one compressed, as draw.io saves it. */
export function drawio(): string {
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString("base64");
  return `<mxfile host="app.diagrams.net"><diagram name="Flow">${graph}</diagram><diagram name="Packed">${packed}</diagram></mxfile>`;
}

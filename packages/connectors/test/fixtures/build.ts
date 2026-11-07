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
<mxCell id="a" value="&lt;b&gt;Store&lt;/b&gt; associate" vertex="1" parent="1"/>
<object id="b" label="Client book" owner="Sarah Whitfield"><mxCell vertex="1" parent="1"/></object>
<mxCell id="e" edge="1" source="a" target="b" parent="1"/>
<mxCell id="l" value="updates" vertex="1" parent="e"/>
<mxCell id="f" value="notifies" edge="1" source="b" parent="1"/>
</root></mxGraphModel>`;

/** A draw.io file with one page inline and one compressed, as draw.io saves it. */
export function drawio(): string {
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString("base64");
  return `<mxfile host="app.diagrams.net"><diagram name="Flow">${graph}</diagram><diagram name="Packed">${packed}</diagram></mxfile>`;
}

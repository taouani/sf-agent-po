// PDF text, page by page, through unpdf (a build of PDF.js for servers; no native code).

import { extractText, getDocumentProxy, getMeta } from "unpdf";
import type { ReadResult } from "./office.js";

/** The most pages read from one PDF. */
export const PDF_MAX_PAGES = 2000;

export async function readPdf(raw: Uint8Array): Promise<ReadResult> {
  // PDF.js takes ownership of the buffer it is given: pass a copy.
  const pdf = await getDocumentProxy(new Uint8Array(raw), { stopAtErrors: false });
  try {
    if (pdf.numPages > PDF_MAX_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages; at most ${PDF_MAX_PAGES} are read.`);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t) => t.trim());
    const { info } = await getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> }));
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const metadata: Record<string, unknown> = { pages: pdf.numPages };
    if (str(info.Author)) metadata.author = str(info.Author);
    const content = pages.some(Boolean)
      ? pages.map((t, i) => `## Page ${i + 1}\n\n${t || "_No text on this page._"}`).join("\n\n")
      : "_This PDF has no text layer (it is probably scanned). Its pages need OCR, which comes with image redaction._";
    return { content, title: str(info.Title), metadata };
  } finally {
    // Frees the document; older PDF.js builds also have destroy(), which ends its loading task.
    const proxy = pdf as typeof pdf & { destroy?: () => Promise<void> };
    await (proxy.destroy ? proxy.destroy() : pdf.cleanup());
  }
}

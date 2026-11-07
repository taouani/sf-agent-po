/** HTML (an email body, a Confluence page, a diagram label) as plain text. */
export function htmlToText(html: string): string {
  return (
    html
      // Confluence code macros wrap their body in CDATA; keep it verbatim.
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, code: string) => `\n${code}\n`.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Decode &amp; last so "&amp;lt;" becomes "&lt;", not "<".
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

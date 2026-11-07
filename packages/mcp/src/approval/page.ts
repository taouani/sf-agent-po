// The approval page's HTML: plain forms, no script, every value escaped.

import type { ApprovalRequest } from "./server.js";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A pseudonym as the vault writes it: "[PERSON_3]", "[NATIONAL_ID_1]". */
const PSEUDONYM = /\[[A-Z][A-Z_]*_\d+\]/g;

/** Text with its pseudonyms marked, so the user sees at a glance what was hidden and what was not. */
export function markPseudonyms(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PSEUDONYM)) {
    out += `${escapeHtml(text.slice(last, m.index))}<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const TYPE_NAMES: Record<string, [string, string]> = {
  PERSON: ["name", "names"],
  EMAIL: ["email address", "email addresses"],
  PHONE: ["phone number", "phone numbers"],
  ADDRESS: ["address", "addresses"],
  IBAN: ["bank account", "bank accounts"],
  CARD: ["card number", "card numbers"],
  NATIONAL_ID: ["ID number", "ID numbers"],
  SECRET: ["secret", "secrets"],
  IP: ["IP address", "IP addresses"],
  PRIVATE: ["private value", "private values"],
};

/** "3 names, 1 email address": what masking hid. */
export function describeCounts(counts: Record<string, number> = {}): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => {
      const [one, many] = TYPE_NAMES[type] ?? [type.toLowerCase().replace(/_/g, " "), `${type.toLowerCase().replace(/_/g, " ")} values`];
      return `${n} ${n === 1 ? one : many}`;
    });
  return parts.length ? parts.join(", ") : "nothing";
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --mark: #fde68a; --warn: #fef3c7; --warn-line: #d97706; --accent: #0a58ca; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #f2f2f7; --muted: #a1a1a6; --line: #3a3a3c; --mark: #854d0e; --warn: #3b2a06; --warn-line: #f59e0b; --accent: #6ea8fe; --on-accent: #0b1b33; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
pre { white-space: pre-wrap; word-break: break-word; border: 1px solid var(--line); border-radius: 8px; padding: 12px; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; max-height: 60vh; overflow: auto; }
mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; }
.warn { background: var(--warn); border-left: 4px solid var(--warn-line); padding: 10px 12px; border-radius: 6px; margin: 0 0 16px; }
.figure { position: relative; display: inline-block; max-width: 100%; border: 1px solid var(--line); }
.figure img { display: block; max-width: 100%; height: auto; }
.uncertain { position: absolute; outline: 2px solid var(--warn-line); background: rgba(245, 158, 11, 0.15); }
label, h2.label { display: block; font-size: 15px; font-weight: 600; margin: 16px 0 6px; }
textarea { width: 100%; min-height: 72px; font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.hint { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
`;

function layout(title: string, body: string, nonce: string, css = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · sf-agent-po</title><style nonce="${nonce}">${STYLE}${css}</style></head><body><main>${body}</main></body></html>`;
}

/** The page for a request still waiting for the user. */
export function requestPage(req: ApprovalRequest, opts: { action: string; csrf: string; imageUrl: string; nonce: string }): string {
  const form = (fields: string, buttons: string) =>
    `<form method="post" action="${escapeHtml(opts.action)}"><input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">${fields}<div class="actions">${buttons}</div></form>`;
  const missed = (what: string) =>
    `<label for="missed">Is anything still visible that should be hidden?</label><textarea id="missed" name="missed" placeholder="One value per line, as it is written"></textarea><p class="hint">${what}</p>`;

  if (req.kind === "publish") {
    const kept = req.kept?.length
      ? `<div class="warn">These stay masked in what is written: ${req.kept.map((k) => `<mark>${escapeHtml(k)}</mark>`).join(" ")}. Secrets are never put back, and a pseudonym this project does not know cannot be.</div>`
      : "";
    return layout(
      `Approve: ${req.title}`,
      `<h1>Approve this write</h1><p class="sub">${escapeHtml(req.target)}</p>${kept}<h2>${escapeHtml(req.title)}</h2><pre>${escapeHtml(req.body)}</pre>` +
        form(
          `<label for="comment">Comment for the agent (optional)</label><textarea id="comment" name="comment"></textarea>`,
          `<button class="primary" name="decision" value="approved">Approve and write</button><button name="decision" value="rejected">Reject</button>`,
        ),
      opts.nonce,
    );
  }

  if (req.kind === "image") {
    // Each outline is placed by a rule in the page's own style sheet (style attributes are not allowed).
    const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100)).toFixed(3)}%`;
    const css = req.uncertain
      .map((b, i) => `.u${i}{left:${pct(b.x0, req.width)};top:${pct(b.y0, req.height)};width:${pct(b.x1 - b.x0, req.width)};height:${pct(b.y1 - b.y0, req.height)}}`)
      .join("");
    const warning = req.trusted
      ? ""
      : `<div class="warn"><strong>The text could not be read reliably.</strong> Personal data the reader missed is not blacked out. Look at the whole image before you use it, or send only the text.</div>`;
    const uncertain = req.uncertain.length ? `<p class="hint">Outlined: ${req.uncertain.length} word${req.uncertain.length === 1 ? "" : "s"} the reader was unsure of. Check that none of them is personal data.</p>` : "";
    return layout(
      `Check image: ${req.title}`,
      `<h1>Check this image before the agent sees it</h1><p class="sub">${escapeHtml(req.title)} · hidden: ${escapeHtml(describeCounts(req.counts))}</p>${warning}` +
        `<div class="figure"><img src="${escapeHtml(opts.imageUrl)}" alt="The image with personal data blacked out" width="${req.width}" height="${req.height}">${req.uncertain.map((_, i) => `<span class="uncertain u${i}"></span>`).join("")}</div>${uncertain}` +
        `<h2 class="label">Text read from the image, as the agent gets it</h2><pre>${markPseudonyms(req.text) || "<em>No text found.</em>"}</pre>` +
        form(
          missed("They are hidden in the text, blacked out where the reader found them, and you check the image again. If one stays visible, send only the text or neither."),
          `<button class="primary" name="decision" value="approved">Use the image</button>` +
            (req.uncertain.length ? `<button name="decision" value="redact-uncertain">Black out the outlined words too</button>` : "") +
            `<button name="decision" value="text-only">Use only the text</button><button name="decision" value="rejected">Use neither</button>`,
        ),
      opts.nonce,
      css,
    );
  }

  return layout(
    `Check input: ${req.title}`,
    `<h1>Check what the agent will see</h1><p class="sub">${escapeHtml(req.title)} · hidden: ${escapeHtml(describeCounts(req.counts))}</p><p>Highlighted values replace personal data. Look for names, emails, phone numbers or secrets that are still in clear.</p><pre>${markPseudonyms(req.content)}</pre>` +
      form(missed("They are hidden in this input and every later one, and you check it again."), `<button class="primary" name="decision" value="approved">Looks right</button><button name="decision" value="rejected">Don't use this input</button>`),
    opts.nonce,
  );
}

const OUTCOMES: Record<string, string> = {
  approved: "Approved.",
  "text-only": "Only the text will be used.",
  rejected: "Rejected. Nothing is used.",
  revise: "Thanks. These values are hidden now, and you will be asked to check again.",
  "redact-uncertain": "The outlined words will be blacked out, and you will be asked to check again.",
  reused: "This link works once, and it was opened again, so the request was withdrawn. Ask the agent to try again.",
  elsewhere: "Open this page from the link the agent opened for you, in the same browser.",
  expired: "This request expired.",
};

/** The page once a request is decided or gone. */
export function donePage(status: string, nonce: string): string {
  return layout("Done", `<h1>${escapeHtml(OUTCOMES[status] ?? "This request is no longer open.")}</h1><p class="sub">You can close this tab and go back to your chat.</p>`, nonce);
}

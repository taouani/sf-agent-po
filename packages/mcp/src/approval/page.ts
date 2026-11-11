// The approval page's HTML: plain forms, no script, every value escaped.

import { REQUIREMENT_PRIORITIES, VERDICT_VALUES } from "@sf-agent-po/core";
import { type ApprovalRequest, MAX_LINE, MAX_MODEL_LABEL } from "./server.js";

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
.choices { list-style: none; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 8px; }
.choices li { border-top: 1px solid var(--line); }
.choices li:first-child { border-top: 0; }
.choices label { display: flex; gap: 10px; align-items: baseline; font-weight: 400; margin: 0; padding: 8px 12px; cursor: pointer; }
.choices code { font: 13px ui-monospace, Menlo, Consolas, monospace; }
.choices .detail { color: var(--muted); font-size: 13px; }
.choices .tag { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.choices .row { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; }
.choices .row label { padding: 0; flex: 1; }
.choices .row .grow { flex: 1; }
.choices li.group { padding: 8px 12px; font-weight: 600; background: color-mix(in srgb, var(--line) 30%, transparent); }
select { font: inherit; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
input[type="text"] { width: 100%; font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
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

  if (req.kind === "scope") {
    const choices = (list: typeof req.proposed, ticked: boolean) =>
      `<ul class="choices">${list
        .map(
          (o, i) =>
            `<li><label for="o${ticked ? "p" : "s"}${i}"><input type="checkbox" id="o${ticked ? "p" : "s"}${i}" name="object" value="${escapeHtml(o.name)}"${ticked ? " checked" : ""}>` +
            `<span><code>${escapeHtml(o.name)}</code>${o.label ? ` ${escapeHtml(o.label)}` : ""}<br><span class="detail">${escapeHtml(o.detail)}</span></span></label></li>`,
        )
        .join("")}</ul>`;
    return layout(
      `Confirm scope: ${req.title}`,
      `<h1>Confirm what this work touches</h1><p class="sub">${escapeHtml(req.title)} · ${escapeHtml(req.source)}</p>` +
        (req.reason ? `<p>The agent's reasons: ${markPseudonyms(req.reason)}</p>` : "") +
        `<p>The agent looks closely at these objects, with their fields, rules, record types, and the flows, triggers, code and layouts linked to them. Untick what is not part of the work.</p>` +
        form(
          `<h2 class="label">Proposed</h2>${choices(req.proposed, true)}` +
            (req.suggested.length ? `<h2 class="label">Linked to them (tick to add)</h2>${choices(req.suggested, false)}` : "") +
            `<label for="added">Other objects (API names, separated by spaces or commas)</label><input type="text" id="added" name="added" autocomplete="off" placeholder="Account, Claim__c">` +
            `<label for="comment">Comment for the agent (optional)</label><textarea id="comment" name="comment"></textarea>`,
          `<button class="primary" name="decision" value="approved">Confirm the scope</button><button name="decision" value="rejected">Reject</button>`,
        ),
      opts.nonce,
    );
  }

  if (req.kind === "requirements") {
    const priorityNames: Record<string, string> = { must: "Must have", should: "Should have", could: "Could have", wont: "Won't have" };
    const items = req.items
      .map((it, i) => {
        const options = REQUIREMENT_PRIORITIES.map((p) => `<option value="${p}"${p === it.priority ? " selected" : ""}>${priorityNames[p]}</option>`).join("");
        const sources = it.sources.length ? ` · from ${it.sources.map(escapeHtml).join(", ")}` : "";
        return (
          `<li><div class="row"><label for="r${i}"><input type="checkbox" id="r${i}" name="item" value="${escapeHtml(it.key)}" checked>` +
          `<span>${it.id ? `<code>${escapeHtml(it.id)}</code> ` : ""}${markPseudonyms(it.statement)}<br><span class="detail"><span class="tag">${escapeHtml(it.kind)}</span> · ${escapeHtml(it.note)}${sources}</span></span></label>` +
          `<select name="priority-${escapeHtml(it.key)}" aria-label="Priority">${options}</select></div></li>`
        );
      })
      .join("");
    const warnings = req.warnings.length ? `<div class="warn"><strong>The checks found:</strong><ul>${req.warnings.map((w) => `<li>${markPseudonyms(w)}</li>`).join("")}</ul></div>` : "";
    return layout(
      `Confirm requirements: ${req.title}`,
      `<h1>Confirm the requirements</h1><p class="sub">${escapeHtml(req.title)}</p>${warnings}` +
        `<p>The design and the backlog are built on these requirements and traced back to them. Untick what is wrong or not wanted, and set each priority.</p>` +
        form(
          `<ul class="choices">${items}</ul>` +
            `<label for="added">Requirements to add (one per line)</label><textarea id="added" name="added" placeholder="The renewal letter is sent 30 days before the end date"></textarea><p class="hint">They are added as functional, must have. Ask the agent to change their type or priority later.</p>` +
            `<label for="comment">Comment for the agent (optional)</label><textarea id="comment" name="comment"></textarea>`,
          `<button class="primary" name="decision" value="approved">Confirm the requirements</button><button name="decision" value="rejected">Reject</button>`,
        ),
      opts.nonce,
    );
  }

  if (req.kind === "feedback") {
    const verdictNames: Record<string, string> = { accepted: "Accepted as written", minor: "Minor edit", major: "Major edit", rejected: "Rejected" };
    const guessNames: Record<string, string> = { unchanged: "unchanged", minor: "minor edit", major: "major edit", deleted: "deleted or not visible" };
    const stories = req.stories
      .map((st, i) => {
        const options = `<option value="">No verdict</option>${VERDICT_VALUES.map((v) => `<option value="${v}"${v === st.verdict ? " selected" : ""}>${verdictNames[v]}</option>`).join("")}`;
        const issue = st.key ? (st.url && /^https:\/\//.test(st.url) ? ` <a href="${escapeHtml(st.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(st.key)}</a>` : ` ${escapeHtml(st.key)}`) : "";
        const guess = st.guess ? `Jira diff: ${guessNames[st.guess]}${st.detail ? `, ${escapeHtml(st.detail)}` : ""}` : "Not compared with Jira yet";
        return (
          `<li><div class="row"><span class="grow"><code>${escapeHtml(st.item)}</code>${issue} ${markPseudonyms(st.summary)}<br><span class="detail">${guess}</span></span>` +
          `<select name="verdict-${i}" aria-label="Verdict on ${escapeHtml(st.item)}">${options}</select></div></li>`
        );
      })
      .join("");
    let design = "";
    const sections = req.sections
      .map((sec, i) => {
        const head = sec.design !== design ? `<li class="group">${markPseudonyms((design = sec.design))}</li>` : "";
        const options = `<option value="">Not rated</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === sec.rating ? " selected" : ""}>${n}</option>`).join("")}`;
        return (
          `${head}<li><div class="row"><span class="grow">${markPseudonyms(sec.title)}</span><select name="rating-${i}" aria-label="Rating">${options}</select></div>` +
          `<div class="row"><input type="text" name="note-${i}" maxlength="${MAX_LINE}" autocomplete="off" aria-label="Comment on ${escapeHtml(sec.title)}" placeholder="Comment (optional)"></div></li>`
        );
      })
      .join("");
    const model = req.askModel
      ? `<label for="model">Which model wrote this work?</label><input type="text" id="model" name="model" maxlength="${MAX_MODEL_LABEL}" autocomplete="off" placeholder="Opus 5.5 on Copilot"><p class="hint">Asked once for this project: the report compares models. Your host does not say which one it runs.</p>`
      : "";
    return layout(
      `Review: ${req.title}`,
      `<h1>How did this work turn out?</h1><p class="sub">${markPseudonyms(req.title)}</p>` +
        form(
          `<label for="role">Who is giving this feedback?</label><select id="role" name="role" required><option value="">Choose</option><option value="po">Product Owner</option><option value="sa">Solution Architect</option><option value="dev">Dev team</option></select>` +
            model +
            (req.stories.length
              ? `<h2 class="label">Stories</h2><p class="hint">Filled in from the Jira diff where there is no verdict yet. Major edit: more than a few words rewritten, or a criterion added or removed.</p><ul class="choices">${stories}</ul>`
              : "") +
            (req.sections.length ? `<h2 class="label">Design sections, from 1 (poor) to 5 (used as written)</h2><ul class="choices">${sections}</ul>` : "") +
            `<p class="hint">Comments are masked before they are saved.</p>`,
          `<button class="primary" name="decision" value="approved">Save the feedback</button><button name="decision" value="rejected" formnovalidate>Cancel</button>`,
        ),
      opts.nonce,
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
  saved: "Thanks. Your feedback is saved.",
  cancelled: "Cancelled. Nothing was saved.",
};

/** The page once a request is decided or gone. */
export function donePage(status: string, nonce: string): string {
  return layout("Done", `<h1>${escapeHtml(OUTCOMES[status] ?? "This request is no longer open.")}</h1><p class="sub">You can close this tab and go back to your chat.</p>`, nonce);
}

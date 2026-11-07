/**
 * Rules every agent follows. Kept as plain text so the same wording is used by
 * the MCP prompts and by the per-host agent files.
 */
export const EVIDENCE_RULES = `## Working from evidence

- Start with \`context_show\`, then \`context_read\` for the documents you need. Read every design, metadata and org document before deciding anything about the existing org.
- Cite the context documents behind each decision or requirement with their ids, for example [doc-1a2b3c4d5e].
- Never claim that an object, field, flow, class or integration exists unless a metadata or org document shows it. If no metadata or org document is in the context, say so and treat the current state as unknown.
- When the inputs conflict (for example an email and a Jira ticket disagree), do not pick silently: record the conflict as an open question, name both sources, and state the assumption you used.
- Mark every assumption as an assumption. Put every gap you cannot close as an open question with the role who can answer it (business owner, product manager, security, architect).
- Security, privacy and compliance inputs (for example from the security team) are requirements, not suggestions. Trace each one to where it is addressed.`;

export const PRIVACY_RULES = `## Personal data

- The inputs are masked: names, contact details, identifiers and secrets appear as pseudonyms such as [PERSON_1], [EMAIL_2] or [SECRET_1]. The same value always has the same pseudonym within a context.
- Write the pseudonyms exactly as they appear, brackets included, wherever you mean that person or value. Their real values are put back only when the user approves a publish; secrets are never put back.
- Do not try to work out who or what a pseudonym stands for, and do not ask the user to reveal it. Refer to people by role when the role is what matters (for example "the renewals team lead, [PERSON_3]").
- Do not write personal data in clear. What you write in clear is masked when you save, and you will be told how many values were; use the pseudonyms in later versions.`;

export const PUBLISH_RULES = `## Saving and publishing

- Save your work with the save tool before you summarise it to the user. Saving keeps a versioned draft in the context, where the other agent can read it.
- Publish only when the user asks you to in this conversation. The publish tool opens an approval page in the user's browser that shows exactly what will be written, with the real values, and writes only if they approve it there; the call waits for them. Tell the user to look at their browser.
- If the user rejects the publish or asks for changes, the tool returns their comment: revise, save the new version, and publish again when they ask.`;

export interface PromptArgs {
  /** Requirement context name, for MCP prompts. */
  context?: string;
  /** Replaces the context sentence, for host files where the user names the context when invoking. */
  contextText?: string;
  /** Industry template id, see industries.ts. */
  industry?: string;
}

export function contextText(args: PromptArgs): string {
  if (args.contextText) return args.contextText;
  const context = args.context || "default";
  return `The requirement context to work from is "${context}". Pass \`context: "${context}"\` to every tool call.`;
}

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

export const PUBLISH_RULES = `## Saving and publishing

- Save your work with the save tool before you summarise it to the user. Saving keeps a versioned draft in the context, where the other agent can read it.
- Never publish without the user's explicit go-ahead in this conversation. To publish, call the preview tool, show the user the target and title and summarise what will be written, and wait for them to approve. Only then call the publish tool with the approval token from the preview.
- If the user asks for changes after a preview, save the new version and preview again; an old token will not work.`;

export function contextLine(context: string): string {
  return `The requirement context to work from is "${context}". Pass \`context: "${context}"\` to every tool call.`;
}

// How a tool call puts a request in front of the user: the host opens the approval page
// (URL-mode elicitation) when it can, else the server opens the user's browser. The link
// never goes into a tool result, so the model cannot open it, and while the user decides the
// call reports progress, so hosts that time out idle calls keep waiting.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openInBrowser } from "./approval/browser.js";
import type { ApprovalRequest, ApprovalServer, Decision, PendingApproval } from "./approval/server.js";
import type { Reviewer } from "./inputs.js";

/** What a tool handler gets from the SDK that a review needs. */
export interface CallContext {
  signal: AbortSignal;
  requestId: string | number;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

/** How often a waiting call reports progress. */
export const PROGRESS_EVERY_MS = 10_000;

const MESSAGES: Record<ApprovalRequest["kind"], string> = {
  publish: "Approve what the agent will write, with the real values.",
  image: "Check this image before the agent sees it.",
  input: "Check what the agent will see before it uses it.",
};

/** Whether the host can open a link for the user (URL-mode elicitation). */
function hostOpensLinks(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  return Boolean(elicitation && "url" in elicitation);
}

async function openForUser(server: McpServer, pending: PendingApproval, req: ApprovalRequest, call: CallContext, open: (url: string) => Promise<boolean> | boolean): Promise<boolean> {
  if (hostOpensLinks(server)) {
    const result = await server.server.elicitInput(
      { mode: "url", message: MESSAGES[req.kind], url: pending.url, elicitationId: pending.id },
      { relatedRequestId: call.requestId, signal: call.signal, timeout: 2 ** 31 - 1 },
    );
    // Declined or dismissed: the request is withdrawn, and its decision is "expired".
    if (result.action !== "accept") pending.cancel();
    return true;
  }
  try {
    return await open(pending.url);
  } catch {
    return false;
  }
}

/**
 * A reviewer for one tool call. The request is withdrawn when the call is cancelled, and
 * the host is told when the user has decided, so it can close what it opened.
 */
export function callReviewer(
  server: McpServer,
  approval: ApprovalServer,
  call: CallContext,
  { open = (url: string) => openInBrowser(url), progressEveryMs = PROGRESS_EVERY_MS }: { open?: (url: string) => Promise<boolean> | boolean; progressEveryMs?: number } = {},
): Reviewer {
  return {
    async review(req): Promise<Decision> {
      if (call.signal.aborted) throw new Error("The call was cancelled.");
      const pending = await approval.request(req);
      const cancel = () => pending.cancel();
      call.signal.addEventListener("abort", cancel, { once: true });
      const token = call._meta?.progressToken;
      let ticks = 0;
      const timer =
        token === undefined
          ? undefined
          : setInterval(() => {
              void call
                .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++ticks, message: "Waiting for you to check it in your browser." } })
                .catch(() => {});
            }, progressEveryMs);
      try {
        let opened: boolean;
        try {
          opened = await openForUser(server, pending, req, call, open);
        } catch (err) {
          pending.cancel();
          throw err;
        }
        if (!opened) {
          pending.cancel();
          throw new Error("The approval page could not be opened in a browser on this computer, so nothing was added.");
        }
        const decision = await pending.decision;
        if (hostOpensLinks(server)) await server.server.createElicitationCompletionNotifier(pending.id)().catch(() => {});
        return decision;
      } finally {
        if (timer) clearInterval(timer);
        call.signal.removeEventListener("abort", cancel);
      }
    },
  };
}

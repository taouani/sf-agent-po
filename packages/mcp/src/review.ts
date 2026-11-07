// How a tool call puts a request in front of the user: the server opens the approval page in
// the user's browser itself. The link is never handed to the host (no URL-mode elicitation):
// whoever opens it first can decide, and a host may show it where the model can read it, so
// it goes only to the browser. While the call works or waits it reports progress, so hosts
// that time out idle calls keep waiting.

import { openInBrowser } from "./approval/browser.js";
import type { ApprovalServer, Decision } from "./approval/server.js";
import type { Reviewer } from "./inputs.js";

/** What a tool handler gets from the SDK that a review needs. */
export interface CallContext {
  signal: AbortSignal;
  requestId: string | number;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

/** How often a call reports progress. */
export const PROGRESS_EVERY_MS = 10_000;

/** Progress reports for one call, when the host asked for them; `say` changes what they say. */
export interface Progress {
  say(message: string): void;
  stop(): void;
}

export function startProgress(call: CallContext, everyMs = PROGRESS_EVERY_MS): Progress {
  const token = call._meta?.progressToken;
  let message = "Working on it.";
  if (token === undefined) return { say: () => {}, stop: () => {} };
  let ticks = 0;
  const timer = setInterval(() => {
    void call.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++ticks, message } }).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return {
    say: (m) => {
      message = m;
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * A reviewer for one tool call: opens the page in the browser and waits for the user. The
 * request is withdrawn when the call is cancelled or the browser cannot be opened.
 */
export function callReviewer(
  approval: ApprovalServer,
  call: CallContext,
  { open = (url: string) => openInBrowser(url), progress }: { open?: (url: string) => Promise<boolean> | boolean; progress?: Progress } = {},
): Reviewer {
  return {
    async review(req): Promise<Decision> {
      if (call.signal.aborted) throw new Error("The call was cancelled.");
      const pending = await approval.request(req);
      const cancel = () => pending.cancel();
      call.signal.addEventListener("abort", cancel, { once: true });
      try {
        let opened = false;
        try {
          opened = await open(pending.url);
        } catch {
          opened = false;
        }
        if (!opened) {
          pending.cancel();
          throw new Error("The approval page could not be opened in a browser on this computer, so nothing was added.");
        }
        progress?.say("Waiting for you to check it in your browser.");
        return await pending.decision;
      } finally {
        progress?.say("Working on it.");
        call.signal.removeEventListener("abort", cancel);
      }
    },
  };
}

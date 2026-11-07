// The approval page in a real browser (Chromium through Playwright): the form must post the
// way browsers post it, which hand-written requests in approval.test.ts cannot prove.
// Runs when SF_AGENT_PO_BROWSER_TEST is set (CI installs Chromium for it on Linux).

import { describe, expect, it } from "vitest";
import { ApprovalServer } from "../src/index.js";

describe.runIf(process.env.SF_AGENT_PO_BROWSER_TEST)("approval page in Chromium", { timeout: 60_000 }, () => {
  it("approves through the page's own button, shows the image and its outlines, and refuses a second tab", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch();
    const server = new ApprovalServer();
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEElEQVR4nGP4z8DAwMDAAAAPAgEA5d1gPQAAAABJRU5ErkJggg==",
        "base64",
      );
      const pending = await server.request({ kind: "image", title: "Shot", image: png, width: 200, height: 100, text: "[PERSON_1]", trusted: true, uncertain: [{ x0: 20, y0: 10, x1: 60, y1: 30 }] });
      const page = await browser.newPage();
      const problems: string[] = [];
      page.on("console", (m) => problems.push(m.text()));
      await page.goto(pending.url);
      expect(new URL(page.url()).search).toBe("");
      expect(await page.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);
      const box = await page.locator(".uncertain").boundingBox();
      const figure = await page.locator(".figure img").boundingBox();
      expect(Math.round((box!.x - figure!.x) / figure!.width * 100)).toBe(10);
      // A second tab of the same link withdraws the request.
      const other = await (await browser.newContext()).newPage();
      await other.goto(pending.url);
      expect(await other.content()).toContain("works once");
      expect((await pending.decision).status).toBe("expired");

      const second = await server.request({ kind: "publish", target: "Jira ACME-1", title: "Story", body: "As Sarah Whitfield" });
      await page.goto(second.url);
      await page.fill("#comment", "Looks good");
      await page.click("button[value=approved]");
      await page.waitForLoadState();
      expect(await page.content()).toContain("Approved.");
      expect(await second.decision).toMatchObject({ status: "approved", comment: "Looks good" });
      expect(problems.filter((p) => /Content Security Policy|Refused/i.test(p))).toEqual([]);
    } finally {
      await server.close();
      await browser.close();
    }
  });
});

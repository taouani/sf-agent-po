#!/usr/bin/env node
// The "browser" of an evaluation run: the v1 server starts it with an approval page's address
// (SF_AGENT_PO_BROWSER), and it hands the address to the runner (SF_AGENT_EVAL_APPROVER), which
// answers the page. It never prints the address.

const [url] = process.argv.slice(2);
const hook = process.env.SF_AGENT_EVAL_APPROVER;
if (!url || !hook || !/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/.test(hook)) process.exit(2);
const res = await fetch(hook, { method: "POST", body: url }).catch(() => undefined);
process.exit(res?.status === 204 ? 0 : 1);

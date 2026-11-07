# Phase 0 spikes

Throwaway experiments that answer the technical questions the v1 plan depends on, before
any v1 code is written. Nothing here ships; the folder is removed once the answers are recorded
in the plan.

| Spike | Question | How it runs |
| --- | --- | --- |
| 1. PII detection (`pii/`) | Can rules, a dictionary and a local multilingual model find personal data and secrets in English, French and Chinese well enough to mask before any model sees them? | GitHub Actions (needs huggingface.co) |
| 2. Image redaction (`ocr/`) | Can we OCR an image locally, black out what detection finds, with language data from npm only, on all three OSes? | Locally and in GitHub Actions |
| 3. SQLite (`sqlite/`) | `node:sqlite` or `better-sqlite3`: FTS5 (including Chinese), JSON, several processes writing, speed on a 10,000-component index? | Locally and in GitHub Actions |
| 4. Host checks (`host-kit/`) | Do Copilot, Cursor and Claude Code show images from tools, support elicitation and survive a long approval wait? Does the Confluence draw.io app render a diagram we create through the API? | By hand, see `host-kit/README.md` |
| 5. Model licence | May we redistribute the detection model and use it commercially? | Part of spike 1 |
| 6. Model runtime (`runtime/`) | Can the detection model run on the WebAssembly build of ONNX Runtime instead of the native one (about 550 MB per install), with the same results and acceptable speed? | GitHub Actions (needs huggingface.co) |

## Running locally

```bash
cd spikes
npm ci
npm run typecheck && npm run check   # rule and alignment checks, no network
npm run sqlite                        # spike 3
npm run ocr                           # spike 2
npm run pii                           # spike 1, needs huggingface.co
npm run runtime                       # spike 6, needs huggingface.co and the npm registry
```

Reports are written to `spikes/out/` (ignored by git). In GitHub Actions they appear in the
job summary and as a downloadable artifact named `spike-results-<os>`.

## Test data

All names, addresses, numbers and secrets in the datasets and images are invented. The OCR
images and their ground-truth masks are rendered by `ocr/make-fixtures.ts` and committed, so
every OS reads the same pixels.

# Working on sf-agent-po

## Pull requests

- Every time you create a pull request, start a separate agent to review its code before reporting the PR as ready. Verify each finding, fix the real ones on the PR branch, and summarise what the review found and what changed.

## Checks

Run these before every push:

```bash
npm run typecheck
npm test
```

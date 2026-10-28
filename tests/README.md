# Tests

Tests are grouped by feature. Browser, camera, file/source, saving, signaling, security and transfer regressions live in their corresponding directories. `fixtures.ts` scopes local rate limits only when a browser context is actually needed; pure Worker/protocol checks do not launch a browser.

| Command | Scope |
| --- | --- |
| `npm test` | Chromium regression suite; excludes performance and built-site-specific suites |
| `npm run test:webkit` | Selected WebKit compatibility/regression scenarios |
| `npm run test:headers` | Built-site response policy and local Worker |
| `npm run test:site` | Pinned production / test separation |
| `npm run bench:transfer` | Explicit transfer benchmark |
| `npm run bench:latency` | Explicit delayed-receipt benchmark |

The root `playwright.config.ts` defines shared defaults; specialized configs live in `config/`. Existing npm commands are unchanged. For a focused run, pass a feature path or a test title, for example:

```sh
npx playwright test tests/transfer/connection-diagnostics.spec.ts
npx playwright test tests/files/source-files.spec.ts
```

`performance/` is excluded from ordinary regression discovery. Its timings are controlled local comparisons, not public-network throughput guarantees; see [measurement guidance](../docs/performance.md). Keep reports in ignored `test-results/` or outside the repository. `fixtures/download-preview.mp4` is a small generated playback fixture, not a received user file.

Regression counts may grow with real bugs. Preserve distinct authentication, file-integrity, recovery and storage boundaries; merge cases by component rather than creating a new dated review file. One-off prototypes and archived result JSON are recovered through Git history.

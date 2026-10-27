# Browser test configurations

The default configuration stays at `playwright.config.ts` in the repository root. It defines the shared browser settings, absolute test/output paths and local server working directories.

Specialized configurations live here and inherit those defaults:

| Command | Configuration | Purpose |
| --- | --- | --- |
| `npm test` | `../../playwright.config.ts` | Main Chromium regression suite |
| `npm run test:webkit` | `webkit.config.ts` | WebKit compatibility checks |
| `npm run test:headers` | `headers.config.ts` | Built-site headers and local Worker |
| `npm run test:site` | `site.config.ts` | Production/test site separation |
| `npm run bench:transfer` | `benchmark.config.ts` | Transfer benchmark |
| `npm run bench:latency` | `latency.config.ts` | Delayed-receipt benchmark |

Benchmarks remain opt-in. Their local timings are not guarantees of real network throughput. Temporary reports go to ignored output directories or an explicitly selected local path.

# Development & deployment

[← Project home](../README.en.md) · [简体中文](development.md)

The Vite + TypeScript frontend runs on Cloudflare Pages. A Worker with Durable Objects handles pairing messages; STUN helps discover connection addresses. Files travel directly between browsers over WebRTC first; TURN is a fallback for failed connections or sustained low speed with a long ETA. See [relay details](turn-fallback.md).

## Local development

Requires Node.js 22.12 or later.

```sh
npm ci
npm run dev
# Start the signaling service in another terminal
npm run signal:dev
```

Enter `http://127.0.0.1:8787` in the webpage's connection settings. Leave it empty to use manual pairing. Edit `public/app.config.json` to set deployment defaults. The default STUN server is `stun:stun.cloudflare.com:3478`; it does not relay files.

## Deploy your own instance

1. Fork the repository and import it into Cloudflare Pages. Use production branch `main`, build command `npm run build`, output directory `dist`, and Node.js 22.12 or a newer 22.x release. Connect your custom domain and verify HTTPS. Replace the production hostname in `public/_headers` with your own hostname. Cloudflare builds and publishes updates to `main`; GitHub Actions runs the checks separately and no longer publishes GitHub Pages. Complete local verification before pushing to the production branch.
2. Edit the Worker name and `ALLOWED_ORIGINS` in `signal/wrangler.jsonc`, using your frontend's origin. The default deployment allows only the production custom origin and two local development origins; Cloudflare preview hostnames cannot use the production signaling service by default. Replace the custom domain in `routes` with your own active Cloudflare domain. Only the custom domain is exposed by default. To use only `workers.dev`, remove `routes` and set `workers_dev` to `true`.
3. Run `npx wrangler login`. Create a free Turnstile widget restricted to your frontend hostname, replace `TURNSTILE_SITE_KEY`, and store its server secret using `npx wrangler secret put TURNSTILE_SECRET_KEY --config signal/wrangler.jsonc`. Never commit the secret. Then run `npm run signal:deploy`. Durable Objects use SQLite storage, which your account must support. Usage limits and charges depend on your Cloudflare account.
4. Set `signalUrl` in `public/app.config.json` to the Worker's returned HTTPS URL, then commit and publish. Worker updates must be deployed separately. Access tokens are not stored in the repository.

## Run checks

On first visit, the browser's language priority list selects Chinese or English, with English as the fallback. An explicit choice made with the language switch is saved and takes priority. Automatic detection does not save an override, so later visits can follow changed browser preferences. Additional languages need matching interface text, errors, saving instructions and small-screen layout checks. Ordinary regressions explicitly use a Chinese locale; language tests cover other preferences independently of the test machine's defaults.

The full test suite also requires Python 3 to verify folder ZIP contents and checksums with an independent standard-library reader. The application and build do not require Python.

```sh
npm run build
npx playwright install --with-deps chromium webkit
npm run signal:check
npm run test:headers
npm run test:webkit
npm test
```

Verify locally before pushing a production branch. The frontend and signaling service are deployed separately; a frontend update does not deploy the Worker. GitHub Actions checks and Cloudflare Pages builds run independently.

## Connection troubleshooting

Refresh both pages, create a new link, keep the sending page open and leave the phone unlocked. First try the same Wi-Fi with both VPNs off, then compare. Sharing Wi-Fi does not guarantee a direct connection: a VPN must still allow local networking and WebRTC / UDP.

Automatic recovery needs the original pages and session, a reachable signaling service, an unexpired room and a direct path through the new networks. Recovery time and speed are not guaranteed. Manual pairing does not reconnect automatically.

## Further reading

The following engineering notes are in Chinese:

- [Saving and large files](safari-storage.md): browser quota, temporary disk storage, duplicate space and test limits.
- [Security](security-hardening.md) and [web security headers](web-security-headers.md): credentials, rate limits, Turnstile, CSP and custom domains.
- [Background recovery](background-sharing.md): wake locks, suspension and recovery limits.
- [All engineering notes](README.md).

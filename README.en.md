# 🍕 PizzaSend · File transfer

[![阅读简体中文版](docs/assets/language-chinese.svg)](README.md) · **English**

Open a webpage and send files directly to another device. An independent implementation inspired by [FilePizza](https://github.com/kern/filepizza).

**Try it: [tatsuhiroc.github.io/pizza-send](https://tatsuhiroc.github.io/pizza-send/)**

Choose files → Create a transfer → Share the link or QR code → The recipient confirms reception and saves the files. Keep both pages open.

## Features

- Multiple files, shareable links, and QR codes; up to 100 files per transfer.
- Compact share links carry one 43-character secret instead of three random fields. The default URL shrinks from about 241 to 86 characters; older links remain supported.
- The receiving page scans QR codes using the rear camera or an image. Decoding stays on this device. The camera stops after recognition, when the dialog closes, or when the page goes into the background. No microphone access is requested.
- Direct file transfer over an ordered, reliable WebRTC DataChannel with DTLS encryption.
- 32 KiB chunks, with flow control based on both the send buffer and receiver acknowledgments. Progress updates reflect what the receiver has acknowledged.
- Incremental SHA-256 verification; a file is marked complete only after its integrity has been verified.
- Stream files directly to disk after choosing a file or folder in desktop Chrome / Edge. Safari and other browsers with the required capabilities use a Worker to write chunks into local disk storage, then offer Save buttons. Capacity depends on device space and browser quota; there is no application-wide 20 GiB cap. Browsers without disk storage retain the 256 MiB total memory limit.
- Verified temporary files can be saved again after reopening or refreshing the site. One “Saved · clear all temporary files” button clears all received temporary files after confirming their count and total size, while keeping downloaded copies. Saving can require space for two copies. Complete temporary files remain until the user clears them or the browser removes website data or reclaims space; closing the page does not immediately free their space, and there is no fixed automatic deletion timer.
- Cancellation and failures clear unfinished temporary files while keeping earlier verified files. Abandoned partial files are cleared on the next visit. Cross-page locks protect another page’s active files. Unfinished transfers still cannot resume after a refresh.
- Folder reception avoids existing file and directory names. Retrying a failed save-location selection uses only the newly selected locations.
- Automatic pairing incrementally exchanges connection addresses (Trickle ICE), including late candidates, and distinguishes sender availability, direct-path discovery, occupied links, and expired sessions.
- Automatic pairing reconnects after network changes and resumes from the receiver’s confirmed position, preserving verification and the save location. Both pages must stay open.
- Manual pairing by copying connection codes, without a signaling service. Automatic reconnection is not supported in manual mode.
- Instant Chinese / English switching with a saved language preference; desktop and mobile layouts, with no third-party fonts or analytics scripts.

## Deployment architecture

The frontend is a static Vite + TypeScript website hosted on GitHub Pages. A Cloudflare Worker with Durable Objects forwards pairing messages only, while STUN helps discover connection addresses. **File contents are never transferred through or stored by the signaling service. There is no TURN file relay.**

Automatic pairing encrypts SDP information with an AES-256-GCM key generated in the browser. The key is stored in the share URL's `#` fragment and is not sent to the static website or signaling service in HTTP requests. The receiving page clears the fragment from the address bar after reading it. The signaling service can see the room, roles, connection times, network addresses, and encrypted message sizes. Room role tokens are stored as SHA-256 digests. Initial pairing invitations expire after 30 minutes and accept only one receiver at a time. Explicitly ending a transfer closes the room. Unexpected signaling disconnections preserve the room so the same browser session can reconnect until it expires.

In v0.2, initial pairing invitations still expire after 30 minutes. Once both browser sessions are bound, authenticated heartbeats renew recovery access for roughly 30 minutes after the latest renewal, capped at 24 hours from room creation. Renewal never admits a new recipient through an expired invitation or reopens an ended room.

Compact links use `#2.<43 characters>`. The fragment retains a full 256-bit random secret. Distinct HKDF-SHA-256 labels derive the room ID and receiver credential in the browser; room creation sends only the room ID and the SHA-256 digest of that credential. The secret is not submitted or stored on the server, and no URL-shortening redirect service is needed.

Anyone with the share link can receive the files, so share it through a trusted channel. Manual pairing codes contain network connection information and should also be kept private. Users still need to trust the website's code and publisher; this product has not undergone an independent security audit.

The initial release cannot guarantee a direct connection between every pair of networks. Symmetric NAT, UDP restrictions, corporate networks, VPN routing, and regional access restrictions can affect connectivity. Try the same Wi-Fi network first. Failed connections show an error; there is no relay fallback. With automatic pairing, network changes or temporary disconnections trigger address discovery and a new encrypted direct connection, then resume from the byte position already written by the receiver. Recovery waits up to two minutes. Completed files are skipped, and the current file’s disk stream or memory data and SHA-256 state are preserved. The whole file is still verified on completion. Recovery requires an accessible signaling service, an unexpired room, and a direct path through the new networks; recovery time and route speed are not guaranteed. Closing or refreshing a page, or having the browser discard it, loses the session. Locking a phone may cause this. Manual pairing does not reconnect automatically.

For troubleshooting, refresh both pages and create a new link. Keep the sending page visible and the phone unlocked. Sharing Wi-Fi does not guarantee connectivity with a VPN; the VPN must permit local networking and WebRTC / UDP. First test with both VPNs off, then compare. Explicitly leaving before accepting files releases the recipient slot. Unexpected network loss retains it for the original session to recover. Once transfer has begun, changing recipients requires a new link.

## Local development

Requires Node.js 22 or later.

```sh
npm ci
npm run dev
# Start the signaling service in another terminal
npm run signal:dev
```

Enter `http://127.0.0.1:8787` in the webpage's connection settings. Leave it empty to use manual pairing. Edit `public/app.config.json` to set deployment defaults. The default STUN server is `stun:stun.cloudflare.com:3478`; it does not relay files.

## Deploy your own instance

1. Fork the repository. In GitHub Settings → Pages, set Source to GitHub Actions. Updates to `main` are verified before `dist` is automatically published.
2. Edit the Worker name and `ALLOWED_ORIGINS` in `signal/wrangler.jsonc`, using your frontend's origin. The default deployment allows the current GitHub Pages origin and two local development origins.
3. Run `npx wrangler login`, then `npm run signal:deploy`. Durable Objects use SQLite storage, which your account must support. Usage limits and charges depend on your Cloudflare account.
4. Set `signalUrl` in `public/app.config.json` to the Worker's returned HTTPS URL, then commit and publish. Worker updates must be deployed separately. Access tokens are not stored in the repository.

## Verification

```sh
npm run build
npx playwright install --with-deps chromium
npm test
npm run signal:check
```

Browser tests cover automatic and manual pairing over real DataChannels, 20 MiB multi-file downloads with independent SHA-256 verification, empty files, Chinese filenames, rejection of corrupted files, cancellation, origin restrictions, encrypted-message tampering, and responsive layouts. Large-file tests write 200 MiB and 1 GiB files to real browser OPFS disk streams, then read them back and independently verify them. This replaces the native save dialog in tests; it does not automate the system save dialog.

Tests use virtual media devices only in isolated browsers to expose local ICE interfaces and verify video scanning. The application requests camera access only after the user clicks the scan button and does not access the microphone. Transfer times measured by automated tests on one machine do not represent cross-device or internet performance and do not demonstrate a speed improvement over FilePizza.

Recovery tests cover repeated connection interruptions, simultaneous signaling disconnections, retained disk streams, a lost completion receipt, invalid resume positions, corruption after recovery, and cancellation during recovery. These force real connections to close in isolated browsers; actual VPN switching and cross-network recovery have not yet been verified.

See the [initial release validation record](docs/validation.md) (in Chinese) for detailed results.

The v0.2 44-test suite also covers 512 MiB reception through the production OPFS Worker and actual export, reopening verified files, duplicate names, empty files, confirmation-based cleanup, preserved downloads, cross-page protection, abandoned partials, quota retry, write failures, and preservation of earlier verified files when a later file fails. Full-file ArrayBuffer conversion is forbidden in the 512 MiB receiving page; exported content is independently hashed.

Actual macOS Safari 27.0.1 received 512 MiB through the production flow using the deployed Cloudflare signaling service. The file remained available after refreshing; its downloaded SHA-256 matched, and clearing temporary storage kept the download. The production storage module also passed 10 GiB / 20 GiB write and actual export checks in isolated WebKit; those capacity tests do not use WebRTC. Earlier standalone Mac Safari 2 GiB / 20 GiB results remain documented separately. **Large-file reception and export on an actual iPhone have not yet been verified; 20 GiB reception is not promised for every phone.** See the [v0.2 validation record](docs/safari-storage.md) (in Chinese).

## Future work

Speed tests across real devices and different networks, actual VPN switching, connection-failure diagnostics, persistent resumption after page refreshes, a PWA offline shell, and performance optimizations guided by measurements. Keep file transfers direct; never silently upload files when a connection fails.

MIT License.

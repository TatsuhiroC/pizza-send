<p align="right">
  <a href="README.md"><img src="docs/assets/language-chinese.svg" alt="简体中文" width="86" height="26" /></a> &nbsp; English
</p>

<div align="center">
  <img src="docs/assets/readme-cover.svg" alt="PizzaSend — Good things, sent directly." width="960" />
  <h3>Fresh files. Straight to you.</h3>
  <p>No installs. No accounts. Share on the same Wi-Fi, or between home broadband and a phone on 5G.</p>
  <p><a href="https://pizzasend.dpdns.org/"><img src="docs/assets/open-pizzasend-en.svg" alt="Open PizzaSend" width="174" height="40" /></a></p>
  <p><sub>Across networks · WebRTC direct · End-to-end encrypted relay · Open source</sub></p>
</div>

## Good things, sent directly

PizzaSend is an open-source file transfer tool for your browser. Move photos, videos and documents between a phone and a computer, or share the same files with friends. A link or QR code connects you, without uploading to cloud storage first.

**You don't need to share a Wi-Fi network.** Transfer between different Wi-Fi networks, or between a computer on home broadband and a phone on 4G or 5G. PizzaSend tries a direct connection first, with an end-to-end encrypted relay available when direct connections fail or remain too slow.

<table width="100%">
  <thead><tr><th align="left">Feature</th><th align="left">What you get</th></tr></thead>
  <tbody>
    <tr><td><strong>Across networks</strong></td><td>Share on the same LAN, across different Wi-Fi networks, or between broadband and mobile data.</td></tr>
    <tr><td><strong>Encrypted</strong></td><td>Direct first, encrypted relay when needed. No server file storage.</td></tr>
    <tr><td><strong>Original</strong></td><td>Names and bytes stay intact, checked with SHA-256.</td></tr>
    <tr><td><strong>Together</strong></td><td>One link, up to 10 people, each with their own progress.</td></tr>
  </tbody>
</table>

Share files. Drop a folder on a computer to package it as a ZIP. Pair by QR. Recover after network changes. On slow links, compression is suggested when it should save time.

## Three steps

1. **Pick your files.** Click to choose files, or drop a folder on a computer. Folders become ZIPs; extract them after receiving.
2. **Pass it on.** Send the link or let the other person scan the QR code.
3. **Save to the device.** They accept the transfer, then follow the save prompt.

## Behind the transfer

- **Direct first, with another route across networks.** Cloudflare helps peers connect, with connection information encrypted in the browser using AES-256-GCM. Files prefer DTLS-protected WebRTC. If direct connections fail or remain too slow, a [WebSocket encrypted relay](docs/stream-relay.md) can carry the transfer: the browser encrypts the data, the server forwards only ciphertext, and the recipient decrypts and verifies it. Files are not retained on the server, and the relay never receives the encryption key.
- **Write as you receive.** Browsers with disk support save chunks and verify them with incremental SHA-256, reducing memory pressure for large files. Receivers prefer WebAssembly for hashing, with an automatic JavaScript fallback.
- **Adapt to the connection.** Receiver feedback adjusts the sending window; automatic pairing can resume from confirmed progress after a disconnect. Slow-link compression estimates include compression and decompression time. It is offered only when worthwhile and restores the original files on receipt.

## Before you send

- **Keep both pages open.** Automatic pairing can reconnect; refreshing or closing loses unfinished transfers. Phone locking may interrupt them.
- **Save what you receive.** Browser copies have a ten-minute expiry and may be reclaimed sooner. Your downloaded copies stay.
- **Size depends on the receiver.** Space and browser quota set the limit. Without disk storage, total reception is capped at 256 MiB.
- **Choose your route; speed depends on the network.** When an established direct connection remains too slow, PizzaSend probes the fallback and switches automatically only when it expects a meaningful benefit. You can also select direct or encrypted relay manually. Cross-network support does not guarantee connectivity or a fixed speed on every network. Links grant access: share them only with people you trust.

## A little more

[Develop & deploy](docs/development.en.md) &nbsp; · &nbsp; [Security design](docs/security-hardening.md) &nbsp; · &nbsp; [Engineering notes](docs/README.md) &nbsp; · &nbsp; [MIT License](LICENSE)

<sub>Most engineering notes are in Chinese.</sub>

---

<p align="center"><sub>Inspired by <a href="https://github.com/kern/filepizza">FilePizza</a>. Independently built.<br>A little pizza spirit. A direct connection.</sub></p>

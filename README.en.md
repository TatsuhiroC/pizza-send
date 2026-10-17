<p align="right">
  <a href="README.md"><img src="docs/assets/language-chinese.svg" alt="简体中文" width="86" height="26" /></a> &nbsp; English
</p>

<div align="center">
  <img src="docs/assets/readme-cover.svg" alt="PizzaSend — Good things, sent directly." width="960" />
  <h3>Fresh files. Straight to you.</h3>
  <p>No installs. No accounts. Open a page and send files to another device.</p>
  <p><a href="https://pizzasend.dpdns.org/"><img src="docs/assets/open-pizzasend-en.svg" alt="Open PizzaSend" width="174" height="40" /></a></p>
  <p><sub>WebRTC · DTLS · SHA-256 · Open source</sub></p>
</div>

## Good things, sent directly

<table width="100%">
  <thead><tr><th align="left">Feature</th><th align="left">What you get</th></tr></thead>
  <tbody>
    <tr><td><strong>Direct</strong></td><td>DTLS over WebRTC. Files stay off the pairing server.</td></tr>
    <tr><td><strong>Original</strong></td><td>Names and bytes stay intact, checked with SHA-256.</td></tr>
    <tr><td><strong>Together</strong></td><td>One link, up to 10 people, each with their own progress.</td></tr>
  </tbody>
</table>

Share files or folders. Pair by QR. Recover after network changes. On slow links, compression is suggested when it should save time.

## Three steps

1. **Pick your files.** Add files or folders, up to 100 files per share.
2. **Pass it on.** Send the link or let the other person scan the QR code.
3. **Save to the device.** They accept the transfer, then follow the save prompt.

## Before you send

- **Keep both pages open.** Automatic pairing can reconnect; refreshing or closing loses unfinished transfers. Phone locking may interrupt them.
- **Save what you receive.** Browser copies have a ten-minute expiry and may be reclaimed sooner. Your downloaded copies stay.
- **Size depends on the receiver.** Space and browser quota set the limit. Without disk storage, total reception is capped at 256 MiB.
- **Some networks cannot connect.** There is no relay fallback. Links grant access: share them only with people you trust.

## A little more

[Develop & deploy](docs/development.en.md) &nbsp; · &nbsp; [Security design](docs/security-hardening.md) &nbsp; · &nbsp; [Engineering notes](docs/README.md) &nbsp; · &nbsp; [MIT License](LICENSE)

<sub>Most engineering notes are in Chinese.</sub>

---

<p align="center"><sub>Inspired by <a href="https://github.com/kern/filepizza">FilePizza</a>. Independently built.<br>A little pizza spirit. A direct connection.</sub></p>

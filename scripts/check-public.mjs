import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A small, dependency-free guard against common accidental disclosures.
// It does not certify that arbitrary credentials or Git history are safe.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const sensitiveName = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|id_(?:rsa|ed25519)|credentials|[^/]+\.(?:pem|key|p12|pfx))$/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['literal-secret', /(?:api[_-]?token|api[_-]?key|secret[_-]?key|private[_-]?key|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i],
  ['personal-home-path', /(?:\/Users\/|\/home\/)[^/\s"'<>]+/]
];
const findings = [];
for (const file of files) {
  if (sensitiveName.test(file)) findings.push(`${file}: sensitive filename`);
  const bytes = readFileSync(new URL(file, new URL('../', import.meta.url)));
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  for (let line = 0; line < lines.length; line++) {
    for (const [name, pattern] of rules) {
      // Never print matched values, even in failed CI logs.
      if (pattern.test(lines[line])) findings.push(`${file}:${line + 1}: ${name}`);
    }
  }
}
if (findings.length) {
  console.error('Review possible private data before publishing:\n' + findings.join('\n'));
  process.exitCode = 1;
} else console.log(`Public-file checks passed (${files.length} tracked files).`);

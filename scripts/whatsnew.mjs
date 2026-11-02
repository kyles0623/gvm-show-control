#!/usr/bin/env node
// Builds web/whatsnew.js (the app's "What's new" dialog) from CHANGELOG.md: one entry per released version, newest
// first, with its Added / Changed / Fixed notes as plain text. Run by the pre-commit hook after the version bump;
// run by hand with:  node scripts/whatsnew.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_VERSIONS = 15;

/** Markdown inline → plain text: **bold**, `code`, [text](url) → text. */
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();

export function parseChangelog(md) {
  const versions = [];
  let v = null, sec = null, item = null;
  const flush = () => { if (item && sec) sec.items.push(item); item = null; };
  for (const line of md.split('\n')) {
    const h2 = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
    if (h2) {
      flush();
      v = h2[1] === 'Unreleased' ? null : { version: h2[1], date: h2[2] ?? '', sections: [] };
      if (v) versions.push(v);
      sec = null;
      continue;
    }
    if (!v) continue;
    const h3 = /^### (.+)/.exec(line);
    if (h3) { flush(); sec = { type: h3[1].trim(), items: [] }; v.sections.push(sec); continue; }
    if (!sec) continue;
    const li = /^- (.*)/.exec(line);
    if (li) {
      flush();
      // "**Title** rest" → title + text; otherwise all text.
      const m = /^\*\*([^*]+)\*\*[:.]?\s*(.*)$/.exec(li[1]);
      item = m ? { title: plain(m[1]), text: m[2] } : { title: '', text: li[1] };
      continue;
    }
    if (item && /^\s+\S/.test(line)) { item.text += ' ' + line.trim(); continue; }
    if (!line.trim()) flush();
  }
  flush();
  for (const ver of versions) {
    for (const s of ver.sections) for (const it of s.items) it.text = plain(it.text);
    ver.sections = ver.sections.filter((s) => s.items.length);
  }
  return versions.filter((x) => x.sections.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versions = parseChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).slice(0, MAX_VERSIONS);
  const out = `// Generated from CHANGELOG.md by scripts/whatsnew.mjs (the commit hook runs it). Don't edit by hand.
// "What's new": released versions, newest first; each with its Added / Changed / Fixed notes.
export const VERSIONS = ${JSON.stringify(versions, null, 1)};
`;
  writeFileSync(join(root, 'web', 'whatsnew.js'), out);
  console.log(`whatsnew.js: ${versions.length} versions (${versions[0]?.version ?? 'none'} … ${versions.at(-1)?.version ?? ''})`);
}

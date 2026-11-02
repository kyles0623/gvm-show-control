import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog } from '../scripts/whatsnew.mjs';

test('changelog → versions, newest first, notes grouped, Unreleased left out', () => {
  const md = `# Changelog\n\n## [Unreleased]\n- not yet\n\n## [1.2.0] - 2026-11-02\n\n### Added\n- **Presets** (Shift+1–9): a look per\n  light by \`name\`.\n- plain note\n\n### Fixed\n- **Cop Car**: red now\n\n## [1.1.0] - 2026-11-01\n\n### Changed\n- [link](http://x) text\n`;
  const v = parseChangelog(md);
  assert.deepEqual(v.map((x) => x.version), ['1.2.0', '1.1.0']);
  assert.equal(v[0].date, '2026-11-02');
  assert.deepEqual(v[0].sections.map((s) => s.type), ['Added', 'Fixed']);
  assert.deepEqual(v[0].sections[0].items[0], { title: 'Presets', text: '(Shift+1–9): a look per light by name.' });
  assert.deepEqual(v[0].sections[0].items[1], { title: '', text: 'plain note' });
  assert.deepEqual(v[0].sections[1].items[0], { title: 'Cop Car', text: 'red now' });
  assert.equal(v[1].sections[0].items[0].text, 'link text');
});

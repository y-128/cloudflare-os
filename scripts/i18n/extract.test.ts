import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractTranslations, parseDiff } from './extract.ts'

const FILE = 'packages/example/src/Labels.tsx'

/** Builds a real unified change hunk around complete TSX source for extraction tests. */
function extract(before: string, after: string) {
  const removed = before.split('\n')
  const added = after.split('\n')
  const diff = [
    `diff --git a/${FILE} b/${FILE}`,
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ].join('\n')
  return extractTranslations(parseDiff(diff), new Map([[FILE, { before, after }]]))
}

test('extracts multiple literals, JSX text and entities with deterministic collision suffixes', () => {
  const result = extract(
    'const labels = ["Open", "Open", "unchanged"];\nconst view = <p title="Help &amp; support">Help &amp; support</p>;',
    'const labels = ["開く", "開く", "unchanged"];\nconst view = <p title="ヘルプとサポート">ヘルプとサポート</p>;',
  )
  assert.deepEqual(result.pairs.map(pair => [pair.key, pair.en, pair.ja]), [
    ['example.Labels.open', 'Open', '開く'],
    ['example.Labels.open_2', 'Open', '開く'],
    ['example.Labels.help_support', 'Help & support', 'ヘルプとサポート'],
    ['example.Labels.help_support_2', 'Help & support', 'ヘルプとサポート'],
  ])
  assert.equal(result.unmatched.length, 0)
})

test('rejects code edits and mixed non-translation replacements without partial extraction', () => {
  for (const [before, after] of [
    ['const a = "Open";', 'const b = "開く";'],
    ['const a = ["Open", "internal"];', 'const a = ["開く", "renamed"];'],
    ['// "Open"', '// "開く"'],
    ['const regex = /"Open"/;', 'const regex = /"開く"/;'],
    ['const label = `Open ${name}`;', 'const label = `${name}を開く`;'],
  ]) {
    const result = extract(before, after)
    assert.equal(result.pairs.length, 0, before)
    assert.deepEqual(result.unmatched.map(line => line.side), ['removed', 'added'])
  }
})

test('decodes escaped string literals without executing their contents', () => {
  const result = extract('const label = "Say \\"Hello\\"\\nNext";', 'const label = "「こんにちは」と言う\\n次へ";')
  assert.equal(result.pairs[0]?.en, 'Say "Hello"\nNext')
  assert.equal(result.pairs[0]?.ja, '「こんにちは」と言う\n次へ')
})

test('does not realign insertions by guessing and reports every changed line', () => {
  const result = extract('const a = "Open";\nconst b = "Close";', 'const extra = true;\nconst a = "開く";\nconst b = "閉じる";')
  assert.equal(result.pairs.length, 0)
  assert.equal(result.unmatched.filter(line => line.side === 'removed').length, 2)
  assert.equal(result.unmatched.filter(line => line.side === 'added').length, 3)
  assert.equal(result.unmatched.at(-1)?.line, 3)
})

test('tracks old/new coordinates, context boundaries, and source lines beginning with diff markers', () => {
  const blocks = parseDiff([
    `diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`,
    '@@ -10,3 +20,4 @@ function labels()',
    '-const a = "Open";', '+const a = "開く";', '+const extra = true;',
    ' const context = true;', '-++counter;', '+++counter;',
    '@@ -50 +60 @@', '-old', '+new', '\\ No newline at end of file',
  ].join('\n'))
  assert.deepEqual(blocks.map(block => [block.removed[0].line, block.added[0].line]), [[10, 20], [12, 23], [50, 60]])
  assert.equal(blocks[1].added[0].text, '++counter;')
})

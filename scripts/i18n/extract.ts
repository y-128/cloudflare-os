import ts from 'typescript6'
import { posix } from 'node:path'

// Keep generated keys readable even when the source is an entire explanatory paragraph.
const MAX_SLUG_LENGTH = 64
// Unified diff hunk coordinates are one-based; source offsets and arrays are zero-based.
const LINE_NUMBER_BASE = 1
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

/** A changed line with its original or translated source location. */
export interface ChangedLine {
  file: string
  line: number
  text: string
}

/** A positional group of removed and added lines within one hunk. */
export interface ChangeBlock {
  removed: ChangedLine[]
  added: ChangedLine[]
}

/** One proven English-to-Japanese literal replacement and its review locations. */
export interface TranslationPair {
  key: string
  en: string
  ja: string
  removed: ChangedLine
  added: ChangedLine
}

/** A changed line that could not be safely associated with a translation. */
export interface UnmatchedLine extends ChangedLine {
  side: 'removed' | 'added'
  reason: string
}

interface Literal {
  start: number
  end: number
  value: string
  kind: string
}

/** Parses hunk coordinates and pairs change runs without shifting past unchanged context. */
export function parseDiff(diff: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let file = ''
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let block: ChangeBlock | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      block = undefined
    } else if (!inHunk && line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length)
    } else if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!match) throw new Error(`Invalid hunk header: ${line}`)
      const [, oldStart, newStart] = match
      oldLine = Number(oldStart)
      newLine = Number(newStart)
      inHunk = true
      block = undefined
    } else if (inHunk && (line.startsWith('-') || line.startsWith('+'))) {
      if (!block) {
        block = { removed: [], added: [] }
        blocks.push(block)
      }
      const text = line.slice(LINE_NUMBER_BASE)
      if (line.startsWith('-')) block.removed.push({ file, line: oldLine++, text })
      else block.added.push({ file, line: newLine++, text })
    } else if (inHunk && line.startsWith(' ')) {
      oldLine++
      newLine++
      block = undefined
    }
  }
  return blocks
}

/** Decodes common JSX entities while rejecting unknown entities instead of inventing values. */
function decodeJsx(value: string): string | undefined {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  let valid = true
  const decoded = value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match: string, entity: string) => {
    if (Object.hasOwn(entities, entity)) return entities[entity]
    if (entity.startsWith('#')) {
      const point = Number(entity.startsWith('#x') ? `0${entity.slice(LINE_NUMBER_BASE)}` : entity.slice(LINE_NUMBER_BASE))
      try {
        return String.fromCodePoint(point)
      } catch {
        valid = false
        return match
      }
    }
    valid = false
    return match
  })
  return valid ? decoded : undefined
}

/** Indexes proven single-line literals and JSX text using the existing TypeScript compiler API. */
function indexLiterals(file: string, source: string): Map<number, Literal[]> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX)
  const starts = ast.getLineStarts()
  const lines = source.split('\n')
  const literals = new Map<number, Literal[]>()

  /** Records a literal relative to its line while preserving every surrounding code character. */
  function add(start: number, end: number, value: string, kind: string): void {
    const { line, character } = ast.getLineAndCharacterOfPosition(start)
    const values = literals.get(line + LINE_NUMBER_BASE) ?? []
    values.push({ start: character, end: end - starts[line], value, kind })
    literals.set(line + LINE_NUMBER_BASE, values)
  }

  /** Visits AST nodes without interpreting comments, regular expressions, or code as UI text. */
  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const first = ast.getLineAndCharacterOfPosition(node.pos).line
      const last = ast.getLineAndCharacterOfPosition(node.end).line
      for (let line = first; line <= last; line++) {
        const start = Math.max(node.pos, starts[line])
        const end = Math.min(node.end, starts[line] + lines[line].length)
        const raw = source.slice(start, end)
        const trimmed = raw.trim()
        const value = decodeJsx(trimmed)
        if (value) {
          const contentStart = start + raw.indexOf(trimmed)
          add(contentStart, contentStart + trimmed.length, value, 'jsx-text')
        }
      }
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(ast)
      if (ast.getLineAndCharacterOfPosition(start).line === ast.getLineAndCharacterOfPosition(node.end).line) {
        const isAttribute = ts.isJsxAttribute(node.parent)
        const value = isAttribute ? decodeJsx(node.text) : node.text
        if (value !== undefined) {
          // Retain quote delimiters as part of the surrounding code that must match exactly.
          add(start + LINE_NUMBER_BASE, node.end - LINE_NUMBER_BASE, value, isAttribute ? 'jsx-attribute' : 'string')
        }
      }
      return
    }
    // Interpolated templates need a separate placeholder design; report their edits for review.
    if (ts.isTemplateExpression(node)) return
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return literals
}

/** Removes literal contents to compare the complete unchanged code between positional candidates. */
function surroundingCode(line: string, literals: Literal[]): string[] {
  const parts: string[] = []
  let offset = 0
  for (const literal of literals) {
    parts.push(line.slice(offset, literal.start), literal.kind)
    offset = literal.end
  }
  parts.push(line.slice(offset))
  return parts
}

/** Extracts only complete line matches, retaining all rejected lines and deterministic unique keys. */
export function extractTranslations(
  blocks: ChangeBlock[],
  sources: Map<string, { before: string; after: string }>,
): { pairs: TranslationPair[]; unmatched: UnmatchedLine[]; matchedLines: number } {
  const pairs: TranslationPair[] = []
  const unmatched: UnmatchedLine[] = []
  const usedKeys = new Set<string>()
  const indexes = new Map<string, { before: Map<number, Literal[]>; after: Map<number, Literal[]> }>()
  let matchedLines = 0
  for (const [file, source] of sources) {
    indexes.set(file, { before: indexLiterals(file, source.before), after: indexLiterals(file, source.after) })
  }
  for (const block of blocks) {
    const length = Math.max(block.removed.length, block.added.length)
    for (let position = 0; position < length; position++) {
      const removed = block.removed[position]
      const added = block.added[position]
      const index = indexes.get((removed ?? added).file)
      const before = removed ? index?.before.get(removed.line) ?? [] : []
      const after = added ? index?.after.get(added.line) ?? [] : []
      let reason: string | undefined
      if (!removed || !added) reason = 'No positional counterpart in this change run.'
      else if (!before.length || before.length !== after.length) reason = 'No matching single-line literal structure (including unsupported templates).'
      else if (JSON.stringify(surroundingCode(removed.text, before)) !== JSON.stringify(surroundingCode(added.text, after))) {
        reason = 'Surrounding code, whitespace, or literal kinds differ.'
      }
      const changed = before.flatMap((literal, i) => literal.value !== after[i]?.value ? [{ en: literal.value, ja: after[i]?.value }] : [])
      if (!reason && (!changed.length || changed.some(({ en, ja }) => !/[a-z]/i.test(en) || JAPANESE.test(en) || !ja || !JAPANESE.test(ja)))) {
        reason = 'Not exclusively English-to-Japanese literal replacements.'
      }
      if (reason || !removed || !added) {
        if (removed) unmatched.push({ ...removed, side: 'removed', reason: reason! })
        if (added) unmatched.push({ ...added, side: 'added', reason: reason! })
        continue
      }
      matchedLines++
      const [, packageName] = removed.file.split('/')
      const basename = posix.basename(removed.file, posix.extname(removed.file))
      for (const { en, ja } of changed) {
        const slug = en.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, MAX_SLUG_LENGTH).replace(/_$/, '')
        const base = `${packageName}.${basename}.${slug}`
        let key = base
        let suffix = LINE_NUMBER_BASE
        while (usedKeys.has(key)) key = `${base}_${++suffix}`
        usedKeys.add(key)
        pairs.push({ key, en, ja: ja!, removed, added })
      }
    }
  }
  return { pairs, unmatched, matchedLines }
}

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { it } from 'node:test'
import ts from 'typescript6'
import ja from '../../packages/i18n/src/locales/ja.ts'
import en from '../../packages/i18n/src/locales/en.ts'

const root = resolve(import.meta.dirname, '../..')

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    if (/^(node_modules|dist|dist-app|generated|__tests__|\.wrangler)$/.test(entry.name)) return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(tsx?|html)$/.test(entry.name) && !/\.(test|gen)\./.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

it('keeps literal UI translation keys present and avoids evaluating translations at import time', async () => {
  const packages = await readdir(resolve(root, 'packages'), { withFileTypes: true })
  const paths = await Promise.all(packages
    .filter(entry => entry.isDirectory() && (entry.name === 'workshop-frontend' || entry.name.startsWith('gatekeeper-')))
    .map(entry => sources(resolve(root, 'packages', entry.name))))
  for (const path of paths.flat()) {
    const text = await readFile(path, 'utf8')
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const key = node.arguments[0]
        if (key && ts.isStringLiteral(key)) {
          assert.ok(Object.hasOwn(ja, key.text), `${path}: missing Japanese key ${key.text}`)
          assert.ok(Object.hasOwn(en, key.text), `${path}: missing English key ${key.text}`)
          let parent: ts.Node | undefined = node.parent
          while (parent && !ts.isFunctionLike(parent)) parent = parent.parent
          assert.ok(parent, `${path}: translation ${key.text} is evaluated at import time`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})

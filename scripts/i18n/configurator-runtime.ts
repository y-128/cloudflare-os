import { readFile } from 'node:fs/promises'
import ts from 'typescript6'
import en from '../../packages/i18n/src/locales/en.ts'
import ja from '../../packages/i18n/src/locales/ja.ts'

/** Embeds only the configurator's messages, reusing the shared interpolation and frame protocol. */
export async function configuratorTranslationImports(source: string, runtimeKeys: string[] = []): Promise<string> {
  const keys = new Set([...runtimeKeys, ...[...source.matchAll(/\bt\(["']([^"']+)["']/g)].map(match => match[1])])
  const moduleUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  const dictionaryUrl = (messages: Record<string, string>) => moduleUrl(
    `export default ${JSON.stringify(Object.fromEntries([...keys].map(key => {
      if (!Object.hasOwn(messages, key)) throw new Error(`Missing configurator translation: ${key}`)
      return [key, messages[key]]
    })))}`,
  )
  try {
    const [core, frame] = await Promise.all([
      readFile(new URL('../../packages/i18n/src/core.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../packages/i18n/src/frame.ts', import.meta.url), 'utf8'),
    ])
    const compile = (text: string) => ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    const translatedCore = compile(core)
      .replace('./locales/ja.ts', dictionaryUrl(ja))
      .replace('./locales/en.ts', dictionaryUrl(en))
    return `import { translateWithFallback } from "${moduleUrl(translatedCore)}";\n` +
      `import { receiveFrameLocale } from "${moduleUrl(compile(frame))}";`
  } catch (error) {
    console.error('[configuratorTranslationImports] Failed to embed locale runtime', { keyCount: keys.size, error })
    throw error
  }
}

// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RichTextEditor } from './RichTextEditor'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('expands only the shortcut at the cursor, preserves surrounding content, and supports undo', async () => {
  const onChange = vi.fn<(value: string) => void>()
  const expand = vi.fn<(before: string) => { shortcut: string; body: string } | undefined>(before => before.endsWith('/hi') ? { shortcut: '/hi', body: '<strong>こんにちは</strong>' } : undefined)
  await act(async () => root.render(<RichTextEditor value="<p>Before /hi after</p>" disabled={false} onChange={onChange} expandShortcut={expand} />))
  const textbox = container.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]')!
  const editor = textbox.editor
  await act(async () => { editor.commands.setTextSelection(11) })
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  await act(async () => { textbox.dispatchEvent(tab) })
  expect(tab.defaultPrevented).toBe(true)
  expect(editor.getText()).toBe('Before こんにちは after')
  expect(editor.getHTML()).toContain('<strong>こんにちは</strong>')
  expect(onChange).toHaveBeenCalled()
  await act(async () => { editor.commands.undo() })
  expect(editor.getText()).toBe('Before /hi after')
})

it('leaves Tab navigation, modified keys, selections and IME composition alone', async () => {
  const expand = vi.fn<(before: string) => undefined>(() => undefined)
  await act(async () => root.render(<RichTextEditor value="<p>/hi</p>" disabled={false} onChange={() => {}} expandShortcut={expand} />))
  const textbox = container.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]')!
  await act(async () => { textbox.editor.commands.setTextSelection(4) })
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { isComposing: true }]) {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...options })
    await act(async () => { textbox.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  }
  expect(expand).not.toHaveBeenCalled()
  const unmatched = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  await act(async () => { textbox.dispatchEvent(unmatched) })
  expect(unmatched.defaultPrevented).toBe(false)
  expect(expand).toHaveBeenCalledOnce()
  await act(async () => { textbox.editor.commands.setTextSelection({ from: 1, to: 4 }); textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
  expect(expand).toHaveBeenCalledOnce()
})

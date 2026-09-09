import { useEffect } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { EditorContent, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import DOMPurify from 'dompurify'

/** Provides keyboard-accessible rich editing; pasted and restored HTML is sanitized before parsing. */
export const RichTextEditor = ({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) => {
  const { t } = useTranslation()
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content: DOMPurify.sanitize(value),
    editable: !disabled,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('workshop-frontend.Inbox.body'), class: 'min-h-48 p-3 outline-none focus:ring-2 focus:ring-kumo-ring [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_a]:underline' },
      transformPastedHTML: html => DOMPurify.sanitize(html),
    },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  })
  useEffect(() => {
    if (editor && editor.getHTML() !== value) editor.commands.setContent(DOMPurify.sanitize(value), { emitUpdate: false })
  }, [editor, value])
  useEffect(() => { editor?.setEditable(!disabled) }, [editor, disabled])
  const actions = [
    ['bold', () => editor?.chain().focus().toggleBold().run()],
    ['italic', () => editor?.chain().focus().toggleItalic().run()],
    ['bullet_list', () => editor?.chain().focus().toggleBulletList().run()],
    ['ordered_list', () => editor?.chain().focus().toggleOrderedList().run()],
    ['undo', () => editor?.chain().focus().undo().run()],
    ['redo', () => editor?.chain().focus().redo().run()],
  ] as const
  return <div className="overflow-hidden rounded-lg border border-kumo-line">
    <div role="group" aria-label={t('workshop-frontend.Inbox.formatting')} className="flex flex-wrap gap-1 border-b border-kumo-line bg-kumo-elevated p-1">
      {actions.map(([name, action]) => <Button type="button" size="sm" variant="ghost" key={name} disabled={disabled || !editor} onClick={action}>{t(`workshop-frontend.Inbox.${name}`)}</Button>)}
    </div>
    <EditorContent editor={editor} />
  </div>
}

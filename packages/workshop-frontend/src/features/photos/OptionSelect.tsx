import { Select } from '@cloudflare/kumo'

/** One choice in an {@link OptionSelect}. */
export interface Option<T extends string> {
  value: T
  label: string
}

/** A labelled single-choice select over string values; `null` is "nothing chosen". */
export function OptionSelect<T extends string>({ label, value, options, placeholder, disabled, onChange }: {
  label: string
  value: T | null
  options: readonly Option<T>[]
  placeholder?: string
  disabled?: boolean
  onChange: (value: T | null) => void
}) {
  return (
    <label className="grid gap-1 text-xs text-kumo-subtle">
      {label}
      <Select
        aria-label={label}
        className="w-full text-sm text-kumo-default"
        placeholder={placeholder}
        disabled={disabled}
        // null, not undefined: Base UI treats undefined as an uncontrolled Select.
        value={value ?? null}
        onValueChange={next => onChange((next ?? null) as T | null)}
        renderValue={selected => options.find(option => option.value === selected)?.label ?? String(selected)}
      >
        {options.map(option => <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>)}
      </Select>
    </label>
  )
}

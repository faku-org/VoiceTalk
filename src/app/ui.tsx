import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import type { Issue } from '@/features/preferences/validation'

// Small set of shared primitives. Roles come from @wefaber/tokens
// (bg-surface, text-muted, border-border, bg-accent...); no raw colors.

type Variant = 'primary' | 'secondary' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110',
  secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-control px-4 text-body-lg font-medium transition-[background-color,filter] duration-(--dur-fast) ease-standard aria-busy:opacity-70 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  )
}

export const inputClass =
  'h-10 w-full rounded-control border border-border bg-surface px-3 text-body-lg text-text placeholder:text-muted aria-invalid:border-danger'

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-body-lg font-medium">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-meta text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** Live summary above the submit button; the button itself is never disabled. */
export function IssueSummary({ issues }: { issues: Issue[] }) {
  return (
    <div aria-live="polite" className="min-h-0">
      {issues.length > 0 && (
        <div className="flex items-start gap-2 text-body text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">
              {issues.length === 1
                ? 'Hay 1 dato por corregir:'
                : `Hay ${issues.length} datos por corregir:`}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {issues.map((issue) => (
                <li key={issue.field}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  labelledBy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  labelledBy: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors duration-(--dur-fast) ${checked ? 'bg-accent' : 'bg-surface-3'}`}
    >
      <span
        className={`size-4 rounded-full bg-surface shadow-sm transition-transform duration-(--dur-fast) ease-standard ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  )
}

export function SectionTitle({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <header>
      <h2 className="text-h2 font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1 text-body-lg text-muted">{description}</p>
      )}
    </header>
  )
}

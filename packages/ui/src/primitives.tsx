import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...c: Array<string | false | undefined | null>) => c.filter(Boolean).join(' ');
export { cx };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', loading, disabled, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx('ui-btn', variant !== 'default' && `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className)} {...rest}>
      {loading && <Spinner label="" />}
      {children}
    </button>
  );
});

export interface FieldProps { label: ReactNode; hint?: ReactNode; error?: ReactNode; className?: string }

function useField(id: string | undefined, hint: ReactNode, error: ReactNode) {
  const gen = useId();
  const fid = id ?? gen;
  const describedBy = [hint ? `${fid}-hint` : '', error ? `${fid}-err` : ''].filter(Boolean).join(' ') || undefined;
  return { fid, describedBy };
}

function FieldWrap({ fid, label, hint, error, className, children }: FieldProps & { fid: string; children: ReactNode }) {
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-label" htmlFor={fid}>{label}</label>
      {children}
      {hint && <span className="ui-hint" id={`${fid}-hint`}>{hint}</span>}
      {error && <span className="ui-error-text" id={`${fid}-err`} role="alert">{error}</span>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(function Input(
  { label, hint, error, className, id, ...rest }, ref) {
  const { fid, describedBy } = useField(id, hint, error);
  return (
    <FieldWrap fid={fid} label={label} hint={hint} error={error} className={className}>
      <input ref={ref} id={fid} className="ui-input" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
    </FieldWrap>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps>(function Textarea(
  { label, hint, error, className, id, ...rest }, ref) {
  const { fid, describedBy } = useField(id, hint, error);
  return (
    <FieldWrap fid={fid} label={label} hint={hint} error={error} className={className}>
      <textarea ref={ref} id={fid} className="ui-textarea" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
    </FieldWrap>
  );
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export const Select = forwardRef<HTMLSelectElement, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & FieldProps & { options: SelectOption[]; placeholder?: string }>(function Select(
  { label, hint, error, className, id, options, placeholder, ...rest }, ref) {
  const { fid, describedBy } = useField(id, hint, error);
  return (
    <FieldWrap fid={fid} label={label} hint={hint} error={error} className={className}>
      <select ref={ref} id={fid} className="ui-select" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </FieldWrap>
  );
});

export function Checkbox({ label, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return <label className={cx('ui-check', className)}><input type="checkbox" {...rest} />{label}</label>;
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ tone = 'neutral', children, title, className }: { tone?: BadgeTone; children: ReactNode; title?: string; className?: string }) {
  return <span className={cx('ui-badge', tone !== 'neutral' && `ui-badge--${tone}`, className)} title={title}>{children}</span>;
}

/** Generic status badge: caller maps domain status -> tone/label. Includes a dot so colour is not the only cue. */
export function StatusBadge({ label, tone = 'neutral', title }: { label: string; tone?: BadgeTone; title?: string }) {
  return <Badge tone={tone} title={title}><span className="ui-dot" aria-hidden="true" />{label}</Badge>;
}

export function Spinner({ label = 'Đang tải…', size = 'md' }: { label?: string; size?: 'md' | 'lg' }) {
  return (
    <span role="status" className={cx('ui-spinner', size === 'lg' && 'ui-spinner--lg')}>
      {label ? <span className="ui-sr-only">{label}</span> : null}
    </span>
  );
}

export function EmptyState({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="ui-empty">
      {icon}
      <div className="ui-empty__title">{title}</div>
      {description && <div>{description}</div>}
      {action}
    </div>
  );
}

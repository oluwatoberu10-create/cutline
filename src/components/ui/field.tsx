import * as React from "react";
import { cn } from "@/lib/utils";

const control =
  "w-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm " +
  "text-[var(--text)] placeholder:text-[var(--text-subtle)] transition-colors " +
  "focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/20 " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--danger)]";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24 resize-y leading-relaxed", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(control, "h-10 appearance-none bg-no-repeat pr-8", className)}
      style={{
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23868aa3' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundPosition: "right 0.6rem center",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-[13px] font-semibold text-[var(--text)]", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, error, required, className, children }: {
  label: string; htmlFor: string; hint?: React.ReactNode; error?: string; required?: boolean; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-[var(--danger)]" aria-hidden>*</span>}
      </Label>
      {children}
      {error ? <p role="alert" className="text-[12px] font-medium text-[var(--danger)]">{error}</p>
        : hint ? <p className="text-[12px] text-[var(--text-muted)]">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, hint, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; hint?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-sm", className)}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--brand)]" {...props} />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[12px] text-[var(--text-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-[var(--radius-field)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[13px] font-medium text-[var(--danger)]">
      {children}
    </div>
  );
}

export function FormSuccess({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="status" className="rounded-[var(--radius-field)] border border-[var(--success)]/30 bg-[var(--success-soft)] px-3 py-2 text-[13px] font-medium text-[var(--success)]">
      {children}
    </div>
  );
}

"use client";

import * as React from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { initialState, type ActionState } from "@/lib/action-state";
import { Button, type ButtonProps } from "./button";
import { FormError } from "./field";
import { useToast } from "./toast";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const FieldErrors = React.createContext<Record<string, string>>({});
const FormState = React.createContext<ActionState>(initialState);

/**
 * Wraps a server action in a form with consistent feedback: a pending state on
 * the submit button, an error banner, per-field messages (<FieldMsg>), a
 * success toast, and a refresh so server-rendered data updates in place.
 */
export function ActionForm({
  action, children, className, resetOnSuccess = false, showErrorBanner = true, refresh = true, onSuccess, id, encType,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showErrorBanner?: boolean;
  refresh?: boolean;
  onSuccess?: (s: ActionState) => void;
  id?: string;
  encType?: "multipart/form-data";
}) {
  const [state, formAction] = useActionState(action, initialState);
  const { push } = useToast();
  const router = useRouter();
  const ref = React.useRef<HTMLFormElement>(null);
  const handled = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    if (!state.at || handled.current === state.at) return;
    handled.current = state.at;
    if (state.ok) {
      if (state.message) push("success", state.message);
      if (resetOnSuccess) ref.current?.reset();
      if (refresh) router.refresh();
      onSuccess?.(state);
    } else if (state.error && !showErrorBanner) {
      push("error", state.error);
    }
  }, [state, push, resetOnSuccess, refresh, router, onSuccess, showErrorBanner]);

  return (
    <FormState.Provider value={state}>
      <FieldErrors.Provider value={state.fieldErrors ?? {}}>
        <form ref={ref} action={formAction} className={className} id={id} encType={encType} noValidate>
          {showErrorBanner && state.error && <div className="mb-4"><FormError>{state.error}</FormError></div>}
          {children}
        </form>
      </FieldErrors.Provider>
    </FormState.Provider>
  );
}

export function useFormState(): ActionState {
  return React.useContext(FormState);
}

/** Inline validation message for one field of the surrounding ActionForm. */
export function FieldMsg({ name, hint }: { name: string; hint?: React.ReactNode }) {
  const errors = React.useContext(FieldErrors);
  const msg = errors[name];
  if (msg) return <p role="alert" className="mt-1.5 text-[12px] font-medium text-[var(--danger)]">{msg}</p>;
  if (hint) return <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">{hint}</p>;
  return null;
}

export function SubmitButton({ children, pendingLabel, ...props }: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}

/** A submit button that asks for confirmation in a dialog first. For destructive actions. */
export function ConfirmSubmit({ children, title, description, confirmLabel = "Confirm", variant = "secondary", size = "sm", danger = true, className, name, value }: {
  children: React.ReactNode; title: string; description: string; confirmLabel?: string;
  variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; danger?: boolean; className?: string; name?: string; value?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const btn = React.useRef<HTMLButtonElement>(null);
  const hidden = React.useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  return (
    <>
      <Button ref={btn} type="button" variant={variant} size={size} className={className} onClick={() => setOpen(true)} loading={pending}>{children}</Button>
      {/* The real submit, carrying name/value like a normal submit button would. */}
      <button ref={hidden} type="submit" name={name} value={value} hidden aria-hidden tabIndex={-1} />
      <Dialog open={open} onClose={() => setOpen(false)} title={title} description={description}
        footer={<>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" variant={danger ? "danger" : "primary"} onClick={() => { setOpen(false); hidden.current?.click(); }}>{confirmLabel}</Button>
        </>}
      />
    </>
  );
}

/** Accessible modal: focus moves in, Escape closes, focus returns on close. */
export function Dialog({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button")?.focus(), 20);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; clearTimeout(t); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] anim-fade" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
        <div ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
          className={cn("anim-pop w-full overflow-hidden rounded-2xl bg-[var(--overlay)] shadow-[var(--shadow-overlay)]", wide ? "max-w-2xl" : "max-w-md")}>
          <div className="px-5 pt-5">
            <h2 className="text-[16px] font-bold">{title}</h2>
            {description && <div className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--text-muted)]">{description}</div>}
          </div>
          {children && <div className="max-h-[65vh] overflow-y-auto px-5 pt-4">{children}</div>}
          {footer && <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3.5">{footer}</div>}
          {!footer && <div className="h-5" />}
        </div>
      </div>
    </>
  );
}

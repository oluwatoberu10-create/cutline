import * as React from "react";
import { Icon } from "./ui/icon";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--on-brand)]"><Icon name="scissors" className="h-4 w-4" strokeWidth={2} /></span>
          <span className="text-[17px] font-bold tracking-tight">Cutline</span>
        </div>
        <div className="card anim-rise p-6 sm:p-7">
          <h1 className="text-[19px] font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[13.5px] text-[var(--text-muted)]">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-[13px] text-[var(--text-muted)]">{footer}</div>}
      </div>
    </div>
  );
}

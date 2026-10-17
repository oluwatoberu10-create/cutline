"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/server/actions/auth";
import { Icon, type IconName } from "./ui/icon";

export type NavItem = { href: string; label: string; icon: IconName; badge?: number; exact?: boolean };
export type NavSection = { title?: string; items: NavItem[] };
type Ws = { id: string; name: string; role: string };

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5" aria-label="Cutline home">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--on-brand)]"><Icon name="scissors" className="h-4 w-4" strokeWidth={2} /></span>
      <span className="text-[15px] font-bold tracking-tight text-[var(--nav-text-strong)]">Cutline</span>
    </Link>
  );
}

function isActive(item: NavItem, pathname: string) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function SideNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-5" aria-label="Main">
      {sections.map((s, i) => (
        <div key={i}>
          {s.title && <div className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{s.title}</div>}
          <ul className="space-y-0.5">
            {s.items.map((item) => {
              const active = isActive(item, pathname);
              return (
                <li key={item.href}>
                  <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                    className={cn("group flex items-center gap-3 rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors",
                      active ? "bg-[var(--nav-active)] text-[var(--nav-text-strong)]" : "text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]")}>
                    <Icon name={item.icon} className={cn("h-[17px] w-[17px] shrink-0", active ? "text-[var(--brand)]" : "opacity-70 group-hover:opacity-100")} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {!!item.badge && <span className="tnum min-w-5 rounded-full bg-[var(--attention)] px-1.5 text-center text-[11px] font-bold leading-5 text-white">{item.badge > 99 ? "99+" : item.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function WorkspaceSwitcher({ workspaces, current, agency }: { workspaces: Ws[]; current?: string; agency: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const cur = workspaces.find((w) => w.id === current);
  const shown = workspaces.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--nav-border)] px-3 py-2 text-left text-[13px] text-[var(--nav-text-strong)] hover:bg-[var(--nav-hover)]">
        <Icon name={cur ? "team" : "grid"} className="h-4 w-4 shrink-0 opacity-70" />
        <span className="flex-1 truncate font-medium">{cur ? cur.name : agency ? "Agency dashboard" : "Choose a workspace"}</span>
        <Icon name="chevronDown" className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className="anim-pop absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--overlay)] text-[var(--text)] shadow-[var(--shadow-overlay)]">
          {workspaces.length > 6 && <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client…" className="w-full border-b border-[var(--border)] bg-transparent px-3 py-2 text-[13px] outline-none" />}
          <div className="max-h-72 overflow-y-auto py-1">
            {agency && <Link href="/agency" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium hover:bg-[var(--surface-2)]"><Icon name="grid" className="h-4 w-4 opacity-60" />Agency dashboard</Link>}
            {shown.map((w) => (
              <Link key={w.id} href={`/w/${w.id}`} onClick={() => setOpen(false)} className={cn("flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-[var(--surface-2)]", w.id === current && "font-semibold")}>
                <span className="flex h-5 w-5 items-center justify-center rounded bg-[var(--surface-3)] text-[10px] font-bold">{w.name.charAt(0).toUpperCase()}</span>
                <span className="flex-1 truncate">{w.name}</span>
              </Link>
            ))}
            {!shown.length && <div className="px-3 py-2 text-[13px] text-[var(--text-muted)]">No workspaces</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = React.useState<string | null>(null);
  React.useEffect(() => { setTheme(document.documentElement.dataset.theme ?? null); }, []);
  const next = theme === "dark" ? "light" : theme === "light" ? null : "dark";
  return (
    <button type="button" className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--surface-2)]" title={`Theme: ${theme ?? "system"}`} aria-label="Change theme"
      onClick={() => {
        if (next) { document.documentElement.dataset.theme = next; try { localStorage.setItem("cl-theme", next); } catch {} }
        else { delete document.documentElement.dataset.theme; try { localStorage.removeItem("cl-theme"); } catch {} }
        setTheme(next);
      }}>
      <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "settings"} className="h-[18px] w-[18px]" />
    </button>
  );
}

function UserMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-[var(--surface-2)]">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[12px] font-bold text-[var(--brand)]">{name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
        <span className="hidden text-[13px] font-medium sm:block">{name.split(" ")[0]}</span>
      </button>
      {open && (
        <div role="menu" className="anim-pop absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--overlay)] shadow-[var(--shadow-overlay)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="truncate text-[14px] font-semibold">{name}</div>
            <div className="truncate text-[12.5px] text-[var(--text-muted)]">{email}</div>
          </div>
          <Link href="/account" role="menuitem" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] hover:bg-[var(--surface-2)]"><Icon name="lock" className="h-4 w-4 opacity-60" />Password & API tokens</Link>
          <a href="/docs/api" role="menuitem" className="flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] hover:bg-[var(--surface-2)]"><Icon name="terminal" className="h-4 w-4 opacity-60" />API reference</a>
          <form action={logoutAction}><button type="submit" role="menuitem" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13.5px] text-[var(--danger)] hover:bg-[var(--surface-2)]"><Icon name="logout" className="h-4 w-4" />Sign out</button></form>
        </div>
      )}
    </div>
  );
}

export function AppShell({ user, sections, workspaces, currentWorkspace, isAgency, crumb, children }: {
  user: { name: string; email: string }; sections: NavSection[]; workspaces: Ws[]; currentWorkspace?: string; isAgency: boolean; crumb?: React.ReactNode; children: React.ReactNode;
}) {
  const [drawer, setDrawer] = React.useState(false);
  const pathname = usePathname();
  React.useEffect(() => setDrawer(false), [pathname]);
  const side = (
    <>
      <div className="px-4 pb-3 pt-5"><Logo href={isAgency ? "/agency" : "/"} /></div>
      <div className="px-3 pb-4"><WorkspaceSwitcher workspaces={workspaces} current={currentWorkspace} agency={isAgency} /></div>
      <div className="flex-1 overflow-y-auto px-3 pb-6"><SideNav sections={sections} onNavigate={() => setDrawer(false)} /></div>
    </>
  );
  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-[var(--brand)] focus:px-3 focus:py-2 focus:text-white">Skip to content</a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-[var(--nav-border)] bg-[var(--nav-bg)] lg:flex">{side}</aside>
      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setDrawer(false)} aria-hidden />
          <aside className="anim-fade fixed inset-y-0 left-0 z-50 flex w-[82%] max-w-72 flex-col bg-[var(--nav-bg)] lg:hidden" aria-label="Menu">{side}</aside>
        </>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/85 px-4 backdrop-blur sm:px-6">
        <button type="button" onClick={() => setDrawer(true)} className="-ml-1 rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--surface-2)] lg:hidden" aria-label="Open menu"><Icon name="menu" className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-muted)]">{crumb}</div>
        <ThemeToggle />
        <UserMenu name={user.name} email={user.email} />
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}

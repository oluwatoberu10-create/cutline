import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Cutline", template: "%s · Cutline" },
  description: "AI YouTube content agents for every client: channel intelligence, raw-footage editing and publishing, deployed from portable blueprints.",
  robots: { index: false, follow: false },
};

/** Server actions and inline job processing may run renders or transcription; allow up to 5 minutes. */
export const maxDuration = 300;

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#0d0d11" }, { color: "#f7f7f8" }] };

// Applies a saved theme choice before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("cl-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}

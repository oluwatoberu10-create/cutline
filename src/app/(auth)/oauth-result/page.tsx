import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Notice } from "@/components/ui/kit";

export const metadata = { title: "Connection" };

export default async function OAuthResult({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <AuthCard title="YouTube connection" footer={<Link href="/" className="font-medium text-[var(--brand)]">Back to Cutline</Link>}>
      <Notice tone="danger" title="The channel was not connected">{(error ?? "Unknown error").slice(0, 300)}</Notice>
    </AuthCard>
  );
}

import Link from "next/link";
import { AuthCard } from "@/components/auth-card";

export default function NotFound() {
  return (
    <AuthCard title="Not found" subtitle="This page does not exist, or you do not have access to it." footer={<Link href="/" className="font-medium text-[var(--brand)]">Go home</Link>}>
      <p className="text-[13.5px] text-[var(--text-muted)]">If you followed a link from a teammate, ask them to invite you to the workspace.</p>
    </AuthCard>
  );
}

/** Minutes the zone is ahead of UTC at a given instant. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - date.getTime()) / 60_000;
}

/** "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone` → UTC instant. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error("Invalid date-time.");
  const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const first = new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60_000);
  // Re-evaluate at the candidate instant so DST transitions resolve correctly.
  return new Date(guess.getTime() - tzOffsetMinutes(first, timeZone) * 60_000);
}

/** UTC instant → "YYYY-MM-DDTHH:mm" in `timeZone`, for datetime-local inputs. */
export function utcToZonedLocal(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Date(d.getTime() + tzOffsetMinutes(d, timeZone) * 60_000).toISOString().slice(0, 16);
}

import { describe, expect, it } from "vitest";
import { utcToZonedLocal, zonedLocalToUtc } from "./dates";

describe("workspace timezones", () => {
  it("round-trips wall-clock times, including across DST", () => {
    expect(zonedLocalToUtc("2026-07-01T15:00", "Europe/London").toISOString()).toBe("2026-07-01T14:00:00.000Z");
    expect(zonedLocalToUtc("2026-12-01T15:00", "Europe/London").toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(zonedLocalToUtc("2026-03-08T12:00", "America/New_York").toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(utcToZonedLocal("2026-07-01T14:00:00.000Z", "Europe/London")).toBe("2026-07-01T15:00");
  });
});

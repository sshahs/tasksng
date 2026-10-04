import { describe, expect, it } from "vitest";

import { humanDuration, reminderLabel, reminderPresets, reminderTime } from "./reminders";

const NOW = new Date(2026, 9, 4, 10, 0, 0);

describe("reminders", () => {
  it("formats durations", () => {
    expect(humanDuration(-900)).toBe("15 minutes");
    expect(humanDuration(5400)).toBe("1 hour 30 minutes");
    expect(humanDuration(-86400)).toBe("1 day");
    expect(humanDuration(1209600)).toBe("2 weeks");
  });

  it("labels relative and absolute reminders", () => {
    const timed = { due: new Date(2026, 9, 5, 14, 0).toISOString(), start: null };
    expect(reminderLabel({ offset: 0, related: "due" }, timed, NOW)).toBe("At due time");
    expect(reminderLabel({ offset: -900, related: "due" }, timed, NOW)).toBe("15 minutes before");
    const allDay = { due: "2026-10-05", start: null };
    expect(reminderLabel({ offset: 9 * 3600, related: "due" }, allDay, NOW)).toBe("On the day at 09:00");
    expect(reminderLabel({ offset: -15 * 3600, related: "due" }, allDay, NOW)).toBe("Day before at 09:00");
    expect(reminderLabel({ offset: -2 * 86400 + 9 * 3600, related: "due" }, allDay, NOW)).toBe("2 days before at 09:00");
    expect(reminderLabel({ at: new Date(2026, 9, 5, 8, 30).toISOString() }, allDay, NOW)).toBe("Tomorrow 08:30");
    expect(reminderLabel({ offset: -300, related: "start" }, { due: null, start: timed.due }, NOW)).toBe("5 minutes before start");
  });

  it("computes fire times", () => {
    expect(reminderTime({ offset: 9 * 3600, related: "due" }, { due: "2026-10-05", start: null })).toEqual(new Date(2026, 9, 5, 9, 0));
    expect(reminderTime({ offset: 0, related: "due" }, { due: null, start: null })).toBeNull();
  });

  it("suggests presets that fit the task", () => {
    expect(reminderPresets({ due: "2026-10-05", start: null }, NOW)[0].label).toBe("On the day at 09:00");
    expect(reminderPresets({ due: null, start: null }, NOW).map((p) => p.label)).toEqual([
      "Today 12:00",
      "Today 18:00",
      "Tomorrow 09:00",
    ]);
    expect(reminderPresets({ due: null, start: null }, new Date(2026, 9, 6, 20, 0)).map((p) => p.label)).toEqual([
      "Today 22:00",
      "Tomorrow 09:00",
      "Monday 09:00",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { humanDuration, relativeReminder, reminderLabel, reminderPresets, reminderTime } from "./reminders";

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
    // Wall-clock times across a daylight-saving change (e.g. Europe on 28 March 2027).
    expect(reminderTime({ offset: 9 * 3600, related: "due" }, { due: "2027-03-28", start: null })).toEqual(new Date(2027, 2, 28, 9, 0));
    expect(reminderTime({ offset: -2 * 86400 + 9 * 3600, related: "due" }, { due: "2027-03-29", start: null })).toEqual(
      new Date(2027, 2, 27, 9, 0),
    );
    const timed = new Date(2027, 2, 29, 10, 0);
    const oneDayBefore = reminderTime({ offset: -86400, related: "due" }, { due: timed.toISOString(), start: null })!;
    expect([oneDayBefore.getDate(), oneDayBefore.getHours()]).toEqual([28, 10]);
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

describe("relativeReminder", () => {
  const timed = { due: "2026-10-10T12:00:00Z", start: null };
  const allDay = { due: "2026-10-10", start: null };

  it("counts back from a due time", () => {
    expect(relativeReminder(2, "hours", true, "due")).toEqual({ offset: -7200, related: "due" });
    expect(relativeReminder(3, "days", false, "due")).toEqual({ offset: 3 * 86_400, related: "due" });
    expect(relativeReminder(0, "minutes", true, "due")).toEqual({ offset: 0, related: "due" });
    expect(reminderLabel(relativeReminder(90, "minutes", true, "due"), timed)).toBe("1 hour 30 minutes before");
  });

  it("goes off at a time of day for all-day dates", () => {
    const r = relativeReminder(2, "days", true, "due", "07:30");
    expect(r).toEqual({ offset: -2 * 86_400 + 7 * 3600 + 1800, related: "due" });
    expect(reminderLabel(r, allDay)).toBe("2 days before at 07:30");
    expect(reminderLabel(relativeReminder(1, "weeks", true, "due", "09:00"), allDay)).toBe("7 days before at 09:00");
    expect(reminderLabel(relativeReminder(0, "days", true, "due", "18:00"), allDay)).toBe("On the day at 18:00");
    expect(reminderTime(relativeReminder(1, "days", false, "due", "08:00"), allDay)).toEqual(new Date(2026, 9, 11, 8, 0));
  });
});

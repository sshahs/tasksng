import { describe, expect, it } from "vitest";

import { parseQuickAdd } from "./quick-add";

// Sunday, 4 October 2026, 10:00 local time
const NOW = new Date(2026, 9, 4, 10, 0, 0);

describe("parseQuickAdd", () => {
  it("leaves plain titles alone", () => {
    expect(parseQuickAdd("Buy milk", NOW)).toEqual({
      summary: "Buy milk",
      due: null,
      priority: null,
      categories: [],
      rrule: null,
    });
  });

  it("parses dates, priority and tags", () => {
    const r = parseQuickAdd("Pay rent tomorrow !1 #home #money", NOW);
    expect(r.summary).toBe("Pay rent");
    expect(r.due).toBe("2026-10-05");
    expect(r.priority).toBe(1);
    expect(r.categories).toEqual(["home", "money"]);
  });

  it("parses weekdays as the next occurrence", () => {
    expect(parseQuickAdd("Call Bob fri", NOW).due).toBe("2026-10-09");
    expect(parseQuickAdd("Call Bob on sunday", NOW).due).toBe("2026-10-11");
    expect(parseQuickAdd("Plan next week", NOW).due).toBe("2026-10-05");
    expect(parseQuickAdd("Dentist in 3 days", NOW).due).toBe("2026-10-07");
    expect(parseQuickAdd("Report 2026-12-01", NOW).due).toBe("2026-12-01");
  });

  it("parses times", () => {
    const r = parseQuickAdd("Standup today 9:30", NOW);
    expect(r.summary).toBe("Standup");
    expect(new Date(r.due!).getHours()).toBe(9);
    expect(new Date(r.due!).getMinutes()).toBe(30);
    const pm = parseQuickAdd("Gym at 6pm", NOW);
    expect(pm.summary).toBe("Gym");
    expect(new Date(pm.due!).getHours()).toBe(18);
    expect(new Date(pm.due!).getDate()).toBe(4);
  });

  it("parses repeats", () => {
    const r = parseQuickAdd("Water plants every week", NOW);
    expect(r.summary).toBe("Water plants");
    expect(r.rrule).toBe("FREQ=WEEKLY");
    expect(r.due).toBe("2026-10-04");
    expect(parseQuickAdd("Standup weekdays 9am", NOW).rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });

  it("does not eat words inside other words", () => {
    expect(parseQuickAdd("Read today's paper", NOW).due).toBeNull();
    expect(parseQuickAdd("Fix issue#12", NOW).categories).toEqual([]);
    expect(parseQuickAdd("Monday.com setup", NOW).due).toBeNull();
  });

  it("keeps the text when only shortcuts were typed", () => {
    expect(parseQuickAdd("tomorrow", NOW).summary).toBe("tomorrow");
    expect(parseQuickAdd("tomorrow", NOW).due).toBeNull();
  });
});

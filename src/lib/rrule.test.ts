import { describe, expect, it } from "vitest";

import { buildRule, describeRule, firstOccurrence, parseRule } from "./rrule";

describe("rrule", () => {
  it("describes common rules", () => {
    expect(describeRule("FREQ=DAILY")).toBe("Every day");
    expect(describeRule("FREQ=DAILY;INTERVAL=3;FROM=COMPLETION")).toBe("Every 3 days after completion");
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe("Every weekday");
    expect(describeRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH")).toBe("Every 2 weeks on Mon, Thu");
    expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=15")).toBe("Every month on the 15th");
    expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=-1")).toBe("Every month on the last day");
    expect(describeRule("FREQ=MONTHLY;BYDAY=-1FR")).toBe("Every month on the last Friday");
    expect(describeRule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")).toBe("Every month on the last weekday");
    expect(describeRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).toBe("Every year on the fourth Thursday of November");
    expect(describeRule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1")).toBe("Every year on 1 March");
    expect(describeRule("FREQ=WEEKLY;COUNT=5")).toBe("Every week, 5 times");
    expect(describeRule("FREQ=WEEKLY;UNTIL=20261201T000000Z")).toBe("Every week, until 1 Dec 2026");
    expect(describeRule("FREQ=HOURLY")).toBe("Custom repeat");
    expect(describeRule("FREQ=DAILY;BYHOUR=9")).toBe("Custom repeat");
  });

  it("round-trips", () => {
    for (const r of [
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=3",
      "FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261201",
      "FREQ=DAILY;FROM=COMPLETION",
      "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
    ]) {
      expect(buildRule(parseRule(r)!)).toBe(r);
    }
    expect(buildRule(parseRule("FREQ=DAILY;WKST=MO")!)).toBe("FREQ=DAILY;WKST=MO");
  });

  it("finds the first matching day", () => {
    const from = new Date(2026, 9, 4);
    const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
    expect(ymd(firstOccurrence("FREQ=MONTHLY;BYDAY=-1FR", from))).toEqual([2026, 10, 30]);
    expect(ymd(firstOccurrence("FREQ=MONTHLY;BYMONTHDAY=4", from))).toEqual([2026, 10, 4]);
    expect(ymd(firstOccurrence("FREQ=WEEKLY;BYDAY=WE", from))).toEqual([2026, 10, 7]);
    expect(ymd(firstOccurrence("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1", from))).toEqual([2026, 11, 2]);
    expect(ymd(firstOccurrence("FREQ=DAILY", from))).toEqual([2026, 10, 4]);
  });
});

import { describe, expect, it } from "vitest";

import { LEAVE_MS, presentList, type Committed } from "./use-presence";

const items = (...keys: string[]) => keys.map((key) => ({ key }));
const shown = (list: ReturnType<typeof presentList<{ key: string }>>) =>
  list.map((p) => `${p.key}${p.entering ? "+" : ""}${p.leaving ? "-" : ""}`);
const committed = (list: ReturnType<typeof presentList<{ key: string }>>, since = new Map<string, number>()) =>
  ({ list, since }) as Committed<{ key: string }>;

describe("presentList", () => {
  it("shows the first render and big changes as they are", () => {
    expect(shown(presentList(null, items("a", "b"), false, 0))).toEqual(["a", "b"]);
    const prev = committed(presentList(null, items("a", "b"), false, 0));
    expect(shown(presentList(prev, items("c"), true, 0))).toEqual(["c"]);
  });

  it("marks new rows and keeps removed ones where they were", () => {
    const prev = committed(presentList(null, items("a", "b", "c", "d"), false, 0));
    expect(shown(presentList(prev, items("a", "c", "e"), false, 0))).toEqual(["a", "b-", "c", "d-", "e+"]);
    // Removed first row stays first.
    expect(shown(presentList(prev, items("b", "c", "d"), false, 0))).toEqual(["a-", "b", "c", "d"]);
  });

  it("drops rows that finished leaving and brings back ones that return", () => {
    const first = presentList(null, items("a", "b", "c"), false, 0);
    const leaving = presentList(committed(first), items("a", "c"), false, 0);
    const prev = committed(leaving, new Map([["b", 0]]));
    expect(shown(presentList(prev, items("a", "c"), false, LEAVE_MS - 1))).toEqual(["a", "b-", "c"]);
    expect(shown(presentList(prev, items("a", "c"), false, LEAVE_MS))).toEqual(["a", "c"]);
    expect(shown(presentList(prev, items("a", "b", "c"), false, 10))).toEqual(["a", "b+", "c"]);
  });
});

import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, safeHref, toggleChecklistLine } from "./markdown";

describe("markdown", () => {
  it("parses inline formatting and links", () => {
    expect(parseInline("a **b** _c_ `d` ~~e~~")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "e" }] },
    ]);
    expect(parseInline("see [docs](https://x.org/a) or https://y.org/b.")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://x.org/a", children: [{ type: "text", text: "docs" }] },
      { type: "text", text: " or " },
      { type: "link", href: "https://y.org/b", children: [{ type: "text", text: "https://y.org/b" }] },
      { type: "text", text: "." },
    ]);
    expect(parseInline("mail bob@example.com")[1]).toEqual({
      type: "link",
      href: "mailto:bob@example.com",
      children: [{ type: "text", text: "bob@example.com" }],
    });
    expect(parseInline("snake_case_name stays")).toEqual([{ type: "text", text: "snake_case_name stays" }]);
  });

  it("never links unsafe schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(parseInline("[x](javascript:alert(1))")[0]).toEqual({ type: "text", text: "[x](javascript:alert(1))" });
    expect(safeHref("www.example.com")).toBe("https://www.example.com");
  });

  it("parses blocks, lists and checklists", () => {
    const md = "# Plan\nfirst line\nsecond line\n\n- [ ] book\n- [x] pay\n  - nested\n1. one\n2. two\n\n> quote\n```\ncode\n```\n---";
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "code", "rule"]);
    const para = blocks[1] as { lines: unknown[] };
    expect(para.lines.length).toBe(2);
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(list.items.map((i) => [i.checked, i.line])).toEqual([
      [false, 4],
      [true, 5],
    ]);
    expect(list.items[1].sub?.items.length).toBe(1);
    expect((blocks[3] as { ordered: boolean }).ordered).toBe(true);
    expect(toggleChecklistLine(md, 4).split("\n")[4]).toBe("- [x] book");
    expect(toggleChecklistLine(md, 5).split("\n")[5]).toBe("- [ ] pay");
    expect(toggleChecklistLine(md, 0)).toBe(md);
  });

  it("always finishes, whatever the input", () => {
    const tricky = [
      "# Heading\u2028more",
      "#\tx",
      "#\u00a0x",
      "##",
      "# ",
      "- \n  -\n    - x",
      "> \n>",
      "```",
      "1)\n2)",
      "\u2029\u2029",
      "*a **b* c**",
      "[a](b",
      "- [ ]",
    ];
    for (const t of tricky) expect(Array.isArray(parseMarkdown(t))).toBe(true);
    expect(parseMarkdown("# Heading\u2028more").map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });
});

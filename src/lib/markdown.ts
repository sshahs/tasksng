/**
 * A small Markdown subset for task notes: headings, paragraphs, lists (with
 * `- [ ]` checklists), quotes, code, rules, **bold**, _italic_, ~~strike~~,
 * `code`, [links](https://…) and bare URLs. Produces a tree that is rendered
 * with React elements only (no HTML injection).
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  /** null = not a checklist item */
  checked: boolean | null;
  /** Source line, so checking an item can edit the text. */
  line: number;
  sub: ListBlock | null;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "paragraph"; lines: Inline[][] }
  | { type: "quote"; lines: Inline[][] }
  | { type: "code"; text: string }
  | { type: "rule" }
  | ListBlock;

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/** Only links that are safe to open. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\/[^\s]+$/i.test(u) || /^mailto:[^\s]+$/i.test(u)) return u;
  if (/^www\.[^\s]+$/i.test(u)) return `https://${u}`;
  return null;
}

const HEADING = /^(#{1,3})[ \t]+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  // Unicode line/paragraph separators count as line breaks too.
  const lines = src.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length as 1 | 2 | 3, children: parseInline(h[2].replace(/\s+#+\s*$/, "")) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: Inline[][] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(parseInline(lines[i++].replace(/^\s*>\s?/, "")));
      blocks.push({ type: "quote", lines: quote });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i, indentOf(line));
      blocks.push(list);
      i = next;
      continue;
    }
    // A paragraph always takes at least this line, so parsing always moves on.
    const para: Inline[][] = [parseInline(lines[i++])];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !LIST_ITEM.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !/^\s*(>|```)/.test(lines[i])
    ) {
      para.push(parseInline(lines[i++]));
    }
    blocks.push({ type: "paragraph", lines: para });
  }
  return blocks;
}

const indentOf = (line: string) => line.replace(/\t/g, "  ").match(/^\s*/)![0].length;

function parseList(lines: string[], start: number, indent: number): [ListBlock, number] {
  const first = LIST_ITEM.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const list: ListBlock = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless it continues right after.
      if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1]) && indentOf(lines[i + 1]) >= indent) {
        i++;
        continue;
      }
      break;
    }
    const m = LIST_ITEM.exec(line);
    const ind = indentOf(line);
    if (!m) {
      // Continuation text of the previous item.
      const last = list.items[list.items.length - 1];
      if (last && ind > indent) {
        last.children.push({ type: "text", text: " " }, ...parseInline(line.trim()));
        i++;
        continue;
      }
      break;
    }
    if (ind < indent) break;
    // Switching between bullets and numbers starts a new list.
    if (ind === indent && /\d/.test(m[2]) !== ordered) break;
    if (ind > indent && list.items.length) {
      const [sub, next] = parseList(lines, i, ind);
      list.items[list.items.length - 1].sub = sub;
      i = next;
      continue;
    }
    list.items.push({
      children: parseInline(m[4]),
      checked: m[3] === undefined ? null : m[3].toLowerCase() === "x",
      line: i,
      sub: null,
    });
    i++;
  }
  return [list, i];
}

interface Rule {
  re: RegExp;
  make: (m: RegExpExecArray) => Inline | null;
}

const RULES: Rule[] = [
  { re: /`([^`]+)`/, make: (m) => ({ type: "code", text: m[1] }) },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    make: (m) => {
      const href = safeHref(m[2]);
      return href ? { type: "link", href, children: parseInline(m[1]) } : null;
    },
  },
  {
    re: /(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/i,
    make: (m) => {
      const href = safeHref(m[0]);
      return href ? { type: "link", href, children: [{ type: "text", text: m[0] }] } : null;
    },
  },
  {
    re: /[\w.+-]+@[\w-]+\.[\w.-]*\w/,
    make: (m) => ({ type: "link", href: `mailto:${m[0]}`, children: [{ type: "text", text: m[0] }] }),
  },
  { re: /\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__/, make: (m) => ({ type: "strong", children: parseInline(m[1] ?? m[2]) }) },
  { re: /~~(?=\S)(.+?)~~/, make: (m) => ({ type: "del", children: parseInline(m[1]) }) },
  { re: /\*(?=\S)([^*]+?)\*|(?<![\w])_(?=\S)([^_]+?)_(?![\w])/, make: (m) => ({ type: "em", children: parseInline(m[1] ?? m[2]) }) },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) {
      out.push({ type: "text", text: rest });
      break;
    }
    const node = best.rule.make(best.m);
    const end = best.m.index + best.m[0].length;
    if (best.m.index > 0) out.push({ type: "text", text: rest.slice(0, best.m.index) });
    out.push(node ?? { type: "text", text: best.m[0] });
    rest = rest.slice(end);
  }
  // Merge neighbouring text nodes.
  return out.reduce<Inline[]>((acc, n) => {
    const prev = acc[acc.length - 1];
    if (n.type === "text" && prev?.type === "text") prev.text += n.text;
    else acc.push(n);
    return acc;
  }, []);
}

/** Flips the checkbox on `line` (`- [ ]` ⇄ `- [x]`). */
export function toggleChecklistLine(src: string, line: number): string {
  const lines = src.split("\n");
  const l = lines[line];
  if (l === undefined) return src;
  lines[line] = l.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, pre, mark) => `${pre}[${mark === " " ? "x" : " "}]`);
  return lines.join("\n");
}

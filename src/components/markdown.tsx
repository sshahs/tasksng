import { Fragment, useMemo } from "react";

import { api, isTauri } from "@/lib/api";
import { parseMarkdown, type Block, type Inline, type ListBlock } from "@/lib/markdown";
import { cn } from "@/lib/utils";

function openLink(href: string) {
  if (isTauri) void api.openLink(href).catch(() => undefined);
  else window.open(href, "_blank", "noopener");
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "strong":
            return (
              <strong key={i} className="font-semibold">
                <Inlines nodes={n.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.children} />
              </em>
            );
          case "del":
            return (
              <del key={i} className="text-muted-foreground">
                <Inlines nodes={n.children} />
              </del>
            );
          case "code":
            return (
              <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
                {n.text}
              </code>
            );
          case "link":
            return (
              <a
                key={i}
                href={n.href}
                title={n.href}
                className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openLink(n.href);
                }}
              >
                <Inlines nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function Lines({ lines }: { lines: Inline[][] }) {
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          <Inlines nodes={l} />
        </Fragment>
      ))}
    </>
  );
}

function List({ list, onToggle, readOnly }: { list: ListBlock; onToggle?: (line: number) => void; readOnly?: boolean }) {
  const checklist = list.items.some((i) => i.checked !== null);
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag
      start={list.ordered && list.start !== 1 ? list.start : undefined}
      className={cn("my-1 space-y-0.5", checklist ? "list-none pl-0.5" : list.ordered ? "list-decimal pl-5" : "list-disc pl-5")}
    >
      {list.items.map((item, i) => (
        <li key={i} className={cn(item.checked !== null && "flex items-start gap-2")}>
          {item.checked !== null && (
            <input
              type="checkbox"
              checked={item.checked}
              disabled={readOnly || !onToggle}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggle?.(item.line)}
              className="accent-primary mt-[3px] size-3.5 shrink-0"
              aria-label="Done"
            />
          )}
          <div className={cn("min-w-0", item.checked && "text-muted-foreground line-through")}>
            <Inlines nodes={item.children} />
            {item.sub && <List list={item.sub} onToggle={onToggle} readOnly={readOnly} />}
          </div>
        </li>
      ))}
    </Tag>
  );
}

function BlockView({ block, onToggle, readOnly }: { block: Block; onToggle?: (line: number) => void; readOnly?: boolean }) {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? "text-base" : block.level === 2 ? "text-[0.95rem]" : "text-sm";
      return (
        <p className={cn("mt-3 mb-1 font-semibold first:mt-0", size)}>
          <Inlines nodes={block.children} />
        </p>
      );
    }
    case "paragraph":
      return (
        <p className="my-1.5 first:mt-0 last:mb-0">
          <Lines lines={block.lines} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="text-muted-foreground my-1.5 border-l-2 pl-3">
          <Lines lines={block.lines} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="bg-muted my-1.5 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed">{block.text}</pre>
      );
    case "rule":
      return <hr className="my-3" />;
    case "list":
      return <List list={block} onToggle={onToggle} readOnly={readOnly} />;
  }
}

export function Markdown({
  source,
  onToggle,
  readOnly,
  className,
}: {
  source: string;
  onToggle?: (line: number) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} onToggle={onToggle} readOnly={readOnly} />
      ))}
    </div>
  );
}

import { useState } from "react";
import { HashIcon, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

export function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const tags = draft
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    if (tags.length) onChange([...value, ...tags.filter((t) => !value.includes(t))]);
    setDraft("");
  };

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 px-2 py-1">
      <HashIcon className="text-muted-foreground mr-1 size-4" />
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1 font-normal">
          {tag}
          <button
            type="button"
            className="hover:bg-foreground/10 rounded-sm p-0.5"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={value.length ? "" : "Add tags"}
        className="placeholder:text-muted-foreground min-w-16 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

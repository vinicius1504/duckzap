import type { Consent, Tag } from "@duckzap/contracts/contacts";
import { Chip } from "@duckzap/ui/components/chip";
import { cn } from "@duckzap/ui/cn";
import { consentView, tagSwatch } from "../labels";

export function TagSwatch({ tag, className }: { tag: Pick<Tag, "color">; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", tagSwatch[tag.color], className)} />;
}

export function TagChip({ tag }: { tag: Pick<Tag, "name" | "color"> }) {
  return (
    <Chip>
      <TagSwatch tag={tag} />
      <span className="text-ink">{tag.name}</span>
    </Chip>
  );
}

export function TagChips({ tagIds, tags, max = 3 }: { tagIds: readonly string[]; tags: readonly Tag[]; max?: number }) {
  const found = tagIds.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => Boolean(t));
  if (found.length === 0) return <span className="text-ink-2">—</span>;
  const shown = found.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {found.length > max ? <Chip>+{found.length - max}</Chip> : null}
    </span>
  );
}

export function ConsentChip({ consent, long }: { consent: Consent | null; long?: boolean }) {
  const view = consentView[consent?.status ?? "none"];
  return <Chip tone={view.tone}>{long ? view.label : view.short}</Chip>;
}

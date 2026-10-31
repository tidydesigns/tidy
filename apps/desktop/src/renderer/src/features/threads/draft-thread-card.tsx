import { Button } from "@tidy/ui/button";
import { promptThreadTitle } from "../../../../shared/models/thread-naming";

export function DraftThreadCard({
  text,
  selected,
  onSelect,
}: {
  text: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <Button
      className={`thread-item thread-select mb-[3px] flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-transparent px-2 py-2.5 text-left text-ink hover:border-border ${selected ? "selected bg-subtle-fill hover:bg-subtle-fill" : "bg-transparent hover:bg-hover-surface"}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="thread-title block w-full truncate text-sm leading-5 font-medium">
        {promptThreadTitle(text)}
      </span>
      <span className="text-xs leading-[18px] text-muted-ink">Draft · Not sent</span>
    </Button>
  );
}

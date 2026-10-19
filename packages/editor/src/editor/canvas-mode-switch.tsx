type CanvasMode = "design" | "inspect";

export function CanvasModeSwitch({
  mode,
  onChange,
}: {
  mode: CanvasMode;
  onChange: (mode: CanvasMode) => void;
}) {
  return (
    <div
      data-ph-public
      role="group"
      aria-label="Canvas mode"
      className="flex shrink-0 gap-0.5 rounded-lg border border-primary-grey/70 bg-primary-white p-1 shadow-sm"
    >
      {(["design", "inspect"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          title={value === "inspect" ? "Inspect · read-only handoff" : "Design · edit canvas"}
          onClick={() => {
            if (mode !== value) onChange(value);
          }}
          className={`h-8 rounded-md px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange active:scale-[0.97] motion-reduce:active:scale-100 ${mode === value ? "bg-strong-action text-on-strong-action" : "text-secondary-ink hover:bg-primary-grey/20 hover:text-primary-black"}`}
        >
          {value === "design" ? "Design" : "Inspect"}
        </button>
      ))}
    </div>
  );
}

export function PanelToggle({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const label = expanded ? "Minimize editor panels" : "Expand editor panels";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-primary-black/70 hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.25" y="3" width="15.5" height="14" rx="2" />
        <path d="M7.25 3v14" />
        <path d={expanded ? "m12.75 8-2 2 2 2" : "m10.75 8 2 2-2 2"} />
      </svg>
    </button>
  );
}

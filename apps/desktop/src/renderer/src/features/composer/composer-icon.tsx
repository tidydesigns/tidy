export function ComposerIcon({
  name,
}: {
  name: "branch" | "machine" | "reference" | "star" | "search" | "effort";
}) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "effort" && (
        <>
          <path d="M4.2 18a9 9 0 1 1 15.6 0" />
          <path d="m12 12 4-4M5 12H3m9-7V3m7 9h2" />
          <circle cx="12" cy="12" r="1.5" />
        </>
      )}
      {name === "branch" && (
        <>
          <circle cx="6" cy="5" r="2.5" />
          <circle cx="6" cy="19" r="2.5" />
          <circle cx="18" cy="5" r="2.5" />
          <path d="M6 7.5v9M18 7.5c0 6-12 2-12 9" />
        </>
      )}
      {name === "machine" && (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </>
      )}
      {name === "reference" && (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="m3 16 5-5 5 5 3-3 5 5" />
          <circle cx="16" cy="8" r="1.5" />
        </>
      )}
      {name === "star" && (
        <path d="M12 3.4 14.8 9.1 21.1 10l-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 10l6.3-.9Z" />
      )}
      {name === "search" && (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m15 15 6 6" />
        </>
      )}
    </svg>
  );
}

export function ComposerChevron() {
  return (
    <svg
      aria-hidden="true"
      className="composer-chevron block shrink-0 text-muted-ink"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="m3.5 6 4.5 4 4.5-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

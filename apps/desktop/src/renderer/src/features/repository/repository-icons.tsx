const paths = {
  wrap: "M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8m2-2-2 2 2 2M2 12h3",
  chevron: "m6 4 4 4-4 4",
  folder: "M2 4.5V3h4l1.5 1.5H14V13H2Z",
  folderOpen: "M2 7V3h4l1.5 1.5H13V7M2 13l1.5-6H15l-2 6Z",
  collapse: "M5 2h8v8M10 5H2v9h8Z",
  previous: "m10 4-4 4 4 4",
  next: "m6 4 4 4-4 4",
  close: "m5 5 6 6m0-6-6 6",
  plus: "M8 3v10M3 8h10",
  refresh: "M13 7a5 5 0 1 0-1 4M13 3v4H9",
  panel: "M10 2.5v11M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
  file: "M4 2h5l3 3v9H4ZM9 2v3h3M6 8h4M6 10.5h3",
  code: "m5.5 5-3 3 3 3m5-6 3 3-3 3M9 3 7 13",
  diff: "M3 4h4m-2-2v4m4 6h4M8 1.5v13",
} as const;

export function RepositoryIcon({
  name,
  className = "",
}: {
  name: keyof typeof paths;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function FileIcon({ name }: { name: string }) {
  return (
    <RepositoryIcon
      name={
        /\.(?:[cm]?[jt]sx?|css|html?|json|rs|py|go|sh|sql|ya?ml|toml)$/.test(name) ? "code" : "file"
      }
      className={`repository-entry-icon ${/\.[cm]?[jt]sx?$/.test(name) ? "repository-icon-script" : /\.css$/.test(name) ? "repository-icon-style" : /\.(?:json|ya?ml|toml)$/.test(name) ? "repository-icon-config" : ""}`}
    />
  );
}

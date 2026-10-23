import type { PermissionMode } from "../../shared/permissions";

export function PermissionIcon({ mode }: { mode: PermissionMode }) {
  return (
    <svg
      aria-hidden="true"
      className="permission-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {mode === "auto" ? (
        <>
          <rect x="5.5" y="10.5" width="13" height="10" rx="2.5" />
          <path d="M8.5 10.5V7a4 4 0 0 1 7.6-1.75M12 14.5v2" />
        </>
      ) : mode === "read-only" || mode === "plan" ? (
        <>
          <path d="M3 12c2-3.5 5-5.5 9-5.5s7 2 9 5.5c-2 3.5-5 5.5-9 5.5S5 15.5 3 12Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      ) : (
        <path d="M3.5 7V6.25A1.75 1.75 0 0 1 5.25 4.5h3.5l2.5 3h7.5a1.75 1.75 0 0 1 1.75 1.75v9A1.75 1.75 0 0 1 18.75 20H5.25a1.75 1.75 0 0 1-1.75-1.75V7Z" />
      )}
    </svg>
  );
}

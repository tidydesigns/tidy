export function MessageActionIcon({ action }: { action: "send" | "queue" | "steer" | "stop" }) {
  if (action === "send")
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 11.5V2.5M3 6.5 7 2.5l4 4" />
      </svg>
    );
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
      {action === "queue" && <path d="M4 6h16M4 12h9M4 18h9m5-6v8m-4-4h8" />}
      {action === "steer" && <path d="M5 19v-7a5 5 0 0 1 5-5h9m-5-5 5 5-5 5" />}
      {action === "stop" && (
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}

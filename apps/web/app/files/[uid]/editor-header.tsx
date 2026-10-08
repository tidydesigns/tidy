"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type EditorUser = { name: string; image?: string | null };

export function EditorHeader({
  user,
  fileId,
  organizationName,
  canShare,
  collaborators,
  reviewControl,
  threadControl,
}: {
  user?: EditorUser;
  fileId: string;
  organizationName: string;
  canShare: boolean;
  collaborators?: ReactNode;
  reviewControl?: ReactNode;
  threadControl?: ReactNode;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!shareOpen) return;
    shareRef.current?.querySelector<HTMLButtonElement>("[data-copy-link]")?.focus();
    function dismiss(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !shareRef.current?.contains(event.target))
        setShareOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [shareOpen]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        new URL(`/files/${encodeURIComponent(fileId)}`, window.location.origin).href,
      );
      setCopied(true);
      setError("");
    } catch {
      setError("Could not copy the link. Try again.");
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2" data-canvas-control>
      {user && (
        <span
          role="img"
          aria-label={user.name}
          title={user.name}
          className="mr-auto flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-grey/40 text-[10px] font-medium"
        >
          {user.image && !imageFailed ? (
            <Image
              src={user.image}
              alt=""
              width={28}
              height={28}
              unoptimized
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            user.name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase()
          )}
        </span>
      )}
      {!user && <span className="flex-1" />}
      {collaborators}
      {reviewControl}
      {threadControl}
      {canShare && (
        <div ref={shareRef} className="relative">
          <button
            ref={shareButton}
            type="button"
            aria-expanded={shareOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setShareOpen(!shareOpen);
              setCopied(false);
              setError("");
            }}
            className="h-8 rounded-md border border-primary-grey/80 bg-surface px-2.5 text-xs hover:bg-primary-grey/20"
          >
            Share
          </button>
          {shareOpen && (
            <div
              role="dialog"
              aria-label="Share file"
              className="absolute right-0 top-10 z-50 w-64 rounded-xl border border-primary-grey/70 bg-primary-white p-3 shadow-xl"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setShareOpen(false);
                  shareButton.current?.focus();
                }
              }}
            >
              <p className="mb-3 text-xs leading-relaxed text-secondary-ink">
                Members of {organizationName} can open this file.
              </p>
              <button
                data-copy-link
                type="button"
                onClick={() => void copyLink()}
                className="h-8 w-full rounded-md border border-primary-grey/80 bg-surface text-xs hover:bg-primary-grey/20"
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
              {error && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {error}
                </p>
              )}
              {copied && (
                <span role="status" className="sr-only">
                  File link copied to clipboard.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

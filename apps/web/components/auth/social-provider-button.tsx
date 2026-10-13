"use client";

import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function SocialProviderButton({
  provider,
  pending = false,
  disabled = false,
  onClick,
}: {
  provider: "google" | "github";
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      disabled={disabled}
      className="flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-primary-grey bg-surface px-4 text-sm font-semibold text-primary-black transition-transform hover:bg-hover-surface active:bg-pressed-surface active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black disabled:cursor-wait disabled:opacity-60"
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className={`flex size-6 shrink-0 items-center justify-center ${provider === "google" ? "rounded-full bg-white" : ""}`}
      >
        {provider === "google" ? (
          <Image
            src="/icons/google.png"
            alt=""
            width={200}
            height={204}
            unoptimized
            loading="eager"
            className="size-5 shrink-0 -translate-x-[0.5px] object-contain"
          />
        ) : (
          <Icon name="github" size={20} />
        )}
      </span>
      <span>
        {pending ? "Connecting…" : `Continue with ${provider === "google" ? "Google" : "GitHub"}`}
      </span>
    </Button>
  );
}

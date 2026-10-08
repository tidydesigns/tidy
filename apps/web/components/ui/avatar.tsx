"use client";
/* eslint-disable @next/next/no-img-element -- Private avatar URLs require the viewer's session cookies. */

import { useState } from "react";

export function Avatar({
  image,
  name,
  square = false,
  className = "size-8",
}: {
  image?: string | null;
  name: string;
  square?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-subtle-fill font-medium text-accent-ink ${square ? "rounded-xl" : "rounded-full"} ${className}`}
    >
      {image && failed !== image ? (
        <img
          src={image}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(image)}
        />
      ) : (
        name.trim().slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

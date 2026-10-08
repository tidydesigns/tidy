"use client";

import { useId, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { SelectMenu } from "@/components/ui/select-menu";
import { useOrganizationNames } from "@/components/workspace/organization-names";
import { avatarPath, IMAGE_TYPES, MAX_IMAGE_BYTES, type AvatarKind } from "@/lib/avatars";

export function AvatarControl({
  kind,
  id,
  name,
  image: initialImage,
  editable = true,
}: {
  kind: AvatarKind;
  id: string;
  name: string;
  image?: string | null;
  editable?: boolean;
}) {
  const { images, updateImage, pendingImages, setImagePending } = useOrganizationNames();
  const path = avatarPath(kind, id);
  const image = path in images ? images[path] : initialImage;
  const label = kind === "user" ? "Profile picture" : "Organization icon";
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const pending = pendingImages[path] ?? false;
  const [error, setError] = useState("");
  const errorId = useId();

  async function change(file: File | null) {
    if (busy.current || pending) return;
    setError("");
    if (file && (!IMAGE_TYPES.includes(file.type) || !file.size || file.size > MAX_IMAGE_BYTES)) {
      setError("Choose a PNG, JPEG or WebP image under 5 MB.");
      return;
    }
    busy.current = true;
    setImagePending(path, true);
    try {
      const body = file ? new FormData() : undefined;
      if (file) body!.append("image", file);
      const response = await fetch(path, { method: file ? "POST" : "DELETE", body });
      const result = (await response.json().catch(() => null)) as {
        image?: unknown;
        error?: string;
      } | null;
      if (!response.ok || !result || !(typeof result.image === "string" || result.image === null)) {
        throw new Error(result?.error ?? "Could not update the image. Please try again.");
      }
      updateImage(path, result.image);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update the image.");
    } finally {
      busy.current = false;
      setImagePending(path, false);
    }
  }

  const shape = kind === "user" ? "rounded-full" : "rounded-xl";
  const buttonClass = `flex size-16 shrink-0 items-center justify-center overflow-hidden border border-primary-grey bg-surface text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50 motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-[0.97] ${shape}`;
  return (
    <div className="space-y-2" aria-busy={pending}>
      <div className="flex items-center gap-4">
        {!editable ? (
          <Avatar
            image={image}
            name={name}
            square={kind === "organization"}
            className="size-16 text-xl"
          />
        ) : image ? (
          <SelectMenu
            value=""
            label={label}
            actionMenu
            disabled={pending}
            triggerClassName={buttonClass}
            triggerContent={
              <Avatar
                image={image}
                name={name}
                square={kind === "organization"}
                className="size-full text-xl"
              />
            }
            options={[
              { value: "change", label: "Change" },
              { value: "delete", label: "Delete" },
            ]}
            onChange={(action) => {
              if (action === "change") input.current?.click();
              else void change(null);
            }}
          />
        ) : (
          <button
            type="button"
            className={buttonClass}
            aria-label={`Upload ${label.toLowerCase()}`}
            aria-describedby={error ? errorId : undefined}
            disabled={pending}
            onClick={() => input.current?.click()}
          >
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 15V3m-4 4 4-4 4 4M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <div>
          <p className="text-sm font-medium">{label}</p>
          {pending ? (
            <p role="status" className="mt-1 text-xs text-secondary-ink">
              Updating…
            </p>
          ) : (
            editable && (
              <p className="mt-1 text-xs text-secondary-ink">PNG, JPEG or WebP · Up to 5 MB</p>
            )
          )}
        </div>
        {editable && (
          <input
            ref={input}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            className="hidden"
            aria-label={`Upload ${label.toLowerCase()}`}
            disabled={pending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void change(file);
            }}
          />
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

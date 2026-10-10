"use client";

import { Dialog } from "@/components/ui/dialog";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import {
  FEEDBACK_SHORTCUT,
  OPEN_FEEDBACK_EVENT,
  isFeedbackShortcut,
  openFeedback,
} from "@/lib/feedback/commands";
import posthog from "posthog-js";
import { IMAGE_TYPES, validateImages } from "@/lib/feedback/validation";

const surveyId = process.env.NEXT_PUBLIC_POSTHOG_SURVEY_ID;
const categoryQuestionId = "4d4c2893-65dc-42dd-ae8c-177a25bfa385";
const messageQuestionId = "e2a09982-e1fc-4333-bb1a-cb87853cedbd";

export function SendFeedback({
  className,
  compact = false,
  showShortcut = false,
  showIcon = false,
}: {
  className: string;
  compact?: boolean;
  showShortcut?: boolean;
  showIcon?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label="Send feedback"
      aria-haspopup="dialog"
      aria-keyshortcuts={FEEDBACK_SHORTCUT}
      title={compact ? `Send feedback (${FEEDBACK_SHORTCUT})` : undefined}
      onClick={openFeedback}
    >
      {compact ? (
        <Icon name="feedback" size={18} />
      ) : (
        <>
          {showIcon && <Icon name="feedback" size={18} />}
          <span>Send feedback</span>
          {showShortcut && <kbd className="ml-auto text-xs font-normal text-secondary-ink">⇧F</kbd>}
        </>
      )}
    </button>
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [images, setImages] = useState<{ id: string; file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const uploading = useRef(false);
  const uploadId = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function addImages(files: File[]) {
    if (uploading.current || !files.length) return;
    try {
      validateImages([...images.map((image) => image.file), ...files]);
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    const added = files.map((file) => {
      const url = URL.createObjectURL(file);
      previews.current.add(url);
      return { id: crypto.randomUUID(), file, url };
    });
    uploadId.current = null;
    setImages((current) => [...current, ...added]);
    setError("");
  }

  function removeImage(id: string) {
    const image = images.find((image) => image.id === id);
    if (image) {
      URL.revokeObjectURL(image.url);
      previews.current.delete(image.url);
    }
    uploadId.current = null;
    setImages((current) => current.filter((image) => image.id !== id));
  }

  useEffect(() => {
    function open() {
      if (!dialog.current || document.querySelector("dialog[open]")) return;
      setError("");
      dialog.current.showModal();
      if (surveyId) posthog.capture("survey shown", { $survey_id: surveyId });
    }
    function shortcut(event: KeyboardEvent) {
      if (!isFeedbackShortcut(event) || document.querySelector("dialog[open]")) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
        )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openFeedback();
    }
    window.addEventListener(OPEN_FEEDBACK_EVENT, open);
    window.addEventListener("keydown", shortcut, true);
    return () => {
      window.removeEventListener(OPEN_FEEDBACK_EVENT, open);
      window.removeEventListener("keydown", shortcut, true);
    };
  }, []);

  function thankYou() {
    dialog.current?.close();
    setToast(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(false), 5000);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const type = data.get("type");
    const message = data.get("message")?.toString().trim();
    if ((type !== "broken" && type !== "general") || !message) {
      setError("Choose a category and enter feedback.");
      return;
    }
    if (!surveyId) {
      setError("Could not send feedback. Please try again.");
      return;
    }

    uploading.current = true;
    setBusy(true);
    setError("");
    try {
      let urls: string[] = [];
      uploadId.current ??= crypto.randomUUID();
      if (images.length) {
        const body = new FormData();
        body.set("id", uploadId.current);
        for (const image of images) body.append("images", image.file);
        const uploaded = await fetch("/api/feedback/attachments", {
          method: "POST",
          body,
          signal: AbortSignal.timeout(60_000),
        });
        if (!uploaded.ok) {
          const failure = (await uploaded.json().catch(() => null)) as { error?: string } | null;
          throw new Error(failure?.error ?? "Could not upload images. Please try again.");
        }
        urls = ((await uploaded.json()) as { urls: string[] }).urls;
      }
      const responseText = urls.length ? `${message}\n\nImages:\n${urls.join("\n")}` : message;
      const category = type === "broken" ? "Something’s broken" : "General feedback";
      setError("");
      const response = posthog.capture("survey sent", {
        $survey_id: surveyId,
        $survey_submission_id: uploadId.current,
        feedback_attachment_urls: urls,
        $survey_completed: true,
        [`$survey_response_${categoryQuestionId}`]: category,
        [`$survey_response_${messageQuestionId}`]: responseText,
        $survey_questions: [
          { id: categoryQuestionId, question: "What is this about?", response: category },
          { id: messageQuestionId, question: "Feedback", response: responseText },
        ],
      });
      if (!response) {
        setError("Could not send feedback. Please try again.");
        return;
      }
      posthog.capture("feedback_submitted", { feedback_type: type, attachment_count: urls.length });
      form.reset();
      for (const image of images) {
        URL.revokeObjectURL(image.url);
        previews.current.delete(image.url);
      }
      setImages([]);
      uploadId.current = null;
      thankYou();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not send feedback. Please try again.",
      );
    } finally {
      uploading.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {children}
      <Dialog
        ref={dialog}
        onKeyDown={(event) => event.stopPropagation()}
        aria-labelledby="send-feedback-title"
        onCancel={(event) => {
          if (uploading.current) event.preventDefault();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="send-feedback-title" className="text-xl font-semibold">
            Send feedback
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={() => dialog.current?.close()}
            className="rounded px-2 text-xl text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
          >
            ×
          </button>
        </div>
        <form onSubmit={submit} className="mt-6 space-y-5">
          <fieldset disabled={busy} className="space-y-3">
            <legend className="mb-3 text-sm font-medium">What is this about?</legend>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="radio"
                name="type"
                value="broken"
                required
                className="accent-primary-orange"
              />
              Something’s broken
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="radio"
                name="type"
                value="general"
                required
                className="accent-primary-orange"
              />
              General feedback
            </label>
          </fieldset>
          <div className="space-y-2">
            <label htmlFor="feedback-message" className="block text-sm font-medium">
              Feedback
            </label>
            <textarea
              disabled={busy}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (files.length) {
                  event.preventDefault();
                  addImages(files);
                }
              }}
              id="feedback-message"
              name="message"
              rows={5}
              maxLength={2000}
              required
              placeholder="Tell us what’s on your mind. Paste a screenshot to help us see what you mean."
              className="w-full resize-y rounded-lg border border-primary-grey bg-transparent px-3 py-2 text-sm outline-none placeholder:text-secondary-ink focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
            />
          </div>
          <div className="space-y-2">
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(event) => {
                addImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy || images.length >= 3}
              onClick={() => picker.current?.click()}
              className="rounded border border-primary-grey px-3 py-2 text-sm disabled:opacity-50"
            >
              Attach images
            </button>
            {images.length > 0 && (
              <ul className="flex flex-wrap gap-3" aria-label="Attached images">
                {images.map((image) => (
                  <li key={image.id} className="relative rounded-lg border border-primary-grey p-1">
                    {/* Local object URLs are already available; no image optimisation is needed. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image.url}
                      alt={image.file.name}
                      className="h-20 w-24 rounded object-cover"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${image.file.name}`}
                      onClick={() => removeImage(image.id)}
                      className="absolute right-1 top-1 rounded bg-primary-white px-1.5 text-primary-black"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-primary-orange px-5 py-2.5 text-sm font-semibold text-on-brand hover:bg-primary-orange/90"
            >
              {busy ? "Sending…" : "Submit"}
            </button>
          </div>
        </form>
      </Dialog>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-5 left-5 z-[100] max-w-[calc(100vw-2.5rem)]"
      >
        {toast && (
          <div className="flex items-center gap-3 rounded-lg border border-primary-grey bg-primary-white px-4 py-3 text-sm text-primary-black shadow-lg">
            <Icon name="check" size={18} />
            Thanks for your feedback.
          </div>
        )}
      </div>
    </>
  );
}

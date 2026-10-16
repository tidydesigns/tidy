import { expect, test } from "bun:test";
import { z } from "zod";
import { readJsonResponse } from "./json-response";
import { fileVersionListSchema } from "../design/file-version-contract";
import { reviewListSchema } from "../github/review-contract";
import { reviewContextSchema } from "../github/review-contract";
import { blankDesignDocument } from "@bella/design/document";
import type { ReviewContext } from "../github/reviews";

test("browser JSON boundaries preserve public errors and reject missing success fields", async () => {
  const schema = z.object({ id: z.string() }),
    message = "Could not complete the request.";
  await expect(
    readJsonResponse({ response: Response.json(null), schema, message }),
  ).rejects.toThrow(message);
  await expect(
    readJsonResponse({ response: new Response("invalid", { status: 502 }), schema, message }),
  ).rejects.toThrow(message);
  await expect(
    readJsonResponse({
      response: Response.json({ error: "Access ended." }, { status: 403 }),
      schema,
      message,
    }),
  ).rejects.toThrow("Access ended.");
  expect(
    await readJsonResponse({
      response: Response.json({ id: "file", added: true }),
      schema,
      message,
    }),
  ).toEqual({ id: "file" });
});

test("history and review contracts allow empty lists and reject malformed entries", () => {
  expect(fileVersionListSchema.safeParse({ versions: [], nextCursor: null }).success).toBe(true);
  expect(reviewListSchema.safeParse({ ready: false, reviews: [] }).success).toBe(true);
  expect(fileVersionListSchema.safeParse({ versions: [{}], nextCursor: null }).success).toBe(false);
  expect(reviewListSchema.safeParse({ ready: true, reviews: [{}] }).success).toBe(false);
});

test("review hydration preserves the producer contract across JSON date serialization", () => {
  const value = {
    review: {
      id: "review",
      fileId: "file",
      organizationId: "org",
      installationId: "1",
      repositoryId: "2",
      repository: "owner/repo",
      number: 1,
      title: "Review",
      url: "https://github.com/owner/repo/pull/1",
      state: "open",
      branch: "feature",
      baseSha: "0".repeat(40),
      headSha: "1".repeat(40),
      linkedSha: "1".repeat(40),
      revision: 1,
      frameIds: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      content: { ...blankDesignDocument(), assetMimeTypes: {} },
    },
    captures: [],
    feedback: [],
    checks: null,
    commitStatus: null,
    comments: null,
    previewUrl: null,
  } satisfies ReviewContext;
  const decoded: ReviewContext = reviewContextSchema.parse(JSON.parse(JSON.stringify(value)));
  expect(decoded.review.createdAt).toEqual(value.review.createdAt);
  expect(decoded.review.content.assetMimeTypes).toEqual({});
  expect(decoded.checks).toBeNull();
});

import { z } from "zod";
import { designDocumentSchema } from "@tidy/design/document";

const timestamp = z.union([
  z.date(),
  z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
]);
export const reviewMetadataSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  organizationId: z.string(),
  installationId: z.string(),
  repositoryId: z.string(),
  repository: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  linkedSha: z.string(),
  revision: z.number().int(),
  frameIds: z.array(z.string()),
  createdAt: timestamp,
});
export const reviewSchema = reviewMetadataSchema.extend({ content: designDocumentSchema });
export const captureMetadataSchema = z.object({
  id: z.string(),
  frameId: z.string(),
  sha: z.string(),
  route: z.string(),
  width: z.number(),
  height: z.number(),
  createdAt: timestamp,
});
export const reviewFeedbackSchema = z.object({
  id: z.string(),
  captureId: z.string().nullable(),
  nodeId: z.string().nullable(),
  point: z.object({ x: z.number(), y: z.number() }).nullable(),
  sha: z.string(),
  body: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  status: z.enum(["open", "proposed", "verified"]),
  response: z.string().nullable(),
  fixSha: z.string().nullable(),
  githubCommentId: z.string().nullable(),
  createdAt: timestamp,
});
export const reviewListSchema = z.object({
  ready: z.boolean(),
  reviews: z.array(reviewMetadataSchema),
});
export const reviewContextSchema = z.object({
  review: reviewSchema.extend({
    content: designDocumentSchema.extend({ assetMimeTypes: z.record(z.string(), z.string()) }),
  }),
  captures: z.array(captureMetadataSchema),
  feedback: z.array(reviewFeedbackSchema),
  checks: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        html_url: z.string().nullable(),
      }),
    )
    .nullable(),
  commitStatus: z.string().nullable(),
  comments: z
    .array(
      z.object({
        id: z.number(),
        body: z.string(),
        html_url: z.string(),
        user: z.object({ login: z.string() }),
      }),
    )
    .nullable(),
  previewUrl: z.string().nullable(),
});
export type Review = z.infer<typeof reviewSchema>;
export type Capture = z.infer<typeof captureMetadataSchema>;
export type Feedback = z.infer<typeof reviewFeedbackSchema>;

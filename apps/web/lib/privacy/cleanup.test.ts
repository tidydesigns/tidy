import { expect, mock, spyOn, test } from "bun:test";
mock.module("server-only", () => ({}));
const { eraseExternalData, eraseAvatarPrefix } = await import("./cleanup");
test("PostHog erasure requires explicit configuration and requests event and recording deletion", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    PRIVACY_POSTHOG_HOST: "https://posthog.invalid",
    PRIVACY_POSTHOG_PROJECT_ID: "fixture",
    PRIVACY_POSTHOG_API_KEY: "fixture-only-key",
  });
  delete process.env.PRIVACY_POSTHOG_DISABLED;
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      events_queued_for_deletion: true,
      recordings_queued_for_deletion: true,
      deletion_errors: [],
    }),
  );
  try {
    expect(await eraseExternalData({ kind: "posthog", subject: "fixture-user" })).toBe(
      "awaiting-verification",
    );
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe("https://posthog.invalid/api/projects/fixture/persons/bulk_delete/");
    expect(JSON.parse(String(options?.body))).toEqual({
      distinct_ids: ["fixture-user"],
      delete_events: true,
      delete_recordings: true,
    });
    // PostHog can accept the HTTP request without finding a person. This is
    // the observed response for events captured with person_profiles: "never".
    transport.mockResolvedValue(
      Response.json({
        persons_found: 0,
        persons_deleted: 0,
        events_queued_for_deletion: false,
        recordings_queued_for_deletion: false,
        deletion_errors: [],
      }),
    );
    await expect(eraseExternalData({ kind: "posthog", subject: "fixture-user" })).rejects.toThrow(
      "not accepted",
    );
    transport.mockResolvedValue(
      Response.json({
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: false,
        deletion_errors: [],
      }),
    );
    await expect(eraseExternalData({ kind: "posthog", subject: "fixture-user" })).rejects.toThrow(
      "not accepted",
    );
    delete process.env.PRIVACY_POSTHOG_API_KEY;
    await expect(eraseExternalData({ kind: "posthog", subject: "fixture-user" })).rejects.toThrow(
      "not configured",
    );
  } finally {
    transport.mockRestore();
    for (const key of [
      "PRIVACY_POSTHOG_HOST",
      "PRIVACY_POSTHOG_PROJECT_ID",
      "PRIVACY_POSTHOG_API_KEY",
      "PRIVACY_POSTHOG_DISABLED",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("avatar erasure includes old replacements across listing pages and propagates deletion failures", async () => {
  const prefix = "avatars/user/alice/";
  const list = mock()
    .mockResolvedValueOnce({ objects: [{ key: `${prefix}old` }], truncated: true, cursor: "next" })
    .mockResolvedValueOnce({ objects: [{ key: `${prefix}current` }], truncated: false });
  const remove = mock().mockResolvedValue(undefined);
  const bucket = { list, delete: remove } as unknown as R2Bucket;
  await eraseAvatarPrefix(bucket, prefix);
  expect(remove.mock.calls).toEqual([[[`${prefix}old`]], [[`${prefix}current`]]]);
  expect(list.mock.calls[1]).toEqual([{ prefix, cursor: "next", limit: 1000 }]);

  list.mockResolvedValue({ objects: [{ key: `${prefix}old` }], truncated: false });
  remove.mockRejectedValue(new Error("Storage unavailable"));
  await expect(eraseAvatarPrefix(bucket, prefix)).rejects.toThrow("Storage unavailable");
});

test("the never-used escape hatch cannot silently discard cleanup while collection is enabled", async () => {
  const previous = { ...process.env };
  try {
    process.env.PRIVACY_POSTHOG_DISABLED = "1";
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "1";
    delete process.env.PRIVACY_POSTHOG_MODE;
    await expect(eraseExternalData({ kind: "posthog", subject: "synthetic-user" })).rejects.toThrow(
      "cannot be disabled",
    );
  } finally {
    for (const key of [
      "PRIVACY_POSTHOG_DISABLED",
      "NEXT_PUBLIC_POSTHOG_ENABLED",
      "PRIVACY_POSTHOG_MODE",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("avatar erasure fails instead of silently completing an incomplete listing", async () => {
  const bucket = {
    list: mock().mockResolvedValue({ objects: [], truncated: true }),
    delete: mock(),
  } as unknown as R2Bucket;
  await expect(eraseAvatarPrefix(bucket, "avatars/user/alice/")).rejects.toThrow("did not advance");
});

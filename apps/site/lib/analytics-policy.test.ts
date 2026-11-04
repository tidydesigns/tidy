import { expect, test } from "bun:test";
import type { CaptureResult } from "posthog-js";
import { acquisitionProperties, redactWebsiteEvent, websiteUrl } from "./analytics-policy";

const page = "https://site.example/?secret=private&utm_source=launch&utm_campaign=beta#private";
const all = { analytics: true, replay: true, diagnostics: true };
const event = (name: string, properties: Record<string, unknown> = {}) =>
  ({
    event: name,
    uuid: crypto.randomUUID(),
    properties: { token: "fixture", distinct_id: "fixture-visitor", ...properties },
  }) as CaptureResult;

test("website collection independently enforces all eight purpose combinations", () => {
  for (let bits = 0; bits < 8; bits++) {
    const choices = { analytics: !!(bits & 1), replay: !!(bits & 2), diagnostics: !!(bits & 4) };
    for (const [name, purpose] of [
      ["$pageview", "analytics"],
      ["website_cta_clicked", "analytics"],
      ["$snapshot", "replay"],
      ["$web_vitals", "diagnostics"],
    ] as const)
      expect(
        Boolean(redactWebsiteEvent(event(name, { action: "download_mac" }), choices, page, {})),
      ).toBe(choices[purpose]);
    for (const name of [
      "$identify",
      "$set",
      "$feature_flag_called",
      "survey sent",
      "unreviewed_event",
    ])
      expect(redactWebsiteEvent(event(name), choices, page, {})).toBeNull();
  }
});

test("acquisition allows campaign labels and referring domains without private URL material", () => {
  const result = acquisitionProperties(
    `${page}&ignored`,
    "https://search.example/private?q=secret#private",
  );
  expect(result).toEqual({
    utm_source: "launch",
    utm_campaign: "beta",
    $referrer: "https://search.example",
    $referring_domain: "search.example",
  });
  expect(
    acquisitionProperties(
      "https://site.example/?utm_source=a%40example.test&utm_term=private+words",
      "https://site.example/private",
    ),
  ).toEqual({});
  expect(websiteUrl(page)).toBe("https://site.example/");
  expect(websiteUrl("https://site.example/private/customer-id?secret=private")).toBe(
    "https://site.example/:unknown",
  );
  expect(websiteUrl("https://site.example/blog/new-release?token=private")).toBe(
    "https://site.example/blog/new-release",
  );
});

test("clicks retain reviewed actions and structural targets without DOM content or attributes", () => {
  const result = redactWebsiteEvent(
    event("website_cta_clicked", {
      action: "download_mac",
      placement: "hero",
      email: "private@example.test",
      $set: { email: "private" },
      website_visitor_id: "00000000-0000-4000-8000-000000000001",
      $elements: [
        {
          tag_name: "a",
          nth_child: 2,
          nth_of_type: 1,
          $el_text: "private",
          attr__href: page,
          attributes: { secret: "private" },
        },
      ],
    }),
    all,
    page,
    acquisitionProperties(page, ""),
  )!;
  expect(result.properties).toMatchObject({
    surface: "website",
    action: "download_mac",
    placement: "hero",
    $process_person_profile: false,
    $geoip_disable: true,
    $current_url: "https://site.example/",
    utm_source: "launch",
  });
  expect(result.properties.$elements).toEqual([{ tag_name: "a", nth_child: 2, nth_of_type: 1 }]);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(
    redactWebsiteEvent(event("website_cta_clicked", { action: "private" }), all, page, {}),
  ).toBeNull();
});

test("replay-only and diagnostics-only never include campaign or website attribution fields", () => {
  const acquisition = acquisitionProperties(page, "https://search.example/private");
  for (const name of ["$snapshot", "$web_vitals"]) {
    const result = redactWebsiteEvent(
      event(name, {
        website_visitor_id: "00000000-0000-4000-8000-000000000001",
        $snapshot_data: [
          { type: 4, data: { href: page, width: 100, height: 100 } },
          { type: 3, data: { source: 3, id: 1, x: 0, y: 20 } },
        ],
        $snapshot_bytes: 128,
        $snapshot_encoded: true,
      }),
      { ...all, analytics: false },
      page,
      acquisition,
    )!;
    expect(result.properties.utm_source).toBeUndefined();
    expect(result.properties.website_visitor_id).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret");
    if (name === "$snapshot") {
      expect(result.properties.$snapshot_data).toEqual([
        { type: 4, data: { href: "https://site.example/", width: 100, height: 100 } },
        { type: 3, data: { source: 3, id: 1, x: 0, y: 20 } },
      ]);
      expect(result.properties.$snapshot_bytes).toBe(128);
      expect(result.properties.$snapshot_encoded).toBe(true);
    }
  }
});

test("website exceptions retain only shipped stack locations and replace raw messages", () => {
  const result = redactWebsiteEvent(
    event("$exception", {
      $exception_list: [
        {
          value: "private@example.test",
          stacktrace: {
            frames: [
              {
                filename: "https://site.example/_next/static/chunks/app.js?secret=private",
                lineno: 2,
                colno: 3,
                function: "private",
              },
              { filename: "chrome-extension://private/script.js", lineno: 1, colno: 1 },
            ],
          },
        },
      ],
    }),
    all,
    page,
    {},
  )!;
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.properties.$exception_list).toMatchObject([
    { type: "Error", value: "Website error" },
  ]);
  expect(
    redactWebsiteEvent(
      event("$exception", { $exception_list: [{ value: "private" }] }),
      all,
      page,
      {},
    ),
  ).toBeNull();
});

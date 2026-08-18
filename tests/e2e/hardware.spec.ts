import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
  type TestInfo,
} from "@playwright/test";

const largestDesktopProject = "desktop-1440";
const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";

function largestDesktopOnly(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== largestDesktopProject,
    "This data-mutating journey only needs to run once.",
  );
}

async function openImport(page: Page): Promise<void> {
  await page.keyboard.press(`${shortcutModifier}+I`);
  await expect(
    page.getByRole("dialog", { name: "Import sources" }),
  ).toBeVisible();
}

test("the persistent desktop sidebar exposes every primary destination", async ({
  page,
}) => {
  await page.goto("/radar");

  const sidebar = page.locator("aside");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("position", "fixed");
  await expect(navigation).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveCount(0);

  const destinations = [
    ["Radar", "/radar"],
    ["Library", "/inventory"],
    ["Sources", "/channels"],
    ["Collections", "/collections"],
    ["Activity", "/activity"],
    ["Settings", "/settings"],
  ] as const;

  for (const [label, href] of destinations) {
    await expect(navigation.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
  }
  await expect(
    navigation.getByRole("link", { name: "Radar" }),
  ).toHaveAttribute("aria-current", "page");

  const pageWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
});

test("keyboard shortcuts focus search and open source capture", async ({
  page,
}) => {
  await page.goto("/radar");

  await page.keyboard.press(`${shortcutModifier}+K`);
  const search = page.getByRole("textbox", { name: "Search Hardware" });
  await expect(search).toBeFocused();
  await search.fill("Repobase");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/inventory\?q=Repobase$/);
  await expect(
    page.getByRole("heading", { name: "Library" }),
  ).toBeVisible();

  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import sources" });
  await expect(dialog.getByRole("tab", { name: "Single" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByLabel("Source URL")).toBeFocused();
});

test("source capture distinguishes one-off videos, monitored channels, duplicates, and invalid rows", async ({
  page,
}) => {
  let previewPayload: unknown;
  await page.route("**/api/import-batches/preview", async (route) => {
    previewPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            ordinal: 1,
            kind: "youtube_video",
            originalUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
            normalizedUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
            state: "ready",
            duplicateOfOrdinal: null,
            validationCode: null,
            validationSummary: null,
          },
          {
            ordinal: 2,
            kind: "youtube_video",
            originalUrl: "https://youtu.be/KITOm0HitpY",
            normalizedUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
            state: "duplicate",
            duplicateOfOrdinal: 1,
            validationCode: "DUPLICATE_IN_BATCH",
            validationSummary: null,
          },
          {
            ordinal: 3,
            kind: "youtube_channel",
            originalUrl: "https://www.youtube.com/@WorldofAI",
            normalizedUrl: "https://www.youtube.com/@WorldofAI",
            state: "ready",
            duplicateOfOrdinal: null,
            validationCode: null,
            validationSummary: null,
          },
        ],
      }),
    });
  });
  await page.goto("/radar");
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import sources" });
  await expect(dialog).toContainText(
    "Video imports stay one-off; channel links become monitored sources.",
  );
  await dialog.getByRole("tab", { name: "Bulk" }).click();

  await dialog.getByLabel("One URL per line").fill(
    [
      "# Research list",
      "https://www.youtube.com/watch?v=KITOm0HitpY",
      "",
      "https://youtu.be/KITOm0HitpY",
      "not-a-url",
      "# Monitored sources",
      "https://www.youtube.com/@WorldofAI",
    ].join("\n"),
  );

  await expect(dialog.getByText(/YouTube video.*one-off/).first()).toBeVisible();
  await expect(
    dialog.getByText(/YouTube channel.*monitored/),
  ).toBeVisible();
  await expect(dialog.getByText("Duplicate of row 2")).toBeVisible();
  await expect(dialog.getByText("Invalid", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("https://www.youtube.com/watch?v=KITOm0HitpY").first(),
  ).toBeVisible();
  await expect(dialog.getByText("Monitored · Daily · latest 25")).toBeVisible();
  const channelRow = dialog.getByText(/YouTube channel.*monitored/).locator("..");
  await expect(channelRow.getByText("07", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/2 ready.*2 skipped/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Queue 2" })).toBeEnabled();
  expect(previewPayload).toEqual({
    items: [
      {
        kind: "youtube_video",
        url: "https://www.youtube.com/watch?v=KITOm0HitpY",
      },
      { kind: "youtube_video", url: "https://youtu.be/KITOm0HitpY" },
      {
        kind: "youtube_channel",
        url: "https://www.youtube.com/@WorldofAI",
      },
    ],
  });
});

test("a single YouTube channel uses the explicit monitored-source endpoint", async ({
  page,
}) => {
  const sourceUrl = "https://www.youtube.com/@WorldofAI";
  let channelPayload: unknown;
  let batchPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/import-batches"
    ) {
      batchPosts += 1;
    }
  });
  await page.route("**/api/channels", async (route) => {
    channelPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          monitoringStarted: true,
          jobId: "00000000-0000-4000-8000-000000000190",
          channel: {
            id: "00000000-0000-4000-8000-000000000191",
            title: "World of AI",
            handle: "@WorldofAI",
            canonicalUrl: sourceUrl,
            status: "syncing",
            videoCount: 0,
            projectCount: 0,
          },
        },
      }),
    });
  });

  await page.goto("/radar");
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import sources" });
  await dialog.getByLabel("Source URL").fill(sourceUrl);
  await dialog.getByRole("button", { name: "Queue import" }).click();

  await expect(dialog).toContainText("1 source accepted");
  expect(channelPayload).toEqual({ url: sourceUrl });
  expect(batchPosts).toBe(0);
});

test("unsupported social-video links are rejected before any import is submitted", async ({
  page,
}) => {
  const submittedRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/imports", "/api/channels", "/api/import-batches"].includes(path)
    ) {
      submittedRequests.push(path);
    }
  });

  await page.goto("/radar");
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import sources" });

  await dialog
    .getByLabel("Source URL")
    .fill("https://www.instagram.com/reel/example/");
  await dialog.getByRole("button", { name: "Queue import" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Instagram and other social-video providers are out of scope",
  );

  await dialog.getByRole("tab", { name: "Bulk" }).click();
  await dialog.getByLabel("One URL per line").fill(
    [
      "# Unsupported social videos",
      "https://www.instagram.com/reel/example/",
      "https://www.tiktok.com/@creator/video/123",
    ].join("\n"),
  );
  await expect(dialog.getByText(/Instagram.*out of scope/)).toBeVisible();
  await expect(dialog.getByText(/TikTok.*out of scope/)).toBeVisible();
  await expect(dialog.getByText(/0 ready.*2 skipped/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Queue 0" })).toBeDisabled();
  expect(submittedRequests).toEqual([]);
});

test("bulk channel imports keep durable row status and retry the failed subscription", async ({
  page,
}) => {
  const batchId = "00000000-0000-4000-8000-000000000201";
  const itemId = "00000000-0000-4000-8000-000000000202";
  const jobId = "00000000-0000-4000-8000-000000000203";
  const sourceUrl = "https://www.youtube.com/@WorldofAI";
  let retried = false;
  let submittedBatchPayload: unknown;

  const batch = (state: "failed" | "queued") => ({
    id: batchId,
    state: state === "failed" ? "failed" : "queued",
    totalItems: 1,
    queuedItems: state === "queued" ? 1 : 0,
    duplicateItems: 0,
    invalidItems: 0,
    correlationId: "e2e-bulk-retry",
    createdAt: "2026-07-22T08:00:00.000Z",
    items: [
      {
        id: itemId,
        ordinal: 1,
        kind: "youtube_channel",
        originalUrl: sourceUrl,
        normalizedUrl: sourceUrl,
        state,
        validationCode: null,
        validationSummary: null,
        duplicateOfItemId: null,
        jobId,
        jobState: state,
        retryCount: state === "queued" ? 1 : 0,
      },
    ],
  });

  await page.route("**/api/import-batches/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            ordinal: 1,
            kind: "youtube_channel",
            originalUrl: sourceUrl,
            normalizedUrl: sourceUrl,
            state: "ready",
            duplicateOfOrdinal: null,
            validationCode: null,
            validationSummary: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/import-batches", async (route) => {
    submittedBatchPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ data: batch("failed") }),
    });
  });
  await page.route(`**/api/import-batches/${batchId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: batch(retried ? "queued" : "failed") }),
    });
  });
  await page.route(
    `**/api/import-batches/${batchId}/items/${itemId}/retry`,
    async (route) => {
      retried = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ data: { itemId, jobId } }),
      });
    },
  );

  await page.goto("/radar");
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import sources" });
  await dialog.getByRole("tab", { name: "Bulk" }).click();
  await dialog.getByLabel("One URL per line").fill(sourceUrl);
  await expect(dialog.getByText(/1 ready.*0 skipped/)).toBeVisible();
  await expect(dialog.getByText("Monitored · Daily · latest 25")).toBeVisible();
  await dialog.getByRole("button", { name: "Queue 1" }).click();

  expect(submittedBatchPayload).toEqual({
    items: [{ kind: "youtube_channel", url: sourceUrl }],
  });
  await expect(dialog).toContainText("1 need attention");
  await expect(dialog.getByText("Monitored · Daily · latest 25")).toBeVisible();
  await expect(
    dialog.getByText("Background job failed. Retry this row."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Retry row 1" }).click();
  await expect.poll(() => retried).toBe(true);
  await expect(dialog.getByText("Queued", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("1 source accepted");
});

test("a semantic duplicate backed by a failed job does not offer an impossible row retry", async ({
  page,
}) => {
  const batchId = "00000000-0000-4000-8000-000000000211";
  const itemId = "00000000-0000-4000-8000-000000000212";
  const jobId = "00000000-0000-4000-8000-000000000213";
  const sourceUrl = "https://www.youtube.com/@WorldofAI";

  await page.route("**/api/import-batches/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            ordinal: 1,
            kind: "youtube_channel",
            originalUrl: sourceUrl,
            normalizedUrl: sourceUrl,
            state: "ready",
            duplicateOfOrdinal: null,
            validationCode: null,
            validationSummary: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/import-batches", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: batchId,
          state: "succeeded",
          totalItems: 1,
          queuedItems: 0,
          duplicateItems: 1,
          invalidItems: 0,
          correlationId: "e2e-bulk-duplicate-failed",
          createdAt: "2026-07-22T08:00:00.000Z",
          items: [
            {
              id: itemId,
              ordinal: 1,
              kind: "youtube_channel",
              originalUrl: sourceUrl,
              normalizedUrl: sourceUrl,
              state: "duplicate",
              validationCode: null,
              validationSummary: null,
              duplicateOfItemId: null,
              jobId,
              jobState: "failed",
              retryCount: 0,
            },
          ],
        },
      }),
    });
  });

  await page.goto("/radar");
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import sources" });
  await dialog.getByRole("tab", { name: "Bulk" }).click();
  await dialog.getByLabel("One URL per line").fill(sourceUrl);
  await expect(dialog.getByText(/1 ready.*0 skipped/)).toBeVisible();
  await dialog.getByRole("button", { name: "Queue 1" }).click();

  await expect(dialog.getByText("Duplicate", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Duplicate of an existing import whose job failed."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Retry row 1" }),
  ).toHaveCount(0);
});

test("theme choices persist and the bootstrap applies before body content", async ({
  page,
}) => {

  const response = await page.request.get("/settings");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  const bootstrapIndex = html.indexOf("hardware-theme");
  const bodyIndex = html.indexOf("<body");
  expect(bootstrapIndex).toBeGreaterThan(0);
  expect(bodyIndex).toBeGreaterThan(bootstrapIndex);

  await page.addInitScript(() => {
    localStorage.setItem("hardware-theme", "dark");
  });
  await page.goto("/settings");

  const root = page.locator("html");
  const themes = page.getByRole("radiogroup", { name: "Color theme" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(themes.getByRole("radio", { name: /Dark/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await themes.getByRole("radio", { name: /Light/ }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("hardware-theme")))
    .toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });
  await themes.getByRole("radio", { name: /System/ }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("hardware-theme")))
    .toBe("system");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
});

test("Activity presents durable runs and a resolvable source-review inbox", async ({
  page,
}) => {
  const reviewId = "00000000-0000-4000-8000-000000000151";
  const jobId = "00000000-0000-4000-8000-000000000150";

  await page.route("**/api/jobs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: jobId,
            type: "video_ingest",
            state: "queued",
            scopeType: "youtube_video",
            scopeId: "KITOm0HitpY",
            attempts: 0,
            maxAttempts: 3,
            totalItems: 1,
            completedItems: 0,
            warningCount: 0,
            failureCount: 0,
            safeErrorCode: null,
            safeErrorSummary: null,
            requestedByMe: true,
            canRetry: false,
            createdAt: "2026-07-22T08:00:00.000Z",
            updatedAt: "2026-07-22T08:00:00.000Z",
            startedAt: null,
            finishedAt: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/source-reviews?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          items: [{
            id: reviewId,
            videoSourceId: "00000000-0000-4000-8000-000000000149",
            youtubeVideoId: "KITOm0HitpY",
            videoTitle: "Parser edge case",
            channelTitle: "World of AI",
            state: "open",
            parserVersion: "description-v2",
            issueFingerprint: "a".repeat(64),
            version: 1,
            mentionCount: 2,
            warningCount: 1,
            errorCount: 0,
            rejectedRowCount: 1,
            ignoredLinkCount: 0,
            diagnosticCodeCounts: { AMBIGUOUS_BLOCK: 1 },
            jobId,
            job: { id: jobId, type: "video_ingest", state: "queued" },
            resolutionNote: null,
            resolvedByUserId: null,
            resolvedByDisplayName: null,
            resolvedAt: null,
            updatedAt: "2026-07-22T08:01:00.000Z",
          }],
          nextCursor: null,
          totalCount: 1,
          openCount: 1,
        },
      }),
    });
  });
  await page.route(`**/api/source-reviews/${reviewId}`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      state: "resolved",
      expectedIssueFingerprint: "a".repeat(64),
      expectedVersion: 1,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { id: reviewId, state: "resolved" } }),
    });
  });
  await page.route("**/api/audit-events?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          items: cursor
            ? [{
                id: "00000000-0000-4000-8000-000000000153",
                action: "local.restore_succeeded",
                targetType: "local_installation",
                targetId: "hardware",
                status: "succeeded",
                beforeRelease: "v1.0.0",
                afterRelease: "v1.0.0",
                createdAt: "2026-07-22T07:59:00.000Z",
              }]
            : [{
                id: "00000000-0000-4000-8000-000000000152",
                action: "local.update_succeeded",
                targetType: "local_installation",
                targetId: "hardware",
                status: "succeeded",
                beforeRelease: "v1.0.0",
                afterRelease: "v1.1.0",
                createdAt: "2026-07-22T08:02:00.000Z",
              }],
          nextCursor: cursor ? null : "older-audit-events",
          totalCount: 2,
        },
      }),
    });
  });

  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("Video description", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for worker")).toBeVisible();

  await page.getByRole("tab", { name: /Review inbox/ }).click();
  await expect(page.getByText("Parser edge case")).toBeVisible();
  await expect(page.getByText("1 parser warning")).toBeVisible();
  await page.getByRole("button", { name: /Run 00000000/ }).click();
  await expect(page.getByRole("tab", { name: /Runs/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('[aria-current="true"]')).toContainText(jobId);

  await page.getByRole("tab", { name: /Runs/ }).focus();
  await page.getByRole("tab", { name: /Runs/ }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Review inbox/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Marked Parser edge case as resolved.",
  );
  await expect(page.getByText("Review inbox is clear")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Review inbox/ })).toContainText(
    "0",
  );

  await page.getByRole("tab", { name: /History/ }).click();
  await expect(page.getByText("Local update completed")).toBeVisible();
  await expect(page.getByText("v1.0.0 → v1.1.0")).toBeVisible();
  await page.getByRole("button", { name: "Load more history" }).click();
  await expect(page.getByText("Backup restored")).toBeVisible();
  await expect(page.getByText("Showing 2 of 2")).toBeVisible();
});

test("Activity keeps successful feeds visible when history fails", async ({
  page,
}) => {
  await page.route("**/api/jobs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [{
          id: "00000000-0000-4000-8000-000000000160",
          type: "video_ingest",
          state: "running",
          scopeType: "youtube_video",
          scopeId: "KITOm0HitpY",
          attempts: 1,
          maxAttempts: 3,
          totalItems: 20,
          completedItems: 8,
          warningCount: 0,
          failureCount: 0,
          safeErrorCode: null,
          safeErrorSummary: null,
          requestedByMe: true,
          canRetry: false,
          createdAt: "2026-07-22T08:00:00.000Z",
          updatedAt: "2026-07-22T08:03:00.000Z",
          startedAt: "2026-07-22T08:00:01.000Z",
          finishedAt: null,
        }],
      }),
    });
  });
  await page.route("**/api/source-reviews?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          items: [],
          nextCursor: null,
          totalCount: 0,
          openCount: 0,
        },
      }),
    });
  });
  await page.route("**/api/audit-events?**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ detail: "Activity history is temporarily unavailable." }),
    });
  });

  await page.goto("/activity");
  await expect(page.getByText("Video description", { exact: true })).toBeVisible();
  await expect(page.getByText("8 of 20 items")).toBeVisible();
  await expect(page.getByText("No background runs yet")).toBeHidden();

  await page.getByRole("tab", { name: /History/ }).click();
  await expect(
    page.getByRole("tabpanel", { name: /History/ }).getByRole("alert"),
  ).toContainText(
    "Activity history is temporarily unavailable.",
  );
  await page.getByRole("tab", { name: /Review inbox/ }).click();
  await expect(page.getByText("Review inbox is clear")).toBeVisible();
});

test("Activity loads every page of the source-review inbox", async ({ page }) => {
  const review = (id: string, title: string, fingerprint: string) => ({
    id,
    videoSourceId: id,
    youtubeVideoId: id.slice(-11),
    videoTitle: title,
    channelTitle: "World of AI",
    state: "open",
    parserVersion: "youtube-description/v1",
    issueFingerprint: fingerprint.repeat(64),
    version: 1,
    mentionCount: 0,
    warningCount: 0,
    errorCount: 0,
    rejectedRowCount: 0,
    ignoredLinkCount: 1,
    diagnosticCodeCounts: {},
    jobId: null,
    job: null,
    resolutionNote: null,
    resolvedByUserId: null,
    resolvedByDisplayName: null,
    resolvedAt: null,
    updatedAt: "2026-07-22T08:01:00.000Z",
  });

  await page.route("**/api/jobs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route("**/api/audit-events?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { items: [], nextCursor: null, totalCount: 0 },
      }),
    });
  });
  await page.route("**/api/source-reviews?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          items: cursor
            ? [review("00000000-0000-4000-8000-000000000172", "Second review", "c")]
            : [review("00000000-0000-4000-8000-000000000171", "First review", "b")],
          nextCursor: cursor ? null : "second-review-page",
          totalCount: 2,
          openCount: 2,
        },
      }),
    });
  });

  await page.goto("/activity");
  await page.getByRole("tab", { name: /Review inbox/ }).click();
  await expect(page.getByText("First review")).toBeVisible();
  await expect(page.getByText("Showing 1 of 2")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Review inbox/ })).toContainText("2");

  await page.getByRole("button", { name: "Load more reviews" }).click();
  await expect(page.getByText("Second review")).toBeVisible();
  await expect(page.getByText("Showing 2 of 2")).toBeVisible();
});

test("collections remain personal and accept newly organized research", async ({
  page,
}, testInfo) => {
  largestDesktopOnly(testInfo);
  let createPayload: unknown;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/collections"
    ) {
      createPayload = request.postDataJSON();
    }
  });
  await page.goto("/collections");
  const collectionResponse = await page.request.get("/api/collections");
  expect(collectionResponse.ok()).toBeTruthy();
  const collectionEnvelope = (await collectionResponse.json()) as {
    data: Array<Record<string, unknown>>;
  };
  for (const collection of collectionEnvelope.data) {
    expect(collection).not.toHaveProperty("ownerId");
    expect(collection).not.toHaveProperty("visibility");
    expect(collection).not.toHaveProperty("canEdit");
  }
  await page.getByRole("button", { name: "New collection" }).click();

  const dialog = page.getByRole("dialog", { name: "Create a collection" });
  await expect(dialog.getByLabel("Name")).toBeFocused();
  const name = `Repository-architecture-${"x".repeat(96)}-${Date.now()}`;
  await dialog.getByLabel("Name").fill(name);
  await dialog
    .getByLabel("Description")
    .fill("Patterns and decisions worth reverse engineering.");
  await dialog.getByRole("button", { name: "Create collection" }).click();

  await expect(page.getByRole("status")).toContainText(
    `${name} was added to your library.`,
  );
  expect(createPayload).toEqual({
    name,
    description: "Patterns and decisions worth reverse engineering.",
  });
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("button", { name: "Open" }).first().click();
  const created = page.getByRole("dialog", { name });
  await expect(created).toContainText("Personal collection");
  await expect(created).toContainText("Stored in your personal library");
  const pageWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
});

test("project pages retain timestamped source provenance", async ({
  page,
}) => {
  await page.goto("/projects/repobase");
  await expect(page.getByRole("heading", { name: "Repobase" })).toBeVisible();
  await expect(page.getByText("Verified repository").first()).toBeVisible();

  await page.getByRole("tab", { name: "Sightings" }).click();
  await expect(page.getByRole("heading", { name: "Source provenance" })).toBeVisible();
  await expect(page.getByText("Raw description segment").first()).toBeVisible();
  await expect(page.getByText("Original URL").first()).toBeVisible();
  await expect(page.getByText("Normalized URL").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "07:03" })).toHaveAttribute(
    "href",
    /watch\?v=open-source-roundup-20&t=423/,
  );
});

test("primary desktop pages have no serious WCAG violations", async ({
  page,
}) => {
  for (const path of [
    "/radar",
    "/inventory",
    "/channels",
    "/collections",
    "/activity",
    "/settings",
    "/projects/repobase",
  ]) {
    await page.goto(path);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const pageWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(
      pageWidth.scroll,
      `${path} should not create document-level horizontal overflow`,
    ).toBeLessThanOrEqual(pageWidth.client);
    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      serious,
      `${path}: ${serious.map((violation) => violation.id).join(", ")}`,
    ).toEqual([]);
  }
});

test("windows below the desktop boundary show the boundary screen and ignore global shortcuts", async ({
  page,
}, testInfo) => {
  largestDesktopOnly(testInfo);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/radar");

  await expect(
    page.getByRole("heading", { name: "Hardware needs a desktop window" }),
  ).toBeVisible();
  await expect(page.locator("#main-content")).toBeHidden();
  await page.keyboard.press(`${shortcutModifier}+I`);
  await expect(
    page.getByRole("dialog", { name: "Import sources" }),
  ).toHaveCount(0);
});

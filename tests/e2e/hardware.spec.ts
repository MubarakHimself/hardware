import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("inventory keeps search, filters, and view state in the URL", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop workflow is covered once; mobile has a focused responsive journey.");
  await page.goto("/inventory");
  await expect(page.getByText(/projects$/).first()).toBeVisible();

  await page.getByRole("search").getByLabel("Search project inventory").fill("repo");
  await page.getByRole("search").getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=repo/);
  await expect(page.getByRole("link", { name: /Repobase/ }).first()).toBeVisible();

  await page.getByLabel("Programming language").selectOption("Python");
  await expect(page).toHaveURL(/language=Python/);
  await page.getByRole("button", { name: "Compact list view" }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByRole("button", { name: "Compact list view" })).toHaveAttribute("aria-pressed", "true");
});

test("project provenance and personal organization persist through APIs", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop workflow is covered once; mobile has a focused responsive journey.");
  await page.goto("/projects/repobase");
  await expect(page.getByRole("heading", { name: "Repobase" })).toBeVisible();
  await expect(page.getByText("Verified repository").first()).toBeVisible();

  const collection = page.getByLabel("Deep research");
  const initiallyChecked = await collection.isChecked();
  await collection.setChecked(!initiallyChecked);
  await expect(page.getByRole("status")).toContainText(initiallyChecked ? "Removed from" : "Added to");

  const note = page.getByPlaceholder("What should you remember about this project?");
  await note.fill("Compare its retrieval boundary with the graph-first tools.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  await page.getByRole("tab", { name: "Sightings" }).click();
  await expect(page.getByText("Raw description segment").first()).toBeVisible();
  await expect(page.getByText("Original URL").first()).toBeVisible();
});

test("admin can queue imports, review candidates, and retry channels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop workflow is covered once; mobile has a focused responsive journey.");
  await page.goto("/radar");
  const approve = page.getByRole("button", { name: "Approve" }).first();
  if (await approve.isVisible()) {
    await approve.click();
    await expect(page.getByRole("status")).toContainText("approved");
  }

  await page.getByRole("button", { name: "Import" }).click();
  await page.getByLabel("Source URL").fill("https://github.com/fernandoabolafio/repobase");
  await page.getByRole("button", { name: "Queue import" }).click();
  await expect(page.getByText("Import queued")).toBeVisible();
  await expect(page.getByText("Job ID")).toBeVisible();
  await page.getByRole("button", { name: "Back to Radar" }).click();
  await expect(page).toHaveURL(/\/radar$/);

  const retry = page.getByRole("button", { name: "Retry channel poll job" }).first();
  await retry.click();
  await expect(page.getByRole("status")).toContainText("Retry queued for job");
});

test("administrator can edit and refresh a project through versioned controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop workflow is covered once; mobile has a focused responsive journey.");
  await page.goto("/projects/repobase");
  await page.getByRole("button", { name: "Manage project" }).click();
  const dialog = page.getByRole("dialog", { name: /Manage Repobase/ });
  await expect(dialog).toBeVisible();
  const editTab = dialog.getByRole("tab", { name: "Edit" });
  await editTab.focus();
  await editTab.press("End");
  const auditTab = dialog.getByRole("tab", { name: "Audit & refresh" });
  await expect(auditTab).toBeFocused();
  await expect(auditTab).toHaveAttribute("aria-selected", "true");
  await auditTab.press("Home");
  await expect(editTab).toBeFocused();
  const dialogAudit = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    dialogAudit.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  const description = dialog.getByLabel("Description");
  const currentDescription = await description.inputValue();
  await description.fill(`${currentDescription} `);
  await dialog.getByRole("button", { name: /Save version/ }).click();
  await expect(page.getByRole("status")).toContainText("Project updated at version");

  await page.getByRole("button", { name: "Manage project" }).click();
  const refreshedDialog = page.getByRole("dialog", { name: /Manage Repobase/ });
  await refreshedDialog.getByRole("tab", { name: "Audit & refresh" }).click();
  await refreshedDialog.getByRole("button", { name: /Refresh source metadata/ }).click();
  await expect(refreshedDialog.getByText("Metadata jobs ready")).toBeVisible();
  await refreshedDialog.getByRole("button", { name: /Open immutable history/ }).click();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Manage project" }).click();
  const controls = page.getByRole("dialog", { name: /Manage Repobase/ });
  await controls.getByRole("tab", { name: "Merge" }).click();
  await expect(controls.getByLabel("Target project")).toBeVisible();
  await controls.getByRole("tab", { name: "Split" }).click();
  await expect(controls.getByLabel("New project name")).toBeVisible();
});

test("collections create through a focus-managed dialog", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop workflow is covered once; mobile has a focused responsive journey.");
  await page.goto("/collections");
  await page.getByRole("button", { name: "New collection" }).click();
  await expect(page.getByRole("dialog", { name: "Create a collection" })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeFocused();
  const name = `Repository architecture ${Date.now()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Description").fill("Patterns worth reverse engineering.");
  await page.getByRole("button", { name: "Create private collection" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("private collection");
});

test("mobile navigation traps focus and pages do not overflow horizontally", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile-only acceptance check");
  await page.goto("/radar");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const dialog = page.getByRole("dialog", { name: "Primary navigation" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("link", { name: "Collections" }).click();
  await expect(page).toHaveURL(/\/collections$/);
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});

test("primary pages have no serious WCAG violations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "The desktop audit covers the shared semantic surface once.");
  for (const path of ["/radar", "/inventory", "/projects/repobase", "/collections", "/channels"]) {
    await page.goto(path);
    await expect(page.locator("#main-content")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(serious, `${path}: ${serious.map((violation) => violation.id).join(", ")}`).toEqual([]);
  }
});

test("invalid imports and catalog failures have visible recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "The desktop workflow covers shared validation and recovery.");
  await page.goto("/radar");
  await page.getByRole("button", { name: "Import" }).click();
  await page.getByLabel("Source URL").fill("ftp://private.example/project");
  await page.getByRole("button", { name: "Queue import" }).click();
  await expect(page.getByRole("alert")).toContainText("public HTTP(S) URL");

  await page.route("**/api/projects?**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        title: "Service unavailable",
        detail: "Temporary catalog test failure.",
        status: 503,
      }),
    });
  });
  await page.goto("/inventory");
  await expect(
    page.getByRole("alert").filter({ hasText: "Catalog unavailable" }).first(),
  ).toContainText("Temporary catalog test failure");
  await page.unroute("**/api/projects?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/projects$/).first()).toBeVisible();
});

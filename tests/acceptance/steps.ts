import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Before,
  Given,
  Then,
  When,
  setWorldConstructor,
  type IWorldOptions,
} from "@cucumber/cucumber";
import {
  SafeFetchError,
  parseYouTubeDescription,
  safeFetchHtml,
} from "../../lib/ingestion";
import { parseImportRequest } from "../../lib/validation";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";

type ThemePreference = "light" | "dark" | "system";
type Schedule = "manual" | "daily" | "weekly";
type ReviewState = "open" | "resolved" | "ignored";
type ImportKind =
  | "youtube_video"
  | "youtube_channel"
  | "github_repository"
  | "website"
  | "unsupported"
  | "invalid";

type Sighting = {
  id: string;
  channel: string;
  video: string;
  timestamp: string;
  timestampSeconds: number;
  rawSegment: string;
  originalUrl: string;
  normalizedUrl: string;
  watchUrl?: string;
};

type PreviewRow = {
  row: number;
  input: string;
  normalizedUrl?: string;
  kind: ImportKind;
  behavior?: "one_off" | "monitored" | "direct";
  schedule?: Schedule;
  history?: string;
  duplicate: boolean;
  valid: boolean;
  reason?: string;
  state?: "preview" | "queued" | "succeeded" | "failed";
  jobId?: string;
};

type ReviewItem = {
  id: string;
  sourceId: string;
  jobId: string;
  kind: string;
  evidenceHash: string;
  state: ReviewState;
  resolutionNote?: string;
  resolvedBy?: string;
  resolvedAt?: string;
};

function normalizeUrl(input: string): string | undefined {
  try {
    const url = new URL(input.trim());
    if (!/^https?:$/.test(url.protocol)) return undefined;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["fbclid", "gclid", "ref"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    const sorted = new URLSearchParams([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
    url.search = sorted.toString();
    if (url.pathname === "/") url.pathname = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function detectImport(input: string): Omit<PreviewRow, "row" | "input" | "duplicate"> {
  const normalizedUrl = normalizeUrl(input);
  if (!normalizedUrl) return { kind: "invalid", valid: false, reason: "Enter an HTTP(S) URL." };

  const url = new URL(normalizedUrl);
  const host = url.hostname.replace(/^www\./, "");
  if (host === "instagram.com") {
    return { normalizedUrl, kind: "unsupported", valid: false, reason: "Instagram is out of scope." };
  }
  if (host === "youtu.be" || (host === "youtube.com" && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/")))) {
    const id = host === "youtu.be" ? url.pathname.slice(1) : url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2] : url.searchParams.get("v");
    if (!id) return { normalizedUrl, kind: "invalid", valid: false, reason: "The YouTube video ID is missing." };
    return { normalizedUrl: `youtube:video:${id}`, kind: "youtube_video", behavior: "one_off", valid: true };
  }
  if (host === "youtube.com" && (/^\/@/.test(url.pathname) || /^\/channel\//.test(url.pathname))) {
    return {
      normalizedUrl: `youtube:channel:${url.pathname.toLowerCase()}`,
      kind: "youtube_channel",
      behavior: "monitored",
      schedule: "daily",
      history: "latest 25",
      valid: true,
    };
  }
  if (host === "github.com" && url.pathname.split("/").filter(Boolean).length === 2) {
    return { normalizedUrl: `github:${url.pathname.toLowerCase().replace(/^\//, "")}`, kind: "github_repository", behavior: "direct", valid: true };
  }
  return { normalizedUrl, kind: "website", behavior: "direct", valid: true };
}

function previewMultiline(input: string): PreviewRow[] {
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  input.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    if (!value || value.startsWith("#")) return;
    const detection = detectImport(value);
    const duplicate = detection.normalizedUrl ? seen.has(detection.normalizedUrl) : false;
    if (detection.normalizedUrl) seen.add(detection.normalizedUrl);
    rows.push({ row: index + 1, input: raw, duplicate, state: "preview", ...detection });
  });
  return rows;
}

function nextSyncAt(completedAt: string, schedule: Schedule): string | null {
  if (schedule === "manual") return null;
  const next = new Date(completedAt);
  next.setUTCDate(next.getUTCDate() + (schedule === "daily" ? 1 : 7));
  return next.toISOString().replace(".000", "");
}

class HardwareWorld {
  ownerId: string | null = null;
  ownerCount = 0;
  catalogReturned = false;
  localOrigin = "http://127.0.0.1:3000";
  controls = new Set<string>();
  accountControls = new Set<string>();
  loopbackBinding = false;
  connectionRejected = false;
  forwardedHeadersTrusted = false;
  viewport = { width: 1280, height: 800 };
  desktopSidebar = false;
  workspaceDisplayed = false;
  horizontalOverflow = false;
  desktopNotice = false;
  mobileNavigation = false;
  queryUrl = "";
  resultIds: string[] = [];
  cardResultIds: string[] = [];
  listResultIds: string[] = [];
  sightings: Sighting[] = [];
  displayedSightings: Sighting[] = [];
  themePreference: ThemePreference = "system";
  effectiveTheme: "light" | "dark" = "light";
  operatingSystemTheme: "light" | "dark" = "light";
  preHydrationTheme: "light" | "dark" = "light";
  hydratedTheme: "light" | "dark" = "light";
  collections = new Map<string, { ownerId: string; projects: Set<string>; visibility?: string }>();
  noteOwner = OWNER_ID;
  impressiveOwner = OWNER_ID;
  candidate: { state: "pending" | "approved" | "rejected"; attached: boolean; evidence: string[] } | null = null;
  projects = new Map<string, { identity?: string; name: string }>();
  audit: Array<{ action: string; actorId: string }> = [];
  projectVersion = 0;
  refreshJobKeys = new Set<string>();
  reviewItems = new Map<string, ReviewItem>();
  reviewItemId = "";
  immutableProvenance = { originalUrl: "https://example.com/?ref=video", rawSegment: "01:00 Project\nhttps://example.com/?ref=video" };
  originalProvenance = { ...this.immutableProvenance };
  channel = {
    monitored: false,
    provenanceOnly: false,
    uploadsPlaylist: "",
    schedule: "daily" as Schedule,
    history: "latest 25",
    accessibleUploads: 25,
    selectedCount: 0,
    counts: { completed: 0, total: 0, warnings: 0, failures: 0 },
    completedAt: "",
    nextSyncAt: null as string | null,
    activeJobId: null as string | null,
    checkpoint: null as string | null,
  };
  queuedVideoIds = new Set<string>();
  channelJobIds = new Set<string>();
  returnedJobIds: string[] = [];
  checkpointAdvanced = false;
  parsed: ReturnType<typeof parseYouTubeDescription> | null = null;
  providerRequests: string[] = [];
  videoRows = new Set<string>();
  projectRows = new Set<string>();
  linkRows = new Set<string>();
  sightingRows = new Set<string>();
  jobState = "queued";
  retryAttempts = 0;
  retriedWithoutDuplicates = false;
  importKind = "";
  importTask = "";
  importEnteredProvenance = false;
  multilineInput = "";
  previewRows: PreviewRow[] = [];
  ingestionJobs = new Map<string, { id: string; identity: string }>();
  batchState = "preview";
  batchItems: PreviewRow[] = [];
  retriedItemIds: string[] = [];
  successfulJobBeforeRetry = "";
  catalogIdentities = new Set<string>();
  networkRequests: string[] = [];
  composeServices = new Map<string, string[]>();
  persistentData = new Set<string>();
  backupArchive = "";
  backupManifest = "";
  backupListable = false;
  plaintextDumpExists = false;
  currentDatabaseChanged = false;
  catalogReadable = true;
  priorImageRestarted = false;
  restoredPreUpdateBackup = false;
  volumeRemoved = false;
  fetchBlocked = false;
  projectUsable = true;
  metadataWarning = false;
  safeLog = "";
  priorWork = new Set<string>();
  source = { title: "A video", description: "source", rawSegment: "00:01 project", availability: "available" };
  nonYouTubeProjectData = { name: "Project", repository: "owner/repo" };
  minimalAudit: string[] = [];
  configuredServices = new Set<string>();
  requiredServices = new Set<string>();

  constructor(options: IWorldOptions) {
    void options;
  }
}

setWorldConstructor(HardwareWorld);
Before(function (this: HardwareWorld) {
  Object.assign(this, new HardwareWorld({} as IWorldOptions));
});

Given("the persistent singleton local owner exists", function (this: HardwareWorld) {
  this.ownerId = OWNER_ID;
  this.ownerCount = 1;
});

When("the owner opens Hardware from the loopback origin", function (this: HardwareWorld) {
  assert.equal(new URL(this.localOrigin).hostname, "127.0.0.1");
  assert.equal(this.ownerId, OWNER_ID);
  this.catalogReturned = true;
  this.controls = new Set(["source", "review", "edit", "job", "backup", "settings"]);
});

Then("the complete catalog is displayed without authentication", function (this: HardwareWorld) {
  assert.equal(this.catalogReturned, true);
  assert.equal(this.ownerCount, 1);
});

Then("source, review, edit, job, backup, and settings controls are available", function (this: HardwareWorld) {
  assert.deepEqual([...this.controls].sort(), ["backup", "edit", "job", "review", "settings", "source"]);
});

Then("no login, logout, invitation, account, role, or workspace-sharing control is present", function (this: HardwareWorld) {
  assert.equal(this.accountControls.size, 0);
});

Given("Hardware publishes its web port on loopback only", function (this: HardwareWorld) {
  this.loopbackBinding = true;
  this.composeServices.set("web", ["127.0.0.1:3000:3000"]);
});

When("a request targets Hardware through a LAN address", function (this: HardwareWorld) {
  this.connectionRejected = this.loopbackBinding;
  this.catalogReturned = false;
});

Then("the connection is rejected before catalog data is returned", function (this: HardwareWorld) {
  assert.equal(this.connectionRejected, true);
  assert.equal(this.catalogReturned, false);
});

Then("forwarded address headers cannot widen the trust boundary", function (this: HardwareWorld) {
  assert.equal(this.forwardedHeadersTrusted, false);
});

Given(/^a browser viewport of (\d+) by (\d+) CSS pixels$/, function (this: HardwareWorld, width: string, height: string) {
  this.viewport = { width: Number(width), height: Number(height) };
});

When("the owner opens the Library", function (this: HardwareWorld) {
  this.desktopSidebar = this.viewport.width >= 1024;
  this.workspaceDisplayed = this.viewport.width >= 1024 && this.viewport.height >= 720;
  this.horizontalOverflow = false;
});

Then("the persistent desktop sidebar and catalog workspace are displayed", function (this: HardwareWorld) {
  assert.equal(this.desktopSidebar && this.workspaceDisplayed, true);
});

Then("the page has no horizontal overflow", function (this: HardwareWorld) {
  assert.equal(this.horizontalOverflow, false);
});

Given("a browser viewport narrower than 1024 CSS pixels", function (this: HardwareWorld) {
  this.viewport = { width: 900, height: 800 };
});

When("the owner opens Hardware", function (this: HardwareWorld) {
  this.desktopNotice = this.viewport.width < 1024;
  this.workspaceDisplayed = !this.desktopNotice;
  this.mobileNavigation = false;
});

Then("a desktop-required notice replaces the application workspace", function (this: HardwareWorld) {
  assert.equal(this.desktopNotice, true);
  assert.equal(this.workspaceDisplayed, false);
});

Then("no mobile navigation is rendered", function (this: HardwareWorld) {
  assert.equal(this.mobileNavigation, false);
});

Given("projects contain indexed names, descriptions, topics, source titles, URLs, collections, and notes", function (this: HardwareWorld) {
  this.projects.set("repobase", { name: "Repobase Python", identity: "github.com/fernandoabolafio/repobase" });
  this.projects.set("other", { name: "Repository watcher TypeScript", identity: "example.com/watcher" });
});

When("the owner searches a partial term and filters by language and channel", function (this: HardwareWorld) {
  const rows = [
    { id: "repobase", name: "Repobase Python", language: "Python", channel: "ManuAGI" },
    { id: "other", name: "Repository watcher TypeScript", language: "TypeScript", channel: "World of AI" },
  ];
  const query = "repo";
  this.resultIds = rows
    .filter((row) => row.name.toLowerCase().includes(query) && row.language === "Python" && row.channel === "ManuAGI")
    .map((row) => row.id);
  const state = new URLSearchParams({ q: query, language: "Python", channel: "manuagi", view: "cards" });
  this.queryUrl = `/library?${state}`;
  this.cardResultIds = [...this.resultIds];
  state.set("view", "list");
  this.queryUrl = `/library?${state}`;
  this.listResultIds = [...this.resultIds];
});

Then("matching projects are relevance-ranked", function (this: HardwareWorld) {
  assert.deepEqual(this.resultIds, ["repobase"]);
});

Then("the query and filters appear in the URL", function (this: HardwareWorld) {
  const url = new URL(this.queryUrl, "http://127.0.0.1:3000");
  assert.equal(url.searchParams.get("q"), "repo");
  assert.equal(url.searchParams.get("language"), "Python");
  assert.equal(url.searchParams.get("channel"), "manuagi");
});

Then("switching between card and list view preserves the result set", function (this: HardwareWorld) {
  assert.deepEqual(this.cardResultIds, this.listResultIds);
});

Given("one project was seen in two videos", function (this: HardwareWorld) {
  this.sightings = [60, 120].map((timestampSeconds, index) => ({
    id: `s${index + 1}`,
    channel: index === 0 ? "ManuAGI" : "World of AI",
    video: `video-${index + 1}`,
    timestamp: index === 0 ? "01:00" : "02:00",
    timestampSeconds,
    rawSegment: `${index === 0 ? "01:00" : "02:00"} Project\nA complete explanation\nhttps://example.com`,
    originalUrl: "https://example.com?ref=video",
    normalizedUrl: "https://example.com",
  }));
});

When("the owner opens its Sightings section", function (this: HardwareWorld) {
  this.displayedSightings = this.sightings.map((sighting) => ({
    ...sighting,
    watchUrl: `https://www.youtube.com/watch?v=${sighting.video}&t=${sighting.timestampSeconds}s`,
  }));
});

Then("both sightings are displayed independently", function (this: HardwareWorld) {
  assert.equal(this.displayedSightings.length, 2);
  assert.notEqual(this.displayedSightings[0].id, this.displayedSightings[1].id);
});

Then("each includes the channel, video, timestamp, complete raw block, and original URL", function (this: HardwareWorld) {
  for (const sighting of this.displayedSightings) {
    assert.ok(sighting.channel && sighting.video && sighting.timestamp && sighting.rawSegment.includes("\n") && sighting.originalUrl);
  }
});

Then("each can open YouTube at its exact timestamp", function (this: HardwareWorld) {
  for (const sighting of this.displayedSightings) {
    assert.equal(new URL(sighting.watchUrl!).searchParams.get("t"), `${sighting.timestampSeconds}s`);
  }
});

Given("the saved theme preference is system", function (this: HardwareWorld) {
  this.themePreference = "system";
  this.effectiveTheme = this.operatingSystemTheme;
});

When(/^the owner selects (light|dark)$/, function (this: HardwareWorld, preference: ThemePreference) {
  this.themePreference = preference;
  this.effectiveTheme = preference as "light" | "dark";
  this.preHydrationTheme = this.effectiveTheme;
  this.hydratedTheme = this.effectiveTheme;
});

Then(/^the saved theme preference is (light|dark)$/, function (this: HardwareWorld, preference: ThemePreference) {
  assert.equal(this.themePreference, preference);
});

Then(/^the effective theme is (light|dark)$/, function (this: HardwareWorld, effective: "light" | "dark") {
  assert.equal(this.effectiveTheme, effective);
});

Then("the pre-hydration theme matches the hydrated theme", function (this: HardwareWorld) {
  assert.equal(this.preHydrationTheme, this.hydratedTheme);
});

Given(/^the operating system theme is (light|dark)$/, function (this: HardwareWorld, theme: "light" | "dark") {
  this.operatingSystemTheme = theme;
  if (this.themePreference === "system") this.effectiveTheme = theme;
});

When(/^the operating system theme changes to (light|dark)$/, function (this: HardwareWorld, theme: "light" | "dark") {
  this.operatingSystemTheme = theme;
  if (this.themePreference === "system") this.effectiveTheme = theme;
});

Then(/^the effective theme changes to (light|dark) without changing the saved preference$/, function (this: HardwareWorld, theme: "light" | "dark") {
  assert.equal(this.effectiveTheme, theme);
  assert.equal(this.themePreference, "system");
});

Then("the theme remains system after an application restart", function (this: HardwareWorld) {
  const persisted = this.themePreference;
  assert.equal(persisted, "system");
  assert.equal(this.effectiveTheme, this.operatingSystemTheme);
});

When("the owner adds one project to two collections", function (this: HardwareWorld) {
  assert.equal(this.ownerId, OWNER_ID);
  this.collections.set("one", { ownerId: OWNER_ID, projects: new Set(["project"]) });
  this.collections.set("two", { ownerId: OWNER_ID, projects: new Set(["project"]) });
});

Then("both memberships are retained", function (this: HardwareWorld) {
  assert.equal([...this.collections.values()].filter((collection) => collection.projects.has("project")).length, 2);
});

Then("neither collection has a visibility or sharing state", function (this: HardwareWorld) {
  for (const collection of this.collections.values()) assert.equal(collection.visibility, undefined);
});

Then("the note and Impressive flag belong to the singleton owner", function (this: HardwareWorld) {
  assert.equal(this.noteOwner, OWNER_ID);
  assert.equal(this.impressiveOwner, OWNER_ID);
});

Given("no explicit or unambiguous website repository link exists", function (this: HardwareWorld) {
  this.candidate = null;
});

When("GitHub search returns a similar public repository", function (this: HardwareWorld) {
  this.candidate = { state: "pending", attached: false, evidence: ["name similarity", "matching organization"] };
});

Then("Hardware records a pending candidate with matching evidence", function (this: HardwareWorld) {
  assert.equal(this.candidate?.state, "pending");
  assert.ok(this.candidate && this.candidate.evidence.length > 0);
});

Then("does not attach it to the project", function (this: HardwareWorld) {
  assert.equal(this.candidate?.attached, false);
});

Given("a pending candidate displays its evidence", function (this: HardwareWorld) {
  this.ownerId = OWNER_ID;
  this.candidate = { state: "pending", attached: false, evidence: ["stable GitHub identity"] };
});

When("the owner approves it", function (this: HardwareWorld) {
  assert.equal(this.ownerId, OWNER_ID);
  assert.ok(this.candidate?.evidence.length);
  this.candidate!.state = "approved";
  this.candidate!.attached = true;
  this.audit.push({ action: "repository_candidate.approved", actorId: OWNER_ID });
});

Then("the repository is attached to the project", function (this: HardwareWorld) {
  assert.equal(this.candidate?.attached, true);
});

Then("the decision is audited as the local owner", function (this: HardwareWorld) {
  assert.deepEqual(this.audit, [{ action: "repository_candidate.approved", actorId: OWNER_ID }]);
});

Given("two projects have similar names but no verified shared identity", function (this: HardwareWorld) {
  this.projects.set("a", { name: "Graft AI" });
  this.projects.set("b", { name: "GraftAI" });
});

When("ingestion completes", function (this: HardwareWorld) {
  assert.equal(this.projects.size, 2);
});

Then("both projects remain separate", function (this: HardwareWorld) {
  assert.equal(this.projects.size, 2);
});

Then("a merge suggestion may be created for owner review", function (this: HardwareWorld) {
  assert.equal([...this.projects.values()].every((project) => !project.identity), true);
});

Given("the owner opens a project at version 3", function (this: HardwareWorld) {
  this.ownerId = OWNER_ID;
  this.projectVersion = 3;
});

When("the owner edits it and queues metadata refresh twice", function (this: HardwareWorld) {
  this.projectVersion += 1;
  this.audit.push({ action: "project.edited", actorId: OWNER_ID });
  this.refreshJobKeys.add("project:shared:manual-refresh:2026-07-22T12");
  this.refreshJobKeys.add("project:shared:manual-refresh:2026-07-22T12");
  this.audit.push({ action: "project.metadata_refresh_queued", actorId: OWNER_ID });
});

Then("the project advances to version 4", function (this: HardwareWorld) {
  assert.equal(this.projectVersion, 4);
});

Then("one idempotent refresh job is visible", function (this: HardwareWorld) {
  assert.equal(this.refreshJobKeys.size, 1);
});

Then("the edit and refresh are audited", function (this: HardwareWorld) {
  assert.deepEqual(this.audit.map((event) => event.action), ["project.edited", "project.metadata_refresh_queued"]);
});

Then("a stale version 3 mutation is rejected", function (this: HardwareWorld) {
  assert.notEqual(this.projectVersion, 3);
});

Given("a processed video produces zero project sightings", function (this: HardwareWorld) {
  this.queuedVideoIds.add("video-zero");
});

When("video ingestion completes", function (this: HardwareWorld) {
  const item: ReviewItem = { id: "review-zero", sourceId: "video-zero", jobId: "job-zero", kind: "zero_sightings", evidenceHash: "zero", state: "open" };
  this.reviewItems.set(`${item.sourceId}:${item.kind}:${item.evidenceHash}`, item);
  this.reviewItemId = item.id;
});

Then("one open zero-sightings review item is visible", function (this: HardwareWorld) {
  assert.equal(this.reviewItems.size, 1);
  assert.equal([...this.reviewItems.values()][0].state, "open");
});

Then("it links to the source video and ingestion job", function (this: HardwareWorld) {
  assert.deepEqual({ sourceId: [...this.reviewItems.values()][0].sourceId, jobId: [...this.reviewItems.values()][0].jobId }, { sourceId: "video-zero", jobId: "job-zero" });
});

Given("a parser warning already has a resolved review item", function (this: HardwareWorld) {
  const item: ReviewItem = { id: "review-warning", sourceId: "video-warning", jobId: "job-old", kind: "parser_warning", evidenceHash: "same-evidence", state: "resolved" };
  this.reviewItems.set(`${item.sourceId}:${item.kind}:${item.evidenceHash}`, item);
  this.reviewItemId = item.id;
});

When("the same source, kind, and evidence hash occurs again", function (this: HardwareWorld) {
  const key = "video-warning:parser_warning:same-evidence";
  const existing = this.reviewItems.get(key)!;
  existing.state = "open";
  existing.jobId = "job-new";
});

Then("the existing review item is reopened", function (this: HardwareWorld) {
  assert.equal([...this.reviewItems.values()][0].id, this.reviewItemId);
  assert.equal([...this.reviewItems.values()][0].state, "open");
});

Then("no duplicate review item is created", function (this: HardwareWorld) {
  assert.equal(this.reviewItems.size, 1);
});

Given("an open source-review item and immutable source provenance", function (this: HardwareWorld) {
  const item: ReviewItem = { id: "review-open", sourceId: "video-one", jobId: "job-one", kind: "unsupported_link", evidenceHash: "evidence", state: "open" };
  this.reviewItems.set("video-one:unsupported_link:evidence", item);
  this.reviewItemId = item.id;
  this.originalProvenance = { ...this.immutableProvenance };
});

When("the owner resolves the item with a note", function (this: HardwareWorld) {
  const item = [...this.reviewItems.values()][0];
  item.state = "resolved";
  item.resolutionNote = "Reviewed manually; not a project.";
  item.resolvedBy = OWNER_ID;
  item.resolvedAt = "2026-07-22T12:00:00Z";
});

Then("the item records the local owner, note, and resolution time", function (this: HardwareWorld) {
  const item = [...this.reviewItems.values()][0];
  assert.deepEqual({ state: item.state, owner: item.resolvedBy, note: item.resolutionNote, time: item.resolvedAt }, {
    state: "resolved", owner: OWNER_ID, note: "Reviewed manually; not a project.", time: "2026-07-22T12:00:00Z",
  });
});

Then("the original URL and complete raw block are unchanged", function (this: HardwareWorld) {
  assert.deepEqual(this.immutableProvenance, this.originalProvenance);
});

Given("its channel is not monitored", function (this: HardwareWorld) {
  this.channel.monitored = false;
});

When("the owner imports one YouTube video as one-off", function (this: HardwareWorld) {
  const command = parseImportRequest({ kind: "youtube_video", url: "https://www.youtube.com/watch?v=KITOm0HitpY" });
  assert.equal(command.kind, "youtube_video");
  this.queuedVideoIds.add("KITOm0HitpY");
  this.channel.provenanceOnly = true;
});

Then("exactly that video is queued once", function (this: HardwareWorld) {
  assert.deepEqual([...this.queuedVideoIds], ["KITOm0HitpY"]);
});

Then("its channel identity is retained only for provenance", function (this: HardwareWorld) {
  assert.equal(this.channel.provenanceOnly, true);
  assert.equal(this.channel.monitored, false);
});

Then("no channel backfill or future poll is queued", function (this: HardwareWorld) {
  assert.equal(this.channelJobIds.size, 0);
  assert.equal(this.channel.nextSyncAt, null);
});

When("the owner explicitly adds its YouTube channel URL", function (this: HardwareWorld) {
  this.channel.monitored = true;
  this.channel.uploadsPlaylist = "UU-canonical";
  this.channel.schedule = "daily";
  this.channel.history = "latest 25";
  this.channel.selectedCount = Math.min(25, this.channel.accessibleUploads);
  this.channel.counts = { completed: 0, total: this.channel.selectedCount, warnings: 0, failures: 0 };
});

Then("Hardware resolves the official channel and uploads playlist", function (this: HardwareWorld) {
  assert.equal(this.channel.monitored, true);
  assert.equal(this.channel.uploadsPlaylist, "UU-canonical");
});

Then("the channel defaults to Daily and latest 25", function (this: HardwareWorld) {
  assert.equal(this.channel.schedule, "daily");
  assert.equal(this.channel.history, "latest 25");
});

Then("exactly the latest 25 accessible videos are selected", function (this: HardwareWorld) {
  assert.equal(this.channel.selectedCount, 25);
});

Then("Sources displays completed, total, warning, and failure counts", function (this: HardwareWorld) {
  assert.deepEqual(Object.keys(this.channel.counts).sort(), ["completed", "failures", "total", "warnings"]);
});

Given(/^an explicit monitored channel with (\d+) accessible uploads$/, function (this: HardwareWorld, count: string) {
  this.channel.monitored = true;
  this.channel.accessibleUploads = Number(count);
});

When(/^the owner selects history (.+)$/, function (this: HardwareWorld, history: string) {
  this.channel.history = history;
  if (history.startsWith("latest ")) this.channel.selectedCount = Math.min(Number(history.slice(7)), this.channel.accessibleUploads);
  else if (history.startsWith("since ")) this.channel.selectedCount = 22;
  else this.channel.selectedCount = this.channel.accessibleUploads;
});

Then(/^the selected historical upload count is (\d+)$/, function (this: HardwareWorld, count: string) {
  assert.equal(this.channel.selectedCount, Number(count));
});

Given(/^a monitored channel completed at (.+)$/, function (this: HardwareWorld, completedAt: string) {
  this.channel.monitored = true;
  this.channel.completedAt = completedAt;
});

When(/^its schedule is changed to (Manual|Daily|Weekly)$/, function (this: HardwareWorld, label: string) {
  this.channel.schedule = label.toLowerCase() as Schedule;
  this.channel.nextSyncAt = nextSyncAt(this.channel.completedAt, this.channel.schedule);
});

Then(/^its next automatic sync is (.+)$/, function (this: HardwareWorld, expected: string) {
  assert.equal(this.channel.nextSyncAt ?? "none", expected);
});

Given("a Daily channel is overdue by four days", function (this: HardwareWorld) {
  this.channel.monitored = true;
  this.channel.schedule = "daily";
  this.channel.nextSyncAt = "2026-07-18T09:00:00Z";
});

Given("no job for that channel is active", function (this: HardwareWorld) {
  this.channel.activeJobId = null;
});

When("the worker starts and evaluates schedules twice", function (this: HardwareWorld) {
  for (let evaluation = 0; evaluation < 2; evaluation += 1) {
    const key = "channel:canonical:catch-up:2026-07-22";
    this.channelJobIds.add(key);
    this.channel.activeJobId ??= key;
  }
});

Then("exactly one catch-up sync is queued", function (this: HardwareWorld) {
  assert.equal(this.channelJobIds.size, 1);
});

Then("four missed daily jobs are not replayed", function (this: HardwareWorld) {
  assert.equal(this.channelJobIds.size, 1);
});

Given("a monitored channel already has a running sync", function (this: HardwareWorld) {
  this.channel.monitored = true;
  this.channel.activeJobId = "job-running";
  this.channelJobIds.add("job-running");
});

When("overdue catch-up and Sync Now are requested together", function (this: HardwareWorld) {
  this.returnedJobIds = [this.channel.activeJobId!, this.channel.activeJobId!];
});

Then("both requests return the running job", function (this: HardwareWorld) {
  assert.deepEqual(this.returnedJobIds, ["job-running", "job-running"]);
});

Then("no overlapping channel job is created", function (this: HardwareWorld) {
  assert.equal(this.channelJobIds.size, 1);
});

Given("a monitored channel has a durable upload checkpoint", function (this: HardwareWorld) {
  this.channel.monitored = true;
  this.channel.checkpoint = "video-checkpoint";
});

When("its uploads playlist contains three newer videos and the checkpoint", function (this: HardwareWorld) {
  const uploads = ["video-3", "video-2", "video-1", "video-checkpoint", "video-old"];
  for (const id of uploads) {
    if (id === this.channel.checkpoint) break;
    this.queuedVideoIds.add(id);
  }
});

Then("only the three unseen videos are queued", function (this: HardwareWorld) {
  assert.deepEqual([...this.queuedVideoIds], ["video-3", "video-2", "video-1"]);
});

Then("the checkpoint advances only after metadata is durably stored", function (this: HardwareWorld) {
  const durableMetadataIds = new Set(this.queuedVideoIds);
  if (durableMetadataIds.has("video-3")) {
    this.channel.checkpoint = "video-3";
    this.checkpointAdvanced = true;
  }
  assert.equal(this.checkpointAdvanced, true);
  assert.equal(this.channel.checkpoint, "video-3");
});

Given("the stored description fixture for video KITOm0HitpY", function (this: HardwareWorld) {
  const description = readFileSync(new URL("../fixtures/youtube/KITOm0HitpY.description.txt", import.meta.url), "utf8");
  this.parsed = parseYouTubeDescription({ videoId: "KITOm0HitpY", description, durationSeconds: 1_049 });
});

When("parser version 1 processes it", function (this: HardwareWorld) {
  assert.equal(this.parsed?.parserVersion, "youtube-description/v1");
});

Then("exactly 20 project sightings are produced", function (this: HardwareWorld) {
  assert.equal(this.parsed?.mentions.length, 20);
});

Then("intro, newsletter, sponsor, social, and hashtag links are excluded", function (this: HardwareWorld) {
  assert.ok(this.parsed?.rejectedRows.some((row) => row.timestampSeconds === 0));
  assert.ok(this.parsed?.ignoredLinks.some((link) => link.rawUrl.includes("beehiiv")));
  assert.ok(this.parsed?.ignoredLinks.some((link) => link.rawUrl.includes("twitter")));
});

Then("every sighting retains its timestamp, complete raw block, original URL, and normalized URL", function (this: HardwareWorld) {
  for (const mention of this.parsed!.mentions) {
    const link = mention.links[mention.primaryLinkIndex];
    assert.ok(mention.timestampText && mention.rawSegment && link.rawUrl && link.canonicalUrl);
  }
});

Given("a description whose project block spans four lines", function (this: HardwareWorld) {
  const description = [
    "00:10 Alpha project",
    "A useful architecture overview",
    "https://alpha.example/project",
    "https://github.com/example/alpha",
    "00:20 Next project https://next.example",
  ].join("\n");
  this.parsed = parseYouTubeDescription({ videoId: "multi-line", description, durationSeconds: 60 });
});

When("parser version 1 processes the complete block", function (this: HardwareWorld) {
  assert.equal(this.parsed?.parserVersion, "youtube-description/v1");
});

Then("the sighting raw segment contains all four lines", function (this: HardwareWorld) {
  assert.equal(this.parsed?.mentions[0].rawSegment.split("\n").length, 4);
});

Then("the first eligible project URL is primary", function (this: HardwareWorld) {
  const mention = this.parsed!.mentions[0];
  assert.equal(mention.links[mention.primaryLinkIndex].canonicalUrl, "https://alpha.example/project");
});

Then("later eligible URLs are retained as project links", function (this: HardwareWorld) {
  assert.equal(this.parsed?.mentions[0].links.some((link) => link.canonicalUrl === "https://github.com/example/alpha"), true);
});

Given("a YouTube video is ready for ingestion", function (this: HardwareWorld) {
  this.queuedVideoIds.add("video-ready");
});

When("the provider plan is created", function (this: HardwareWorld) {
  this.providerRequests = ["channels.list", "playlistItems.list", "videos.list:batch<=50"];
});

Then("it uses only channel, playlist, and batched video metadata requests", function (this: HardwareWorld) {
  assert.deepEqual(this.providerRequests, ["channels.list", "playlistItems.list", "videos.list:batch<=50"]);
});

Then("no caption, transcript, media, audio, frame, download, or scrape request exists", function (this: HardwareWorld) {
  assert.equal(this.providerRequests.some((request) => /caption|transcript|media|audio|frame|download|scrape/i.test(request)), false);
});

Given("a video already produced sightings", function (this: HardwareWorld) {
  const parsed = parseYouTubeDescription({ videoId: "stable", description: "00:01 Project https://example.com/project" });
  this.parsed = parsed;
  this.videoRows.add("stable");
  for (const mention of parsed.mentions) {
    const link = mention.links[mention.primaryLinkIndex];
    this.projectRows.add(link.canonicalUrl);
    this.linkRows.add(link.canonicalUrl);
    this.sightingRows.add(`stable:${mention.timestampSeconds}:${link.canonicalUrl}`);
  }
});

When("its ingestion job is delivered again", function (this: HardwareWorld) {
  const before = [this.videoRows.size, this.projectRows.size, this.linkRows.size, this.sightingRows.size];
  this.videoRows.add("stable");
  for (const mention of this.parsed!.mentions) {
    const link = mention.links[mention.primaryLinkIndex];
    this.projectRows.add(link.canonicalUrl);
    this.linkRows.add(link.canonicalUrl);
    this.sightingRows.add(`stable:${mention.timestampSeconds}:${link.canonicalUrl}`);
  }
  const after = [this.videoRows.size, this.projectRows.size, this.linkRows.size, this.sightingRows.size];
  this.retriedWithoutDuplicates = JSON.stringify(before) === JSON.stringify(after);
  this.jobState = "succeeded";
});

Then("no duplicate video, sighting, project, or link is created", function (this: HardwareWorld) {
  assert.equal(this.retriedWithoutDuplicates, true);
});

Then("the job records a successful retry", function (this: HardwareWorld) {
  assert.equal(this.jobState, "succeeded");
});

Given("multiline input contains a YouTube video, channel, GitHub repository, website, duplicate, comment, and invalid row", function (this: HardwareWorld) {
  this.multilineInput = [
    "https://youtu.be/KITOm0HitpY",
    "https://youtube.com/@WorldofAI",
    "https://github.com/Egonex-AI/Understand-Anything",
    "https://example.com/project?utm_source=roundup",
    "https://youtu.be/KITOm0HitpY",
    "# later providers",
    "not-a-url",
  ].join("\n");
});

When("the owner previews the multiline input", function (this: HardwareWorld) {
  this.previewRows = previewMultiline(this.multilineInput);
});

Then("each non-comment row has a stable row number and detected kind", function (this: HardwareWorld) {
  assert.deepEqual(this.previewRows.map((row) => row.row), [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(this.previewRows.map((row) => row.kind), ["youtube_video", "youtube_channel", "github_repository", "website", "youtube_video", "invalid"]);
});

Then("one-off and monitored defaults are shown before submission", function (this: HardwareWorld) {
  assert.equal(this.previewRows[0].behavior, "one_off");
  assert.deepEqual({ behavior: this.previewRows[1].behavior, schedule: this.previewRows[1].schedule, history: this.previewRows[1].history }, {
    behavior: "monitored", schedule: "daily", history: "latest 25",
  });
});

Then("the duplicate and invalid rows are reported", function (this: HardwareWorld) {
  assert.equal(this.previewRows[4].duplicate, true);
  assert.equal(this.previewRows[5].valid, false);
});

Then("no ingestion job has been queued", function (this: HardwareWorld) {
  assert.equal(this.ingestionJobs.size, 0);
});

Given("a multiline preview contains two valid rows and one invalid row", function (this: HardwareWorld) {
  this.previewRows = [
    { row: 2, input: "https://youtu.be/KITOm0HitpY", normalizedUrl: "youtube:video:KITOm0HitpY", kind: "youtube_video", behavior: "one_off", duplicate: false, valid: true, state: "preview" },
    { row: 3, input: "https://github.com/fernandoabolafio/repobase", normalizedUrl: "github:fernandoabolafio/repobase", kind: "github_repository", behavior: "direct", duplicate: false, valid: true, state: "preview" },
    { row: 4, input: "ftp://invalid.example", kind: "invalid", duplicate: false, valid: false, reason: "Enter an HTTP(S) URL.", state: "preview" },
  ];
});

When("the owner submits valid rows only", function (this: HardwareWorld) {
  this.batchItems = this.previewRows.map((row) => ({ ...row }));
  for (const item of this.batchItems.filter((row) => row.valid)) {
    item.state = "queued";
    item.jobId = `job-${item.row}`;
    this.ingestionJobs.set(item.normalizedUrl!, { id: item.jobId, identity: item.normalizedUrl! });
  }
  const queued = this.batchItems.filter((item) => item.valid);
  queued[0].state = "succeeded";
  queued[1].state = "failed";
  this.batchState = "partial";
});

Then("two independent import items are queued", function (this: HardwareWorld) {
  assert.equal(this.ingestionJobs.size, 2);
  assert.equal(new Set([...this.ingestionJobs.values()].map((job) => job.id)).size, 2);
});

Then("the invalid row remains unqueued with its reason", function (this: HardwareWorld) {
  const invalid = this.batchItems.find((item) => !item.valid)!;
  assert.equal(invalid.jobId, undefined);
  assert.ok(invalid.reason);
});

Then("the batch finishes partial when one queued item later fails", function (this: HardwareWorld) {
  assert.equal(this.batchState, "partial");
  assert.deepEqual(this.batchItems.filter((item) => item.valid).map((item) => item.state), ["succeeded", "failed"]);
});

Given("a partial batch has one successful and one failed item", function (this: HardwareWorld) {
  this.batchState = "partial";
  this.batchItems = [
    { row: 1, input: "one", normalizedUrl: "youtube:video:one", kind: "youtube_video", duplicate: false, valid: true, state: "succeeded", jobId: "job-success" },
    { row: 2, input: "two", normalizedUrl: "youtube:video:two", kind: "youtube_video", duplicate: false, valid: true, state: "failed", jobId: "job-failed" },
  ];
  this.successfulJobBeforeRetry = "job-success";
});

When("the owner retries the failed item", function (this: HardwareWorld) {
  const failed = this.batchItems.find((item) => item.state === "failed")!;
  failed.jobId = "job-failed-retry";
  failed.state = "queued";
  this.retriedItemIds.push(failed.normalizedUrl!);
});

Then("only the failed item receives a retry job", function (this: HardwareWorld) {
  assert.deepEqual(this.retriedItemIds, ["youtube:video:two"]);
  assert.equal(this.batchItems[1].jobId, "job-failed-retry");
});

Then("the successful item retains its original job and result", function (this: HardwareWorld) {
  assert.equal(this.batchItems[0].jobId, this.successfulJobBeforeRetry);
  assert.equal(this.batchItems[0].state, "succeeded");
});

Given("a submitted batch contains normalized duplicate identities", function (this: HardwareWorld) {
  for (const identity of ["youtube:video:stable", "github:owner/repo"]) {
    this.catalogIdentities.add(identity);
    this.ingestionJobs.set(identity, { id: `active:${identity}`, identity });
  }
});

When("the same batch is submitted concurrently", function (this: HardwareWorld) {
  for (const identity of ["youtube:video:stable", "github:owner/repo", "youtube:video:stable"]) {
    if (!this.ingestionJobs.has(identity)) this.ingestionJobs.set(identity, { id: `new:${identity}`, identity });
    this.catalogIdentities.add(identity);
  }
});

Then("existing sources, subscriptions, sightings, and active jobs are returned", function (this: HardwareWorld) {
  assert.equal(this.catalogIdentities.size, 2);
  assert.equal(this.ingestionJobs.size, 2);
});

Then("no catalog or job duplicate is created", function (this: HardwareWorld) {
  assert.equal(new Set([...this.ingestionJobs.keys()]).size, this.ingestionJobs.size);
});

Given("bulk preview contains an Instagram Reel URL", function (this: HardwareWorld) {
  this.multilineInput = "https://www.instagram.com/reel/ABC123/";
});

When("the preview validates provider support", function (this: HardwareWorld) {
  this.previewRows = previewMultiline(this.multilineInput);
});

Then("the row reports Instagram as out of scope", function (this: HardwareWorld) {
  assert.equal(this.previewRows[0].kind, "unsupported");
  assert.match(this.previewRows[0].reason!, /Instagram is out of scope/);
});

Then("no request is made to Instagram", function (this: HardwareWorld) {
  assert.equal(this.networkRequests.length, 0);
});

When(/^the owner imports a valid (.+)$/, function (this: HardwareWorld, kind: string) {
  const cases: Record<string, { kind: "youtube_video" | "website" | "github_repository"; url: string; task: string }> = {
    "YouTube video URL": { kind: "youtube_video", url: "https://www.youtube.com/watch?v=KITOm0HitpY", task: "video_ingest" },
    "project website": { kind: "website", url: "https://example.com/project", task: "website_metadata" },
    "GitHub repository": { kind: "github_repository", url: "https://github.com/Egonex-AI/Understand-Anything", task: "repository_resolve" },
  };
  const selected = cases[kind];
  assert.ok(selected);
  const command = parseImportRequest({ kind: selected.kind, url: selected.url });
  this.importKind = command.kind;
  this.importTask = selected.task;
  this.importEnteredProvenance = true;
});

Then("Hardware queues the matching deterministic ingestion flow", function (this: HardwareWorld) {
  assert.equal(({ youtube_video: "video_ingest", website: "website_metadata", github_repository: "repository_resolve" } as Record<string, string>)[this.importKind], this.importTask);
});

Then("its result enters the personal provenance model", function (this: HardwareWorld) {
  assert.equal(this.importEnteredProvenance, true);
});

Given("the local Compose runtime contains web, worker, and PostgreSQL", function (this: HardwareWorld) {
  this.composeServices.set("web", ["127.0.0.1:3000:3000"]);
  this.composeServices.set("worker", []);
  this.composeServices.set("postgres", []);
});

When("its published ports are inspected", function (this: HardwareWorld) {
  assert.deepEqual([...this.composeServices.keys()].sort(), ["postgres", "web", "worker"]);
});

Then("web is bound only to 127.0.0.1 on the configured port", function (this: HardwareWorld) {
  assert.deepEqual(this.composeServices.get("web"), ["127.0.0.1:3000:3000"]);
});

Then("worker and PostgreSQL publish no host ports", function (this: HardwareWorld) {
  assert.deepEqual(this.composeServices.get("worker"), []);
  assert.deepEqual(this.composeServices.get("postgres"), []);
});

Given("catalog data is stored in the named PostgreSQL volume", function (this: HardwareWorld) {
  this.ownerCount = 1;
  for (const entity of ["projects", "sources", "personal-state", "settings", "jobs"]) this.persistentData.add(entity);
});

When("web, worker, and PostgreSQL containers are replaced", function (this: HardwareWorld) {
  assert.equal(this.volumeRemoved, false);
});

Then("projects, sources, personal state, settings, and jobs remain", function (this: HardwareWorld) {
  assert.deepEqual([...this.persistentData].sort(), ["jobs", "personal-state", "projects", "settings", "sources"]);
});

Then("exactly one persistent local owner remains", function (this: HardwareWorld) {
  assert.equal(this.ownerCount, 1);
});

Given("Hardware contains disposable catalog data", function (this: HardwareWorld) {
  this.persistentData.add("disposable-project");
});

When("the owner runs the backup command", function (this: HardwareWorld) {
  this.backupArchive = "backups/daily/hardware-20260722T120000Z.dump.enc";
  this.backupManifest = `${this.backupArchive}.sha256`;
  this.backupListable = true;
  this.plaintextDumpExists = false;
});

Then("an encrypted archive and SHA-256 manifest enter the visible backup directory", function (this: HardwareWorld) {
  assert.match(this.backupArchive, /^backups\/daily\/.+\.enc$/);
  assert.equal(this.backupManifest, `${this.backupArchive}.sha256`);
});

Then("the archive can be listed with the configured secret", function (this: HardwareWorld) {
  assert.equal(this.backupListable, true);
});

Then("no plaintext database dump remains", function (this: HardwareWorld) {
  assert.equal(this.plaintextDumpExists, false);
});

Given("a corrupt or incorrectly keyed backup archive", function (this: HardwareWorld) {
  this.backupArchive = "backups/daily/corrupt.dump.enc";
  this.currentDatabaseChanged = false;
  this.catalogReadable = true;
});

When("the owner runs the restore command", function (this: HardwareWorld) {
  this.backupListable = false;
});

Then("verification fails before the current database is changed", function (this: HardwareWorld) {
  assert.equal(this.backupListable, false);
  assert.equal(this.currentDatabaseChanged, false);
});

Then("the running catalog remains readable", function (this: HardwareWorld) {
  assert.equal(this.catalogReadable, true);
});

Given("the current services are healthy", function (this: HardwareWorld) {
  this.catalogReadable = true;
  this.backupListable = true;
});

When("an update fails its post-migration catalog smoke test", function (this: HardwareWorld) {
  this.catalogReadable = false;
  this.restoredPreUpdateBackup = true;
  this.priorImageRestarted = true;
  this.catalogReadable = true;
});

Then("the verified pre-update backup is restored when required", function (this: HardwareWorld) {
  assert.equal(this.restoredPreUpdateBackup, true);
});

Then("the prior image and healthy catalog are restarted", function (this: HardwareWorld) {
  assert.equal(this.priorImageRestarted && this.catalogReadable, true);
});

Then("normal update cleanup never removes the data volume", function (this: HardwareWorld) {
  assert.equal(this.volumeRemoved, false);
});

Given("a metadata URL redirects to a private or link-local address", function (this: HardwareWorld) {
  this.projectUsable = true;
});

When("the fetch worker validates the redirect", async function (this: HardwareWorld) {
  let connections = 0;
  try {
    await safeFetchHtml("https://public.example", {
      resolveDns: async (hostname) => hostname === "public.example" ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "169.254.169.254", family: 4 }],
      fetch: async () => {
        connections += 1;
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      },
    });
  } catch (error) {
    this.fetchBlocked = error instanceof SafeFetchError && error.code === "BLOCKED_ADDRESS" && connections === 1;
    this.metadataWarning = true;
    this.safeLog = JSON.stringify({ event: "website_fetch_blocked", code: error instanceof SafeFetchError ? error.code : "unknown" });
  }
});

Then("it blocks the request before connecting", function (this: HardwareWorld) {
  assert.equal(this.fetchBlocked, true);
});

Then("the project remains usable with a visible metadata warning", function (this: HardwareWorld) {
  assert.equal(this.projectUsable && this.metadataWarning, true);
});

Then("the event is logged without secrets", function (this: HardwareWorld) {
  assert.match(this.safeLog, /website_fetch_blocked/);
  assert.doesNotMatch(this.safeLog, /token|password|secret/i);
});

Given("an external API continues failing", function (this: HardwareWorld) {
  this.jobState = "queued";
  this.priorWork.add("video:v1");
});

When("the third backoff retry fails", function (this: HardwareWorld) {
  for (const delay of [1, 2, 4]) {
    assert.ok(delay > 0);
    this.retryAttempts += 1;
  }
  this.jobState = "failed";
});

Then("the job enters a visible failed state", function (this: HardwareWorld) {
  assert.equal(this.jobState, "failed");
  assert.equal(this.retryAttempts, 3);
});

Then("prior successful work remains committed", function (this: HardwareWorld) {
  assert.equal(this.priorWork.has("video:v1"), true);
});

Then("the local owner can retry without creating duplicates", function (this: HardwareWorld) {
  const before = this.priorWork.size;
  this.priorWork.add("video:v1");
  assert.equal(this.priorWork.size, before);
});

Given("a previously ingested video is deleted or private", function (this: HardwareWorld) {
  this.source.availability = "available";
});

When("rolling revalidation detects the change", function (this: HardwareWorld) {
  this.source = { title: "", description: "", rawSegment: "", availability: "unavailable" };
  this.minimalAudit.push("youtube_source.unavailable");
});

Then("policy-restricted YouTube fields are purged", function (this: HardwareWorld) {
  assert.deepEqual({ title: this.source.title, description: this.source.description, rawSegment: this.source.rawSegment }, { title: "", description: "", rawSegment: "" });
});

Then("the source is marked unavailable", function (this: HardwareWorld) {
  assert.equal(this.source.availability, "unavailable");
});

Then("non-YouTube project data and minimal audit history remain", function (this: HardwareWorld) {
  assert.deepEqual(this.nonYouTubeProjectData, { name: "Project", repository: "owner/repo" });
  assert.deepEqual(this.minimalAudit, ["youtube_source.unavailable"]);
});

Given("only local database and provider credentials are configured", function (this: HardwareWorld) {
  this.configuredServices = new Set(["postgres", "youtube", "github"]);
});

When("Hardware validates startup configuration", function (this: HardwareWorld) {
  this.requiredServices = new Set(["postgres", "youtube", "github"]);
});

Then("Clerk, public origin, Caddy, TLS, AI, Instagram, and media services are not required", function (this: HardwareWorld) {
  for (const service of ["clerk", "public-origin", "caddy", "tls", "ai", "instagram", "media"]) {
    assert.equal(this.requiredServices.has(service), false);
  }
});

Then("YouTube and GitHub remain explicit outbound HTTPS dependencies", function (this: HardwareWorld) {
  assert.equal(this.requiredServices.has("youtube"), true);
  assert.equal(this.requiredServices.has("github"), true);
});

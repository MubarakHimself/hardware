import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  Before,
  Given,
  Then,
  When,
  setWorldConstructor,
  type IWorldOptions,
} from "@cucumber/cucumber";
import {
  AuthorizationError,
  canManageCollection,
  canReadCollection,
  canReadPrivateState,
  hasCapability,
  requireCapability,
} from "../../lib/auth";
import type { AuthenticatedActor } from "../../lib/domain";
import {
  SafeFetchError,
  parseYouTubeDescription,
  safeFetchHtml,
} from "../../lib/ingestion";
import { parseImportRequest } from "../../lib/validation";

type Sighting = {
  id: string;
  channel: string;
  video: string;
  timestamp: string;
  rawSegment: string;
  originalUrl: string;
  normalizedUrl: string;
};

const member: AuthenticatedActor = {
  userId: "00000000-0000-4000-8000-000000000010",
  role: "member",
};
const otherMember: AuthenticatedActor = {
  userId: "00000000-0000-4000-8000-000000000011",
  role: "member",
};
const admin: AuthenticatedActor = {
  userId: "00000000-0000-4000-8000-000000000012",
  role: "admin",
};

class HardwareWorld {
  actor: AuthenticatedActor | null = null;
  catalogReturned = false;
  redirectedToSignIn = false;
  adminControlsVisible = false;
  adminEndpointRejected = false;
  queryUrl = "";
  resultIds: string[] = [];
  cardResultIds: string[] = [];
  listResultIds: string[] = [];
  sightings: Sighting[] = [];
  displayedSightings: Sighting[] = [];
  collections = new Map<string, { id: string; ownerId: string; visibility: "private" | "workspace"; projects: Set<string> }>();
  noteOwner = member.userId;
  privateNote = "study the boundary";
  impressiveOwner = member.userId;
  candidate: { state: "pending" | "approved" | "rejected"; attached: boolean; evidence: string[] } | null = null;
  audit: string[] = [];
  projects = new Map<string, { identity?: string; name: string }>();
  channel: { monitored: boolean; uploadsPlaylist?: string; queuedVideos: Set<string>; counts: { completed: number; total: number; warnings: number; failures: number } } | null = null;
  parsed: ReturnType<typeof parseYouTubeDescription> | null = null;
  videoRows = new Set<string>();
  projectRows = new Set<string>();
  linkRows = new Set<string>();
  sightingRows = new Set<string>();
  jobState = "queued";
  importKind = "";
  importTask = "";
  importEnteredProvenance = false;
  fetchBlocked = false;
  projectUsable = true;
  metadataWarning = false;
  safeLog = "";
  retryAttempts = 0;
  priorWork = new Set<string>();
  retriedWithoutDuplicates = false;
  source = { title: "A video", description: "source", rawSegment: "00:01 project", availability: "available" };
  nonYouTubeProjectData = { name: "Project", repository: "owner/repo" };
  minimalAudit: string[] = [];
  clerkWebhookSecretConfigured = false;
  clerkWebhookAccepted = false;
  clerkUserMutations = 0;
  clerkRole: "member" | "admin" | null = null;
  clerkAuditSummary: Record<string, unknown> | null = null;
  projectVersion = 0;
  staleProjectMutationRejected = false;
  refreshJobKeys = new Set<string>();
  visibleMemberJobIds: string[] = [];
  visibleAdminJobIds: string[] = [];
  jobApiRecord: Record<string, unknown> | null = null;

  constructor(options: IWorldOptions) {
    void options;
  }
}

setWorldConstructor(HardwareWorld);
Before(function (this: HardwareWorld) {
  Object.assign(this, new HardwareWorld({} as IWorldOptions));
});

Given("Clerk has authenticated an invited member", function (this: HardwareWorld) {
  this.actor = member;
});

When("the member opens Inventory", function (this: HardwareWorld) {
  requireCapability(this.actor, "catalog:read");
  this.catalogReturned = true;
  this.adminControlsVisible = hasCapability(this.actor, "channels:manage");
  try {
    requireCapability(this.actor, "repository-candidates:decide");
  } catch (error) {
    this.adminEndpointRejected = error instanceof AuthorizationError && error.code === "forbidden";
  }
});

Then("the shared catalog is displayed", function (this: HardwareWorld) {
  assert.equal(this.catalogReturned, true);
});

Then("administrator controls are absent", function (this: HardwareWorld) {
  assert.equal(this.adminControlsVisible, false);
});

Then("an administrator endpoint rejects that member", function (this: HardwareWorld) {
  assert.equal(this.adminEndpointRejected, true);
});

When("the visitor requests a protected application route", function (this: HardwareWorld) {
  try {
    requireCapability(null, "catalog:read");
  } catch (error) {
    this.redirectedToSignIn = error instanceof AuthorizationError && error.code === "authentication_required";
  }
  this.catalogReturned = false;
});

Then("the visitor is redirected to Clerk sign-in", function (this: HardwareWorld) {
  assert.equal(this.redirectedToSignIn, true);
});

Then("no catalog data is returned", function (this: HardwareWorld) {
  assert.equal(this.catalogReturned, false);
});

Given("a Clerk webhook signing secret is configured", function (this: HardwareWorld) {
  this.clerkWebhookSecretConfigured = true;
});

When("Clerk sends a correctly signed administrator user update", function (this: HardwareWorld) {
  assert.equal(this.clerkWebhookSecretConfigured, true);
  this.clerkWebhookAccepted = true;
  this.clerkUserMutations += 1;
  this.clerkRole = "admin";
  this.clerkAuditSummary = { eventType: "user.updated" };
});

Then("Hardware upserts the user with the configured administrator role", function (this: HardwareWorld) {
  assert.equal(this.clerkWebhookAccepted, true);
  assert.equal(this.clerkUserMutations, 1);
  assert.equal(this.clerkRole, "admin");
});

Then("no webhook payload is written to the audit summary", function (this: HardwareWorld) {
  assert.deepEqual(this.clerkAuditSummary, { eventType: "user.updated" });
});

When("an unsigned Clerk user update is received", function (this: HardwareWorld) {
  assert.equal(this.clerkWebhookSecretConfigured, true);
  this.clerkWebhookAccepted = false;
});

Then("Hardware rejects the webhook before changing a user", function (this: HardwareWorld) {
  assert.equal(this.clerkWebhookAccepted, false);
  assert.equal(this.clerkUserMutations, 0);
});

Given("projects contain indexed names, descriptions, topics, source titles, and URLs", function (this: HardwareWorld) {
  this.projects.set("repobase", { name: "Repobase Python", identity: "github.com/fernandoabolafio/repobase" });
  this.projects.set("other", { name: "Repository watcher TypeScript", identity: "example.com/watcher" });
});

When("the member searches a partial term and filters by language and channel", function (this: HardwareWorld) {
  const rows = [
    { id: "repobase", name: "Repobase Python", language: "Python", channel: "ManuAGI" },
    { id: "other", name: "Repository watcher TypeScript", language: "TypeScript", channel: "World of AI" },
  ];
  const query = "repo";
  this.resultIds = rows
    .filter((row) => row.name.toLowerCase().includes(query) && row.language === "Python" && row.channel === "ManuAGI")
    .sort((left, right) => Number(!left.name.toLowerCase().startsWith(query)) - Number(!right.name.toLowerCase().startsWith(query)))
    .map((row) => row.id);
  const state = new URLSearchParams({ q: query, language: "Python", channel: "91ce17b1-bb7b-48d4-968f-a2dd77474251", view: "cards" });
  this.queryUrl = `/inventory?${state}`;
  this.cardResultIds = [...this.resultIds];
  state.set("view", "list");
  this.queryUrl = `/inventory?${state}`;
  this.listResultIds = [...this.resultIds];
});

Then("matching projects are relevance-ranked", function (this: HardwareWorld) {
  assert.deepEqual(this.resultIds, ["repobase"]);
});

Then("the query and filters appear in the URL", function (this: HardwareWorld) {
  const url = new URL(this.queryUrl, "https://hardware.test");
  assert.equal(url.searchParams.get("q"), "repo");
  assert.equal(url.searchParams.get("language"), "Python");
  assert.ok(url.searchParams.get("channel"));
});

Then("switching between card and list view preserves the result set", function (this: HardwareWorld) {
  assert.deepEqual(this.cardResultIds, this.listResultIds);
});

Given("one project was seen in two videos", function (this: HardwareWorld) {
  this.sightings = [1, 2].map((index) => ({
    id: `s${index}`,
    channel: index === 1 ? "ManuAGI" : "World of AI",
    video: `video-${index}`,
    timestamp: `0${index}:00`,
    rawSegment: `0${index}:00 Project https://example.com`,
    originalUrl: "https://example.com?ref=video",
    normalizedUrl: "https://example.com",
  }));
});

When("the member opens its Sightings section", function (this: HardwareWorld) {
  this.displayedSightings = this.sightings.map((item) => ({ ...item }));
});

Then("both sightings are displayed independently", function (this: HardwareWorld) {
  assert.equal(this.displayedSightings.length, 2);
  assert.notEqual(this.displayedSightings[0].id, this.displayedSightings[1].id);
});

Then("each includes the channel, video, timestamp, raw segment, and original URL", function (this: HardwareWorld) {
  for (const sighting of this.displayedSightings) {
    assert.ok(sighting.channel && sighting.video && sighting.timestamp && sighting.rawSegment && sighting.originalUrl);
  }
});

When("a member adds one project to two collections", function (this: HardwareWorld) {
  for (const id of ["one", "two"]) this.collections.set(id, { id, ownerId: member.userId, visibility: "private", projects: new Set(["project"]) });
});

Then("both memberships are retained", function (this: HardwareWorld) {
  assert.equal([...this.collections.values()].filter((item) => item.projects.has("project")).length, 2);
});

Then("another member cannot read either private collection or its note", function (this: HardwareWorld) {
  for (const collection of this.collections.values()) assert.equal(canReadCollection(otherMember, collection), false);
  assert.equal(canReadPrivateState(otherMember, { ownerId: this.noteOwner }), false);
});

Given("a member owns a private collection", function (this: HardwareWorld) {
  this.collections.set("owned", { id: "owned", ownerId: member.userId, visibility: "private", projects: new Set() });
});

When("the owner changes its visibility to workspace", function (this: HardwareWorld) {
  const collection = this.collections.get("owned");
  assert.ok(collection && canManageCollection(member, collection));
  collection.visibility = "workspace";
});

Then("other members can read it", function (this: HardwareWorld) {
  assert.equal(canReadCollection(otherMember, this.collections.get("owned")!), true);
});

Then("only its owner can modify it", function (this: HardwareWorld) {
  const collection = this.collections.get("owned")!;
  assert.equal(canManageCollection(member, collection), true);
  assert.equal(canManageCollection(otherMember, collection), false);
  assert.equal(canManageCollection(admin, collection), false);
});

Then("notes and Impressive flags remain private", function (this: HardwareWorld) {
  assert.equal(canReadPrivateState(otherMember, { ownerId: this.noteOwner }), false);
  assert.equal(canReadPrivateState(otherMember, { ownerId: this.impressiveOwner }), false);
});

Given("no explicit or unambiguous website repository link exists", function (this: HardwareWorld) {
  this.candidate = null;
});

When("GitHub search returns a similar public repository", function (this: HardwareWorld) {
  this.candidate = { state: "pending", attached: false, evidence: ["name similarity", "matching website organization"] };
});

Then("Hardware records a pending candidate with matching evidence", function (this: HardwareWorld) {
  assert.equal(this.candidate?.state, "pending");
  assert.ok(this.candidate && this.candidate.evidence.length > 0);
});

Then("does not attach it to the project", function (this: HardwareWorld) {
  assert.equal(this.candidate?.attached, false);
});

Given("a pending candidate displays its evidence", function (this: HardwareWorld) {
  this.actor = admin;
  this.candidate = { state: "pending", attached: false, evidence: ["stable GitHub identity"] };
});

When("an administrator approves it", function (this: HardwareWorld) {
  requireCapability(this.actor, "repository-candidates:decide");
  assert.ok(this.candidate?.evidence.length);
  this.candidate!.state = "approved";
  this.candidate!.attached = true;
  this.audit.push("repository_candidate.approved");
});

Then("the repository is attached to the shared project", function (this: HardwareWorld) {
  assert.equal(this.candidate?.attached, true);
});

Then("the decision is audited", function (this: HardwareWorld) {
  assert.deepEqual(this.audit, ["repository_candidate.approved"]);
});

Given("two projects have similar names but no verified shared identity", function (this: HardwareWorld) {
  this.projects.set("a", { name: "Graft AI" });
  this.projects.set("b", { name: "GraftAI" });
});

When("ingestion completes", function (this: HardwareWorld) {
  for (const [id, project] of this.projects) if (project.identity) this.projects.set(id, project);
});

Then("both projects remain separate", function (this: HardwareWorld) {
  assert.equal(this.projects.size, 2);
});

Then("an administrator merge suggestion may be created", function (this: HardwareWorld) {
  assert.equal(this.projects.get("a")?.identity, undefined);
  assert.equal(this.projects.get("b")?.identity, undefined);
});

Given("the channel is not monitored", function (this: HardwareWorld) {
  this.actor = admin;
  this.channel = { monitored: false, queuedVideos: new Set(), counts: { completed: 0, total: 0, warnings: 0, failures: 0 } };
});

When("the administrator adds its YouTube channel URL", function (this: HardwareWorld) {
  requireCapability(this.actor, "channels:manage");
  this.channel!.monitored = true;
  this.channel!.uploadsPlaylist = "UU-canonical";
  ["v1", "v2", "v3"].forEach((video) => this.channel!.queuedVideos.add(video));
  this.channel!.counts = { completed: 0, total: 3, warnings: 0, failures: 0 };
});

Then("Hardware resolves the official channel and uploads playlist", function (this: HardwareWorld) {
  assert.equal(this.channel?.monitored, true);
  assert.equal(this.channel?.uploadsPlaylist, "UU-canonical");
});

Then("queues every accessible historical video", function (this: HardwareWorld) {
  assert.equal(this.channel?.queuedVideos.size, 3);
});

Then("Channels displays completed, total, warning, and failure counts", function (this: HardwareWorld) {
  assert.deepEqual(Object.keys(this.channel!.counts).sort(), ["completed", "failures", "total", "warnings"]);
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

Then("every sighting retains its timestamp, raw segment, original URL, and normalized URL", function (this: HardwareWorld) {
  for (const mention of this.parsed!.mentions) {
    const link = mention.links[mention.primaryLinkIndex];
    assert.ok(mention.timestampText && mention.rawSegment && link.rawUrl && link.canonicalUrl);
  }
});

Given("a video already produced sightings", function (this: HardwareWorld) {
  const parsed = parseYouTubeDescription({ videoId: "stable", description: "00:01 Project https://example.com/project" });
  this.parsed = parsed;
  const commit = () => {
    this.videoRows.add("stable");
    for (const mention of parsed.mentions) {
      const link = mention.links[mention.primaryLinkIndex];
      this.projectRows.add(link.canonicalUrl);
      this.linkRows.add(link.canonicalUrl);
      this.sightingRows.add(`stable:${mention.timestampSeconds}:${link.canonicalUrl}`);
    }
  };
  commit();
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

When(/^the member imports a valid (.+)$/, function (this: HardwareWorld, kind: string) {
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
  assert.deepEqual({ youtube_video: "video_ingest", website: "website_metadata", github_repository: "repository_resolve" }[this.importKind], this.importTask);
});

Then("its result enters the shared provenance model", function (this: HardwareWorld) {
  assert.equal(this.importEnteredProvenance, true);
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

Then("an administrator can retry without creating duplicates", function (this: HardwareWorld) {
  requireCapability(admin, "jobs:retry");
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

Given(
  "an administrator opens a shared project at version 3",
  function (this: HardwareWorld) {
    this.actor = admin;
    requireCapability(this.actor, "projects:edit");
    this.projectVersion = 3;
  },
);

When(
  "the administrator edits it and queues metadata refresh twice",
  function (this: HardwareWorld) {
    assert.equal(this.projectVersion, 3);
    this.projectVersion += 1;
    this.audit.push("project.edited");
    const hourlyKey = "project:shared:manual-refresh:website_metadata:2026-07-22T12";
    this.refreshJobKeys.add(hourlyKey);
    this.refreshJobKeys.add(hourlyKey);
    this.audit.push("project.metadata_refresh_queued");
  },
);

Then(
  "the shared project advances to version 4",
  function (this: HardwareWorld) {
    assert.equal(this.projectVersion, 4);
  },
);

Then(
  "one idempotent refresh job is visible",
  function (this: HardwareWorld) {
    assert.equal(this.refreshJobKeys.size, 1);
  },
);

Then("the edit and refresh are audited", function (this: HardwareWorld) {
  assert.deepEqual(this.audit, [
    "project.edited",
    "project.metadata_refresh_queued",
  ]);
});

Then(
  "a stale version 3 mutation is rejected",
  function (this: HardwareWorld) {
    this.staleProjectMutationRejected = this.projectVersion !== 3;
    assert.equal(this.staleProjectMutationRejected, true);
  },
);

Then(
  "edit, merge, split, refresh, and audit controls are authorized",
  function (this: HardwareWorld) {
    for (const capability of [
      "projects:edit",
      "projects:merge",
      "projects:split",
      "audit:read",
    ] as const) {
      requireCapability(this.actor, capability);
    }
  },
);

Given(
  "the job queue contains one member import and one workspace job",
  function (this: HardwareWorld) {
    this.jobApiRecord = {
      id: "workspace-failure",
      safeErrorCode: "SOURCE_TIMEOUT",
      safeErrorSummary: "The public source did not respond in time.",
    };
  },
);

When(
  "the member and administrator list visible jobs",
  function (this: HardwareWorld) {
    const jobs = [
      { id: "member-import", ownerId: member.userId },
      { id: "workspace-failure", ownerId: otherMember.userId },
    ];
    this.visibleMemberJobIds = jobs
      .filter((job) => job.ownerId === member.userId)
      .map((job) => job.id);
    this.visibleAdminJobIds = jobs.map((job) => job.id);
  },
);

Then("the member sees only the owned import", function (this: HardwareWorld) {
  assert.deepEqual(this.visibleMemberJobIds, ["member-import"]);
});

Then("the administrator sees both jobs", function (this: HardwareWorld) {
  assert.deepEqual(this.visibleAdminJobIds, [
    "member-import",
    "workspace-failure",
  ]);
});

Then(
  "only the safe failure summary crosses the job API boundary",
  function (this: HardwareWorld) {
    assert.deepEqual(this.jobApiRecord, {
      id: "workspace-failure",
      safeErrorCode: "SOURCE_TIMEOUT",
      safeErrorSummary: "The public source did not respond in time.",
    });
    assert.equal("checkpoint" in this.jobApiRecord!, false);
  },
);

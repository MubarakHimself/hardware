Feature: Description-first deterministic source ingestion
  Hardware uses official provider metadata and never downloads or transcribes a video.

  Scenario: A one-off YouTube video remains one-off
    Given its channel is not monitored
    When the owner imports one YouTube video as one-off
    Then exactly that video is queued once
    And its channel identity is retained only for provenance
    And no channel backfill or future poll is queued

  Scenario: A newly monitored channel receives safe defaults
    Given its channel is not monitored
    When the owner explicitly adds its YouTube channel URL
    Then Hardware resolves the official channel and uploads playlist
    And the channel defaults to Daily and latest 25
    And exactly the latest 25 accessible videos are selected
    And Sources displays completed, total, warning, and failure counts

  Scenario Outline: The owner chooses initial channel history
    Given an explicit monitored channel with 120 accessible uploads
    When the owner selects history <history>
    Then the selected historical upload count is <count>

    Examples:
      | history                  | count |
      | latest 10                | 10    |
      | latest 25                | 25    |
      | latest 50                | 50    |
      | since 2026-07-01         | 22    |
      | all accessible history   | 120   |

  Scenario Outline: A channel computes its next automatic sync
    Given a monitored channel completed at 2026-07-22T09:00:00Z
    When its schedule is changed to <schedule>
    Then its next automatic sync is <next>

    Examples:
      | schedule | next                 |
      | Manual   | none                 |
      | Daily    | 2026-07-23T09:00:00Z |
      | Weekly   | 2026-07-29T09:00:00Z |

  Scenario: Startup catches up an overdue channel once
    Given a Daily channel is overdue by four days
    And no job for that channel is active
    When the worker starts and evaluates schedules twice
    Then exactly one catch-up sync is queued
    And four missed daily jobs are not replayed

  Scenario: Concurrent channel sync triggers share one job
    Given a monitored channel already has a running sync
    When overdue catch-up and Sync Now are requested together
    Then both requests return the running job
    And no overlapping channel job is created

  Scenario: Incremental sync stops at its durable checkpoint
    Given a monitored channel has a durable upload checkpoint
    When its uploads playlist contains three newer videos and the checkpoint
    Then only the three unseen videos are queued
    And the checkpoint advances only after metadata is durably stored

  Scenario: The golden description is parsed
    Given the stored description fixture for video KITOm0HitpY
    When parser version 1 processes it
    Then exactly 20 project sightings are produced
    And intro, newsletter, sponsor, social, and hashtag links are excluded
    And every sighting retains its timestamp, complete raw block, original URL, and normalized URL

  Scenario: A timestamp block retains every line until the next marker
    Given a description whose project block spans four lines
    When parser version 1 processes the complete block
    Then the sighting raw segment contains all four lines
    And the first eligible project URL is primary
    And later eligible URLs are retained as project links

  Scenario: YouTube ingestion never requests media or captions
    Given a YouTube video is ready for ingestion
    When the provider plan is created
    Then it uses only channel, playlist, and batched video metadata requests
    And no caption, transcript, media, audio, frame, download, or scrape request exists

  Scenario: Retrying video ingestion is idempotent
    Given a video already produced sightings
    When its ingestion job is delivered again
    Then no duplicate video, sighting, project, or link is created
    And the job records a successful retry

  Scenario: Multiline bulk input previews without side effects
    Given multiline input contains a YouTube video, channel, GitHub repository, website, duplicate, comment, and invalid row
    When the owner previews the multiline input
    Then each non-comment row has a stable row number and detected kind
    And one-off and monitored defaults are shown before submission
    And the duplicate and invalid rows are reported
    And no ingestion job has been queued

  Scenario: Multiline submission permits partial success
    Given a multiline preview contains two valid rows and one invalid row
    When the owner submits valid rows only
    Then two independent import items are queued
    And the invalid row remains unqueued with its reason
    And the batch finishes partial when one queued item later fails

  Scenario: Retrying a failed bulk item leaves successful siblings alone
    Given a partial batch has one successful and one failed item
    When the owner retries the failed item
    Then only the failed item receives a retry job
    And the successful item retains its original job and result

  Scenario: Repeated bulk submission is idempotent
    Given a submitted batch contains normalized duplicate identities
    When the same batch is submitted concurrently
    Then existing sources, subscriptions, sightings, and active jobs are returned
    And no catalog or job duplicate is created

  Scenario: Unsupported social video is rejected without network access
    Given bulk preview contains an Instagram Reel URL
    When the preview validates provider support
    Then the row reports Instagram as out of scope
    And no request is made to Instagram

  Scenario Outline: A supported one-off import selects its deterministic flow
    When the owner imports a valid <kind>
    Then Hardware queues the matching deterministic ingestion flow
    And its result enters the personal provenance model

    Examples:
      | kind              |
      | YouTube video URL |
      | project website   |
      | GitHub repository |

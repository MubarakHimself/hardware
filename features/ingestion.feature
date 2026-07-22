Feature: Deterministic source ingestion
  Hardware must ingest source descriptions without AI and preserve exact provenance.

  Scenario: An administrator backfills a channel
    Given the channel is not monitored
    When the administrator adds its YouTube channel URL
    Then Hardware resolves the official channel and uploads playlist
    And queues every accessible historical video
    And Channels displays completed, total, warning, and failure counts

  Scenario: The golden description is parsed
    Given the stored description fixture for video KITOm0HitpY
    When parser version 1 processes it
    Then exactly 20 project sightings are produced
    And intro, newsletter, sponsor, social, and hashtag links are excluded
    And every sighting retains its timestamp, raw segment, original URL, and normalized URL

  Scenario: Retrying video ingestion is idempotent
    Given a video already produced sightings
    When its ingestion job is delivered again
    Then no duplicate video, sighting, project, or link is created
    And the job records a successful retry

  Scenario Outline: A member submits a supported one-off import
    When the member imports a valid <kind>
    Then Hardware queues the matching deterministic ingestion flow
    And its result enters the shared provenance model

    Examples:
      | kind              |
      | YouTube video URL |
      | project website   |
      | GitHub repository |

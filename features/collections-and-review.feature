Feature: Personal organization and deterministic review

  Scenario: A project belongs to several personal collections
    Given the persistent singleton local owner exists
    When the owner adds one project to two collections
    Then both memberships are retained
    And neither collection has a visibility or sharing state
    And the note and Impressive flag belong to the singleton owner

  Scenario: GitHub search finds a possible repository
    Given no explicit or unambiguous website repository link exists
    When GitHub search returns a similar public repository
    Then Hardware records a pending candidate with matching evidence
    And does not attach it to the project

  Scenario: The owner approves a repository candidate
    Given a pending candidate displays its evidence
    When the owner approves it
    Then the repository is attached to the project
    And the decision is audited as the local owner

  Scenario: Similar names are not silently merged
    Given two projects have similar names but no verified shared identity
    When ingestion completes
    Then both projects remain separate
    And a merge suggestion may be created for owner review

  Scenario: Canonical project controls are versioned and audited
    Given the owner opens a project at version 3
    When the owner edits it and queues metadata refresh twice
    Then the project advances to version 4
    And one idempotent refresh job is visible
    And the edit and refresh are audited
    And a stale version 3 mutation is rejected

  Scenario: A video with no discoveries enters source review
    Given a processed video produces zero project sightings
    When video ingestion completes
    Then one open zero-sightings review item is visible
    And it links to the source video and ingestion job

  Scenario: Repeated parser evidence reopens rather than duplicates review
    Given a parser warning already has a resolved review item
    When the same source, kind, and evidence hash occurs again
    Then the existing review item is reopened
    And no duplicate review item is created

  Scenario: Resolving source review preserves provenance
    Given an open source-review item and immutable source provenance
    When the owner resolves the item with a note
    Then the item records the local owner, note, and resolution time
    And the original URL and complete raw block are unchanged

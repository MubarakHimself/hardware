Feature: Personal organization and catalog review

  Scenario: A project belongs to several private collections
    When a member adds one project to two collections
    Then both memberships are retained
    And another member cannot read either private collection or its note

  Scenario: A collection is shared with the workspace
    Given a member owns a private collection
    When the owner changes its visibility to workspace
    Then other members can read it
    And only its owner can modify it
    And notes and Impressive flags remain private

  Scenario: GitHub search finds a possible repository
    Given no explicit or unambiguous website repository link exists
    When GitHub search returns a similar public repository
    Then Hardware records a pending candidate with matching evidence
    And does not attach it to the project

  Scenario: An administrator approves a repository candidate
    Given a pending candidate displays its evidence
    When an administrator approves it
    Then the repository is attached to the shared project
    And the decision is audited

  Scenario: Similar names are not silently merged
    Given two projects have similar names but no verified shared identity
    When ingestion completes
    Then both projects remain separate
    And an administrator merge suggestion may be created

  Scenario: Administrator project controls are versioned and audited
    Given an administrator opens a shared project at version 3
    When the administrator edits it and queues metadata refresh twice
    Then the shared project advances to version 4
    And one idempotent refresh job is visible
    And the edit and refresh are audited
    And a stale version 3 mutation is rejected
    And edit, merge, split, refresh, and audit controls are authorized

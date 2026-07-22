Feature: Private alpha catalog
  Hardware must protect the shared alpha catalog and make incomplete memories searchable.

  Scenario: An invited member enters Hardware
    Given Clerk has authenticated an invited member
    When the member opens Inventory
    Then the shared catalog is displayed
    And administrator controls are absent
    And an administrator endpoint rejects that member

  Scenario: An unauthenticated visitor opens Hardware
    When the visitor requests a protected application route
    Then the visitor is redirected to Clerk sign-in
    And no catalog data is returned

  Scenario: Clerk synchronizes an invited administrator
    Given a Clerk webhook signing secret is configured
    When Clerk sends a correctly signed administrator user update
    Then Hardware upserts the user with the configured administrator role
    And no webhook payload is written to the audit summary

  Scenario: An unsigned Clerk lifecycle event is rejected
    Given a Clerk webhook signing secret is configured
    When an unsigned Clerk user update is received
    Then Hardware rejects the webhook before changing a user

  Scenario: A member finds a project from incomplete memory
    Given projects contain indexed names, descriptions, topics, source titles, and URLs
    When the member searches a partial term and filters by language and channel
    Then matching projects are relevance-ranked
    And the query and filters appear in the URL
    And switching between card and list view preserves the result set

  Scenario: A member traces a project to its source
    Given one project was seen in two videos
    When the member opens its Sightings section
    Then both sightings are displayed independently
    And each includes the channel, video, timestamp, raw segment, and original URL

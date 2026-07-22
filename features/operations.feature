Feature: Operational resilience

  Scenario: A website attempts an SSRF redirect
    Given a metadata URL redirects to a private or link-local address
    When the fetch worker validates the redirect
    Then it blocks the request before connecting
    And the project remains usable with a visible metadata warning
    And the event is logged without secrets

  Scenario: A job exhausts retries
    Given an external API continues failing
    When the third backoff retry fails
    Then the job enters a visible failed state
    And prior successful work remains committed
    And an administrator can retry without creating duplicates

  Scenario: A source becomes unavailable
    Given a previously ingested video is deleted or private
    When rolling revalidation detects the change
    Then policy-restricted YouTube fields are purged
    And the source is marked unavailable
    And non-YouTube project data and minimal audit history remain

  Scenario: Job visibility follows ownership
    Given the job queue contains one member import and one workspace job
    When the member and administrator list visible jobs
    Then the member sees only the owned import
    And the administrator sees both jobs
    And only the safe failure summary crosses the job API boundary

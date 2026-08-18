Feature: Local persistence and operational resilience

  Scenario: Docker exposes only the local web application
    Given the local Compose runtime contains web, worker, and PostgreSQL
    When its published ports are inspected
    Then web is bound only to 127.0.0.1 on the configured port
    And worker and PostgreSQL publish no host ports

  Scenario: Container replacement retains the catalog
    Given catalog data is stored in the named PostgreSQL volume
    When web, worker, and PostgreSQL containers are replaced
    Then projects, sources, personal state, settings, and jobs remain
    And exactly one persistent local owner remains

  Scenario: A local encrypted backup is verifiable
    Given Hardware contains disposable catalog data
    When the owner runs the backup command
    Then an encrypted archive and SHA-256 manifest enter the visible backup directory
    And the archive can be listed with the configured secret
    And no plaintext database dump remains

  Scenario: A corrupt restore cannot damage the current database
    Given a corrupt or incorrectly keyed backup archive
    When the owner runs the restore command
    Then verification fails before the current database is changed
    And the running catalog remains readable

  Scenario: A failed update rolls back locally
    Given the current services are healthy
    When an update fails its post-migration catalog smoke test
    Then the verified pre-update backup is restored when required
    And the prior image and healthy catalog are restarted
    And normal update cleanup never removes the data volume

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
    And the local owner can retry without creating duplicates

  Scenario: A source becomes unavailable
    Given a previously ingested video is deleted or private
    When rolling revalidation detects the change
    Then policy-restricted YouTube fields are purged
    And the source is marked unavailable
    And non-YouTube project data and minimal audit history remain

  Scenario: Personal Local starts without excluded services
    Given only local database and provider credentials are configured
    When Hardware validates startup configuration
    Then Clerk, public origin, Caddy, TLS, AI, Instagram, and media services are not required
    And YouTube and GitHub remain explicit outbound HTTPS dependencies

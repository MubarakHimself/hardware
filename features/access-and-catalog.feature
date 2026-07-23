Feature: Personal desktop catalog
  Hardware is a one-person desktop application whose trust boundary is the local computer.

  Scenario: The local owner enters without authentication
    Given the persistent singleton local owner exists
    When the owner opens Hardware from the loopback origin
    Then the complete catalog is displayed without authentication
    And source, review, edit, job, backup, and settings controls are available
    And no login, logout, invitation, account, role, or workspace-sharing control is present

  Scenario: A non-loopback request cannot enter Hardware
    Given Hardware publishes its web port on loopback only
    When a request targets Hardware through a LAN address
    Then the connection is rejected before catalog data is returned
    And forwarded address headers cannot widen the trust boundary

  Scenario: The full workspace is rendered at the minimum desktop viewport
    Given a browser viewport of 1024 by 720 CSS pixels
    When the owner opens the Library
    Then the persistent desktop sidebar and catalog workspace are displayed
    And the page has no horizontal overflow

  Scenario: A narrow viewport receives an explicit desktop requirement
    Given a browser viewport narrower than 1024 CSS pixels
    When the owner opens Hardware
    Then a desktop-required notice replaces the application workspace
    And no mobile navigation is rendered

  Scenario: The owner finds a project from incomplete memory
    Given projects contain indexed names, descriptions, topics, source titles, URLs, collections, and notes
    When the owner searches a partial term and filters by language and channel
    Then matching projects are relevance-ranked
    And the query and filters appear in the URL
    And switching between card and list view preserves the result set

  Scenario: The owner traces a project to its exact source
    Given one project was seen in two videos
    When the owner opens its Sightings section
    Then both sightings are displayed independently
    And each includes the channel, video, timestamp, complete raw block, and original URL
    And each can open YouTube at its exact timestamp

  Scenario Outline: The owner selects an explicit color preference
    Given the saved theme preference is system
    When the owner selects <preference>
    Then the saved theme preference is <preference>
    And the effective theme is <effective>
    And the pre-hydration theme matches the hydrated theme

    Examples:
      | preference | effective |
      | light      | light     |
      | dark       | dark      |

  Scenario: System theme follows the operating system
    Given the saved theme preference is system
    And the operating system theme is light
    When the operating system theme changes to dark
    Then the effective theme changes to dark without changing the saved preference
    And the theme remains system after an application restart

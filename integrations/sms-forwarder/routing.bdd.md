# SIM routing and independent delivery

Scenario: CMCC retains the personal destination
Given routing is enabled with distinct verified CMCC and AIR MOBILE subscription IDs
When a new CMCC inbox row is captured
Then only the configured direct WeChat delivery is committed with the capture cursor

Scenario: AIR MOBILE fans out atomically
Given routing is enabled
When a new AIR MOBILE inbox row is captured
Then one WeChat group delivery and one Slack delivery are committed in the same transaction as the cursor
And rollback or duplicate capture never leaves partial fanout

Scenario: An unknown subscription fails closed
Given an inbox record has a missing, negative, or unconfigured subscription ID
When capture runs
Then its content is retained as blocked work and no network send occurs

Scenario: Upgrade preserves legacy work
Given a v1 or v2 database with pending or uncertain legacy sends
When upgraded to v3
Then the cursor, content, request identities and outcomes are preserved
And those sends remain on the existing single-destination configuration

Scenario: Destination outcomes are independent across restart
Given an AIR MOBILE message has succeeded on WeChat
When Slack fails or the process stops during its request
Then WeChat is not repeated and Slack remains unknown for manual reconciliation

Scenario: Slack response handling
Given the unknown state is committed before invoking the webhook
When Slack responds with HTTP 200 and body ok
Then only that Slack delivery is removed
When Slack responds with 429
Then the delivery is retryable after a durable channel-wide Retry-After cooldown
When the response is missing, malformed, 408 or 5xx
Then it remains unknown and is not automatically retried

Scenario: Destination configuration is protected
Given retained routed deliveries exist
When the user tries to change subscription mapping, group, webhook or credentials
Then configuration changes are rejected

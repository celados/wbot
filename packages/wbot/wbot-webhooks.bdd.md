# Webhook CLI

Scenario: Manage endpoint-level webhooks on /platform/v2
Given a Tenant API Key and a signing secret in an environment variable
When the caller runs webhooks.create, list, get, update, retry or delete
Then the CLI sends one authenticated request to the matching `/platform/v2/webhooks*` endpoint
And create reads the secret from WBOT_WEBHOOK_SIGNING_SECRET or signingSecretEnv
And update rotates the secret only when rotateSecret is true or signingSecretEnv is specified
And successful stdout is JSON without the signing secret
And no webhook management tool is added to the read-only MCP interface

Scenario: Reject invalid local inputs
Given a missing or malformed secret, invalid HTTPS URL, empty conversationIds array, or empty update
When creating or updating a webhook endpoint
Then the CLI fails without sending a Platform request
And the secret is absent from stdout and stderr

Scenario: Validate successful responses
Given a successful response with valid known fields and extra additive fields
When the client validates it
Then known webhook fields are returned and unknown fields are ignored (including any echoed signingSecret)
But malformed known fields produce a sanitized Platform Contract Error

Scenario: Authenticate v2 notification bytes
Given a fresh timestamp and signature over the exact raw body of a v2 `conversation.updated` payload
When the receiver verifies the notification
Then it accepts the supported v2 event with non-empty deduplicated reasons and a matching event header
And rejects v1 payloads, empty/unknown/duplicate reasons, tampering, stale signatures, wrong keys and header mismatches

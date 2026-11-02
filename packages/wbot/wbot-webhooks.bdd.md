# Webhook CLI

Scenario: Manage one incoming-message subscription
Given a Tenant API Key and a signing secret in an environment variable
When the caller runs webhooks.configure, list, retry or remove
Then the CLI sends one authenticated request to the matching Platform endpoint
And configure reads the secret from WBOT_WEBHOOK_SIGNING_SECRET or signingSecretEnv
And successful stdout is JSON without the signing secret
And no webhook management tool is added to the read-only MCP interface

Scenario: Reject invalid local inputs
Given a missing or malformed secret, invalid HTTPS URL, or missing conversation ID
When configuring a webhook
Then the CLI fails without sending a Platform request
And the secret is absent from stdout and stderr

Scenario: Validate successful responses
Given a successful response with valid known fields and extra additive fields
When the client validates it
Then known webhook fields are returned and unknown fields are ignored
But malformed known fields produce a sanitized Platform Contract Error

Scenario: Authenticate notification bytes
Given a fresh timestamp and signature over the exact raw body
When the receiver verifies the notification
Then it accepts the supported event with a matching event header
And rejects tampering, stale signatures, wrong keys and malformed events

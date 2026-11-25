# API Configuration Reference

<!-- Generated from apps/api/src/config.ts. Run pnpm -C apps/api references:write; do not edit. -->

[Configuration policy](../../architecture/configuration.md) · [API runtime](../../../apps/api/README.md)

No values are eligible for client exposure. `ORION_ENV` is always required. The three token settings are configured together. API modules that require the database or bearer authentication stay unmounted until those settings exist, and production startup fails instead.

| Environment variable | Type | Required | Default | Visibility | Classification | Secret | Purpose |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ORION_ENV` | development \| test \| production | yes | — | server | INTERNAL | no | Runtime environment. |
| `ORION_RELEASE_ID` | artifact identifier, 1..128 ASCII letters/digits/._- | no | `local` | server | INTERNAL | no | Actual artifact revision for correlated logs and traces; local for unversioned development. |
| `ORION_API_HOST` | nonempty string | no | `127.0.0.1` | server | INTERNAL | no | Listen address; loopback by default. |
| `ORION_API_PORT` | integer 0..65535 | no | `3000` | server | INTERNAL | no | Listen port; zero selects an ephemeral port. |
| `ORION_LOG_LEVEL` | Pino level | no | `info` | server | INTERNAL | no | Structured log threshold. |
| `ORION_SHUTDOWN_TIMEOUT_MS` | integer 100..30000 | no | `5000` | server | INTERNAL | no | Total graceful shutdown deadline. |
| `ORION_OTLP_ENDPOINT` | http(s) URL | no | — | server | INTERNAL | no | Optional OTLP HTTP collector base URL. |
| `ORION_TRACE_SAMPLE_RATIO` | number 0..1 | no | `1` | server | INTERNAL | no | Trace sampling probability. |
| `ORION_DATABASE_URL` | PostgreSQL URL | no | — | server | RESTRICTED | yes | Runtime PostgreSQL credential; enables the database for modules that require it and adds it to readiness. |
| `ORION_TOKEN_ISSUER` | issuer URL | no | — | server | INTERNAL | no | Expected access-token issuer; configure with audience and JWKS URL to enable bearer authentication. |
| `ORION_TOKEN_AUDIENCE` | nonempty string | no | — | server | INTERNAL | no | Expected API access-token audience. |
| `ORION_TOKEN_JWKS_URL` | http(s) URL | no | — | server | INTERNAL | no | Trusted issuer public-key endpoint. |
| `WHATSAPP_APP_SECRET` | secret string | no | — | server | RESTRICTED | yes | Meta app secret used to verify incoming webhook signatures. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | secret string | no | — | server | RESTRICTED | yes | Application-generated secret used to verify the Meta callback. |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta asset identifier | no | — | server | INTERNAL | no | Meta business phone number ID accepted by the webhook. |
| `WHATSAPP_ACCESS_TOKEN` | secret string | no | — | server | RESTRICTED | yes | Meta system user token that enables WhatsApp outbound dispatch. |
| `WHATSAPP_GRAPH_API_VERSION` | Graph API version | no | `v27.0` | server | INTERNAL | no | Graph API version used by WhatsApp outbound dispatch. |
| `WHATSAPP_CLOSURE_TEMPLATE_NAME` | approved Meta utility template name | no | — | server | INTERNAL | no | Approved pt_BR utility template for closure notices outside the customer service window. |
| `GLPI_API_URL` | HTTPS URL | no | — | server | INTERNAL | no | Base URL of the GLPI REST v1 API, including its API path. |
| `GLPI_APP_TOKEN` | secret string | no | — | server | RESTRICTED | yes | Application token for the configured GLPI API client. |
| `GLPI_USER_TOKEN` | secret string | no | — | server | RESTRICTED | yes | User token for the scoped GLPI service account. |
| `IDENTITY_CODE_SECRET` | secret string | no | — | server | RESTRICTED | yes | 32-byte hex key for verification code and mailbox digests. |
| `IDENTITY_ALLOWED_EMAIL_DOMAINS` | comma-separated domain names | no | — | server | INTERNAL | no | Exact corporate email domains eligible for employee verification. |
| `IDENTITY_SMTP_HOST` | SMTP hostname | no | — | server | INTERNAL | no | SMTP submission server used for employee verification email. |
| `IDENTITY_SMTP_PORT` | integer 1..65535 | no | `587` | server | INTERNAL | no | SMTP submission port. Port 465 uses implicit TLS. Other ports require STARTTLS. |
| `IDENTITY_SMTP_USER` | nonempty string | no | — | server | RESTRICTED | yes | SMTP service credential username for employee verification mail. |
| `IDENTITY_SMTP_PASSWORD` | secret string | no | — | server | RESTRICTED | yes | SMTP service credential password for employee verification mail. |
| `IDENTITY_SMTP_FROM` | email address | no | — | server | INTERNAL | no | Authorized From mailbox for employee verification email. |
| `WHATSAPP_SUPPORT_CONTACT` | email address or HTTPS URL | no | — | server | INTERNAL | no | IT contact shown by the WhatsApp menu. Enables guided conversations with configured integrations. |

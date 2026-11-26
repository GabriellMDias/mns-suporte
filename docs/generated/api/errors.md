# API Error Registry

<!-- Generated from apps/api/src/errors.ts and composed module errors. Run pnpm -C apps/api references:write; do not edit. -->

[Error contract](../../api/error-contract.md) · [API runtime](../../../apps/api/README.md)

| Code | HTTP status | Category | Retryable | Public message |
| --- | --- | --- | --- | --- |
| `AUTHENTICATION_REQUIRED` | 401 | authentication | no | Authentication is required. |
| `VALIDATION_FAILED` | 400 | validation | no | The request is invalid. |
| `RESOURCE_NOT_FOUND` | 404 | not_found | no | The resource was not found. |
| `RATE_LIMITED` | 429 | rate_limit | yes | Too many requests. Try again later. |
| `INTERNAL_ERROR` | 500 | internal | no | An unexpected error occurred. |
| `SERVICE_UNAVAILABLE` | 503 | availability | yes | The service is unavailable. |
| `WHATSAPP_WEBHOOK_UNVERIFIED` | 403 | authentication | no | The webhook request could not be verified. |
| `WHATSAPP_WEBHOOK_TOO_LARGE` | 413 | validation | no | The webhook payload is too large. |
| `WHATSAPP_WEBHOOK_UNSUPPORTED_MEDIA_TYPE` | 415 | validation | no | The webhook must use JSON. |
| `WHATSAPP_IDENTITY_ADMIN_FORBIDDEN` | 403 | authorization | no | You do not have permission to manage WhatsApp identity links. |

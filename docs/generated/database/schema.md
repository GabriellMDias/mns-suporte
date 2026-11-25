# Database Reference

<!-- Generated from migrated PostgreSQL and apps/api/prisma/metadata. Do not edit. -->

[Schema documentation policy](../../database/schema-documentation.md) · [Database principles](../../database/principles.md)

## whatsapp_inbound_messages

Durable intake of supported and authenticated Meta messages for the configured business number.

Owner: WhatsApp webhook. Classification: RESTRICTED.

Lifecycle: Created before acknowledging the webhook. Redelivery preserves the original row. Processing and retention are release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `message_id` | `text` | no | — | RESTRICTED | Opaque Meta message identifier used to deduplicate redelivery. | — | — |
| `business_phone_id` | `text` | no | — | INTERNAL | Meta asset identifier of the business number that received the event. | — | — |
| `sender_business_id` | `text` | yes | — | RESTRICTED | Meta sender identifier scoped to the business portfolio. | Meta supplied only the sender phone number. | — |
| `sender_phone` | `text` | yes | — | RESTRICTED | Sender number supplied by Meta to support directory linking and routing. | Meta supplied a business-scoped sender identifier without a phone number. | — |
| `occurred_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Timestamp reported by Meta as the message time. | — | UTC instant |
| `received_at` | `timestamp(3) with time zone` | no | `CURRENT_TIMESTAMP` | INTERNAL | Database timestamp of the first accepted delivery. | — | UTC instant |
| `content` | `jsonb` | no | — | RESTRICTED | Normalized text, action identifier or media reference consumed by the conversation flow. | — | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_inbound_messages_pkey` | `PRIMARY KEY (message_id)` | Keeps one accepted event per Meta message ID across retries and concurrent delivery. |
| `whatsapp_inbound_messages_sender_required` | `CHECK (((sender_business_id IS NOT NULL) OR (sender_phone IS NOT NULL)))` | Requires at least one sender identifier so a message can be associated with a conversation. |

## whatsapp_outbound_messages

Durable intent and dispatch evidence for one free-form WhatsApp reply.

Owner: WhatsApp dispatch. Classification: RESTRICTED.

Lifecycle: Enqueued before dispatch. Retried only after an explicit provider throttle rejection and while the service window remains open. An unresolved attempt enters UNCERTAIN for reconciliation. Automated retention is release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | no | — | INTERNAL | Caller-assigned immutable UUID for one reply intent and the opaque identifier echoed by Meta on delivery callbacks. | — | — |
| `business_phone_id` | `text` | no | — | INTERNAL | Meta business phone number ID that owns and sends the reply. | — | — |
| `payload` | `jsonb` | no | — | RESTRICTED | Immutable destination and validated text or interactive reply content. | — | — |
| `state` | `"WhatsAppOutboundState"` | no | `'PENDING'::"WhatsAppOutboundState"` | INTERNAL | Current queue, provider acceptance or delivery evidence state. | — | — |
| `expires_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Last allowed dispatch deadline from the current inbound customer service window. | — | UTC instant |
| `available_at` | `timestamp(3) with time zone` | no | `CURRENT_TIMESTAMP` | INTERNAL | Earliest eligible time for the next dispatch attempt. | — | UTC instant |
| `attempt_started_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Most recent claim time used to detect an abandoned dispatch. | The queue has not claimed this reply. | UTC instant |
| `attempts` | `integer` | no | `0` | INTERNAL | Number of claims recorded before making a provider request. | — | claims |
| `provider_message_id` | `text` | yes | — | RESTRICTED | Meta message identifier returned on acceptance or on a correlated delivery callback. | Provider acceptance or delivery has not supplied an identifier. | — |
| `provider_error_code` | `integer` | yes | — | INTERNAL | Integer Graph error code from an explicit rejection or delivery failure. | The current evidence has no provider error code. | — |
| `delivery_status_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Provider timestamp of the accepted delivery status update. | No delivery callback has advanced this reply. | UTC instant |
| `created_at` | `timestamp(3) with time zone` | no | `CURRENT_TIMESTAMP` | INTERNAL | Database timestamp when the reply intent was first enqueued. | — | UTC instant |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_outbound_messages_attempts_nonnegative` | `CHECK ((attempts >= 0))` | Rejects invalid negative dispatch attempt counts. |
| `whatsapp_outbound_messages_pkey` | `PRIMARY KEY (id)` | Prevents another reply intent with the same durable identifier. |
| `whatsapp_outbound_messages_dispatch_idx` | `CREATE INDEX whatsapp_outbound_messages_dispatch_idx ON public.whatsapp_outbound_messages USING btree (business_phone_id, state, available_at)` | Supports finding due messages for a configured sender and tracking current states. |
| `whatsapp_outbound_messages_provider_key` | `CREATE UNIQUE INDEX whatsapp_outbound_messages_provider_key ON public.whatsapp_outbound_messages USING btree (business_phone_id, provider_message_id)` | Correlates delivery by provider message ID within one business phone number and prevents conflicting associations. |

## Database enums

| Enum | Values | Meaning |
| --- | --- | --- |
| `WhatsAppOutboundState` | PENDING, SENDING, ACCEPTED, SENT, DELIVERED, READ, FAILED, UNCERTAIN, EXPIRED | Tracks work from pending and claimed through acceptance, delivery, read, known failure, uncertainty, or service-window expiry. |

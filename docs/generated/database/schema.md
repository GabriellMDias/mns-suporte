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

# Database Reference

<!-- Generated from migrated PostgreSQL and apps/api/prisma/metadata. Do not edit. -->

[Schema documentation policy](../../database/schema-documentation.md) · [Database principles](../../database/principles.md)

## whatsapp_closure_preferences

Most recent explicit closure notice consent per WhatsApp sender scope and verified GLPI requester.

Owner: WhatsApp closure notifications. Classification: RESTRICTED.

Lifecycle: An employee opts in or withdraws through WhatsApp. Withdrawal clears the delivery address. Re-enabling issues a new grant that cannot revive jobs under the previous grant.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scope_key` | `text` | no | — | RESTRICTED | Stable hash binding the Meta business number and the sender scope. | — | — |
| `glpi_user_id` | `bigint` | no | — | RESTRICTED | Verified GLPI requester who opted in. | — | — |
| `grant_id` | `uuid` | no | — | INTERNAL | Unique consent epoch bound to eligible ticket watches and queued closure replies. | — | — |
| `recipient` | `jsonb` | yes | — | RESTRICTED | Validated WhatsApp address for opted-in closure delivery. | The employee withdrew the grant and the address was cleared. | — |
| `granted_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Time at which WhatsApp recorded the active or most recently withdrawn grant. | — | UTC instant |
| `revoked_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Time at which the employee withdrew the grant. | The grant remains active. | UTC instant |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_closure_preferences_active_recipient` | `CHECK (((glpi_user_id > 0) AND ((revoked_at IS NULL) = (recipient IS NOT NULL))))` | Requires a verified positive GLPI ID and limits stored recipients to active grants. |
| `whatsapp_closure_preferences_pkey` | `PRIMARY KEY (scope_key)` | Keeps a single latest grant per sender scope. |

## whatsapp_conversations

Latest guided intake state and a resumable or confirmed draft for an authenticated WhatsApp sender scope.

Owner: WhatsApp guided conversations. Classification: RESTRICTED.

Lifecycle: Created on first actionable inbound message and updated as the conversation advances. An unconfirmed draft can be cancelled. Drafts are disclosed only to the currently verified GLPI owner. Retention is release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scope_key` | `text` | no | — | RESTRICTED | Stable hash of the business phone ID and preferred sender identity. | — | — |
| `state` | `jsonb` | no | — | RESTRICTED | Current stage, owning GLPI user, intake fields, attachment references and confirmation state where present. | — | — |
| `updated_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Clock instant of the last applied conversation move. | — | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_conversations_pkey` | `PRIMARY KEY (scope_key)` | Keeps one current conversation and draft per WhatsApp sender scope. |

## whatsapp_identity_events

Durable inbound identity receipts and short-lived challenge reservations scoped to a WhatsApp sender.

Owner: WhatsApp employee verification. Classification: RESTRICTED.

Lifecycle: A reserved challenge stays active until it is replaced, consumed, expires or exhausts its attempts. Code digests are removed when the challenge is deactivated. Historical records support deduplication and hourly limits. Retention is release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `event_key` | `text` | no | — | RESTRICTED | Hash of the business-scoped sender and provider message ID, used to recognize replay. | — | — |
| `scope_key` | `text` | no | — | RESTRICTED | Stable hash of the business phone ID and preferred sender identity. | — | — |
| `mailbox_key` | `text` | yes | — | RESTRICTED | Keyed digest of the normalized corporate address for cross-sender limits. | The receipt carries no eligible mailbox. | — |
| `created_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Clock instant when the event receipt was recorded. | — | — |
| `expires_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Deadline for redemption of the reserved challenge. | The receipt did not reserve a challenge. | — |
| `active` | `boolean` | no | `false` | INTERNAL | Whether the reservation is the most recent active challenge for this sender. | — | — |
| `attempts_left` | `integer` | no | `0` | INTERNAL | Remaining comparisons allowed for this challenge. | — | — |
| `glpi_user_id` | `bigint` | yes | — | RESTRICTED | GLPI user identified by a unique active directory match. | The challenge has no verified directory candidate or has been deactivated. | — |
| `code_digest` | `text` | yes | — | RESTRICTED | Keyed digest of the short-lived verification code and sender scope. | The event has no prepared code or its challenge was cleared. | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_identity_events_active` | `CHECK (((NOT active) OR ((expires_at IS NOT NULL) AND (attempts_left > 0))))` | Requires an expiration and an available attempt for an active challenge. |
| `whatsapp_identity_events_attempts` | `CHECK (((attempts_left >= 0) AND (attempts_left <= 5)))` | Bounds challenge comparisons to the configured maximum of five. |
| `whatsapp_identity_events_code` | `CHECK (((code_digest IS NULL) OR (active AND (glpi_user_id IS NOT NULL) AND (glpi_user_id > 0) AND (code_digest ~ '^[a-f0-9]{64}$'::text))))` | Requires a canonical digest and a valid directory candidate for a prepared active challenge. |
| `whatsapp_identity_events_pkey` | `PRIMARY KEY (event_key)` | Prevents one signed inbound message from starting or confirming verification twice for a sender. |
| `whatsapp_identity_events_mailbox_idx` | `CREATE INDEX whatsapp_identity_events_mailbox_idx ON public.whatsapp_identity_events USING btree (mailbox_key, created_at)` | Supports the rolling hourly quota shared by all senders targeting a mailbox. |
| `whatsapp_identity_events_scope_idx` | `CREATE INDEX whatsapp_identity_events_scope_idx ON public.whatsapp_identity_events USING btree (scope_key, created_at)` | Supports sender-scoped quotas and challenge selection. |

## whatsapp_verified_identities

Current proof of corporate mailbox control for a WhatsApp sender and its GLPI identity.

Owner: WhatsApp employee verification. Classification: RESTRICTED.

Lifecycle: Created or replaced only as a challenge is consumed. Proof expires after thirty days and requires a new challenge. Retention is release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scope_key` | `text` | no | — | RESTRICTED | Stable hash of the business phone ID and preferred sender identity. | — | — |
| `glpi_user_id` | `bigint` | no | — | RESTRICTED | GLPI directory identity established by mailbox verification. | — | — |
| `verified_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Time the matching challenge was consumed. | — | — |
| `expires_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Time after which the link cannot authorize work. | — | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_verified_identities_expiration` | `CHECK ((expires_at > verified_at))` | Requires verification to precede expiration. |
| `whatsapp_verified_identities_pkey` | `PRIMARY KEY (scope_key)` | Maintains one current verified GLPI identity for a WhatsApp sender scope. |
| `whatsapp_verified_identities_user` | `CHECK ((glpi_user_id > 0))` | Requires a positive GLPI directory identity. |

## whatsapp_ticket_submissions

Durable work and outcome for one verified, confirmed WhatsApp draft submitted to GLPI.

Owner: WhatsApp ticket submission. Classification: RESTRICTED.

Lifecycle: Starts when an employee confirms a draft. Confirmed ticket creation clears the work summary. Terminal results clear the active reply address and media references. Retain durable outcomes for reconciliation and deduplication under the project retention policy.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `draft_id` | `uuid` | no | — | INTERNAL | Unique opaque identifier of the confirmed draft and GLPI reconciliation reference. | — | — |
| `business_phone_id` | `text` | no | — | INTERNAL | Meta business phone number ID owning the submission job. | — | — |
| `scope_key` | `text` | no | — | RESTRICTED | Verified sender scope used to update the correct conversation. | — | — |
| `requester_id` | `bigint` | no | — | RESTRICTED | Verified GLPI requester chosen at confirmation. | — | — |
| `recipient` | `jsonb` | yes | — | RESTRICTED | WhatsApp address for the eventual response. Cleared at the terminal outcome. | The submission no longer needs its reply address. | — |
| `reply_expires_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Deadline of the customer service window associated with confirmation. | — | — |
| `title` | `text` | yes | — | RESTRICTED | Ticket title derived from the confirmed category. Cleared after creation or terminal failure. | The title is no longer needed for creation. | — |
| `description` | `text` | yes | — | RESTRICTED | Confirmed ticket summary with its opaque reconciliation reference. Cleared after creation or terminal failure. | The summary is no longer needed for creation. | — |
| `media_ids` | `jsonb` | no | — | RESTRICTED | Ordered Meta media identifiers to resolve at delivery time. Cleared when processing ends. | — | — |
| `attachment_count` | `integer` | no | — | INTERNAL | Number of media references in the confirmed draft. | — | — |
| `next_attachment` | `integer` | no | `0` | INTERNAL | Zero-based position of the next media reference to process. | — | — |
| `attached_count` | `integer` | no | `0` | INTERNAL | Number of documents whose association to the ticket was confirmed. | — | — |
| `uncertain_attachments` | `integer` | no | `0` | INTERNAL | Number of document writes whose association or outcome could not be confirmed. | — | — |
| `ticket_id` | `bigint` | yes | — | RESTRICTED | Authoritative GLPI ticket ID returned by successful creation. | GLPI has not confirmed a ticket for the draft. | — |
| `state` | `"WhatsAppTicketSubmissionState"` | no | `'PENDING'::"WhatsAppTicketSubmissionState"` | INTERNAL | Current dispatch or terminal state for the confirmed draft. | — | — |
| `attempts` | `integer` | no | `0` | INTERNAL | Number of worker claims for the current ticket or attachment step. | — | — |
| `available_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Earliest retry instant or deadline of the active worker claim. | — | — |
| `claim_id` | `uuid` | yes | — | INTERNAL | Temporary worker ownership token that fences stale writes. | No worker holds a claim for the current step. | — |
| `mutating` | `boolean` | no | `false` | INTERNAL | Durable evidence that a non-idempotent GLPI mutation may have been started. | — | — |
| `updated_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Instant of the latest claim or durable progress transition. | — | — |
| `closure_consent_id` | `uuid` | yes | — | INTERNAL | Active notice grant recorded when the employee confirmed the draft. | There was no eligible notice grant when this submission was queued. | — |
| `closure_check_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Time of the next GLPI closure check or the deadline of its active claim. | The watch is unscheduled, retired or has created a closure reply. | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_ticket_submissions_closure_watch` | `CHECK (((closure_check_at IS NULL) OR ((closure_consent_id IS NOT NULL) AND (ticket_id IS NOT NULL))))` | Requires a confirmed GLPI ticket and an explicit consent grant for any scheduled check. |
| `whatsapp_ticket_submissions_pkey` | `PRIMARY KEY (draft_id)` | Prevents two jobs for the same verified draft. |
| `whatsapp_ticket_submissions_progress_check` | `CHECK ((((attachment_count >= 0) AND (attachment_count <= 5)) AND ((next_attachment >= 0) AND (next_attachment <= attachment_count)) AND (attached_count >= 0) AND (uncertain_attachments >= 0) AND ((attached_count + uncertain_attachments) <= next_attachment) AND (attempts >= 0) AND ((state <> 'COMPLETED'::"WhatsAppTicketSubmissionState") OR ((ticket_id IS NOT NULL) AND (next_attachment = attachment_count))) AND ((state <> ALL (ARRAY['FAILED'::"WhatsAppTicketSubmissionState", 'UNCERTAIN'::"WhatsAppTicketSubmissionState"])) OR (ticket_id IS NULL)) AND ((NOT mutating) OR (claim_id IS NOT NULL))))` | Enforces consistent progress, result and claim counts. |
| `whatsapp_ticket_submissions_closure_idx` | `CREATE INDEX whatsapp_ticket_submissions_closure_idx ON public.whatsapp_ticket_submissions USING btree (business_phone_id, closure_check_at, draft_id) WHERE (closure_check_at IS NOT NULL)` | Finds due ticket closure checks within one business number. |
| `whatsapp_ticket_submissions_dispatch_idx` | `CREATE INDEX whatsapp_ticket_submissions_dispatch_idx ON public.whatsapp_ticket_submissions USING btree (business_phone_id, state, available_at, draft_id)` | Finds eligible jobs for one Meta business phone number. |

## whatsapp_troubleshooting_feedback

A single employee response to a versioned static troubleshooting guide offered during ticket intake.

Owner: WhatsApp guided conversations. Classification: INTERNAL.

Lifecycle: Recorded once as the conversation leaves the guidance step. The result survives dismissal of the draft and carries no contact, description or attachment fields.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `draft_id` | `uuid` | no | — | INTERNAL | Opaque identifier of the draft whose guidance was rated or skipped. | — | — |
| `guidance_id` | `text` | no | — | INTERNAL | Stable, versioned identifier of the instructions shown. | — | — |
| `outcome` | `"WhatsAppTroubleshootingOutcome"` | no | — | INTERNAL | Employee choice to report resolution, ask for more help or skip the suggestion. | — | — |
| `recorded_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Instant at which the conversation accepted the response. | — | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_troubleshooting_feedback_pkey` | `PRIMARY KEY (draft_id)` | Keeps one guidance outcome per draft across retries. |
| `whatsapp_troubleshooting_feedback_outcome_idx` | `CREATE INDEX whatsapp_troubleshooting_feedback_outcome_idx ON public.whatsapp_troubleshooting_feedback USING btree (guidance_id, outcome)` | Supports aggregate reporting by guide and outcome. |

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
| `content` | `jsonb` | no | — | RESTRICTED | Normalized text, action identifier, media reference or protected verification-code digest consumed by the conversation flow. | — | — |
| `conversation_processed_at` | `timestamp(3) with time zone` | yes | — | INTERNAL | Time the guided worker completed processing this input and committed its effects. | The guided worker has not completed this message. | — |
| `conversation_action` | `"WhatsAppConversationAction"` | yes | — | INTERNAL | Durable identity or ticket lookup operation owned by this inbound event. | There is no outstanding deferred conversation operation. | — |
| `conversation_claim_id` | `uuid` | yes | — | INTERNAL | Unique fence for the worker currently allowed to finalize the conversation operation. | The event has no deferred work claim. | — |
| `conversation_claim_until` | `timestamp(3) with time zone` | yes | — | INTERNAL | Time after which another conversation worker may reclaim an unfinished operation. | The event has no active work claim. | — |
| `conversation_requester_id` | `bigint` | yes | — | RESTRICTED | Verified GLPI requester bound to a claimed ticket consultation. Cleared when the event completes. | The event has no pending ticket consultation. | — |

### Constraints and indexes

| Object | Physical definition | Purpose |
| --- | --- | --- |
| `whatsapp_inbound_messages_conversation_claim` | `CHECK ((((conversation_claim_id IS NULL) AND (conversation_claim_until IS NULL)) OR ((conversation_claim_id IS NOT NULL) AND (conversation_claim_until IS NOT NULL) AND (conversation_action IS NOT NULL) AND (conversation_processed_at IS NULL))))` | Requires a complete claim only on an outstanding operation and keeps completed events unlocked. |
| `whatsapp_inbound_messages_pkey` | `PRIMARY KEY (message_id)` | Keeps one accepted event per Meta message ID across retries and concurrent delivery. |
| `whatsapp_inbound_messages_requester_claim` | `CHECK (((conversation_requester_id IS NULL) OR ((conversation_requester_id > 0) AND (conversation_claim_id IS NOT NULL))))` | Restricts a stored GLPI requester to a positive ID on a claimed event. |
| `whatsapp_inbound_messages_sender_required` | `CHECK (((sender_business_id IS NOT NULL) OR (sender_phone IS NOT NULL)))` | Requires at least one sender identifier so a message can be associated with a conversation. |
| `whatsapp_inbound_messages_conversation_idx` | `CREATE INDEX whatsapp_inbound_messages_conversation_idx ON public.whatsapp_inbound_messages USING btree (business_phone_id, conversation_processed_at, received_at, occurred_at, message_id)` | Supports finding the earliest unprocessed message for one business number. |

## whatsapp_outbound_messages

Durable intent and dispatch evidence for one WhatsApp reply or closure notice.

Owner: WhatsApp dispatch. Classification: RESTRICTED.

Lifecycle: Enqueued before dispatch. Retried only after an explicit provider throttle rejection and while the service window remains open. An unresolved attempt enters UNCERTAIN for reconciliation. Automated retention is release-plan work.

| Column | PostgreSQL type | Nullable | Default | Classification | Meaning | Null meaning | Unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | no | — | INTERNAL | Caller-assigned immutable UUID for one reply intent and the opaque identifier echoed by Meta on delivery callbacks. | — | — |
| `business_phone_id` | `text` | no | — | INTERNAL | Meta business phone number ID that owns and sends the reply. | — | — |
| `payload` | `jsonb` | no | — | RESTRICTED | Immutable destination, validated text or interactive content and optional verified identity and notice consent requirements. | — | — |
| `state` | `"WhatsAppOutboundState"` | no | `'PENDING'::"WhatsAppOutboundState"` | INTERNAL | Current queue, provider acceptance or delivery evidence state. | — | — |
| `expires_at` | `timestamp(3) with time zone` | no | — | INTERNAL | Last allowed dispatch deadline under the reply's service window or utility notice lifetime. | — | UTC instant |
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
| `WhatsAppConversationAction` | REQUEST_CODE, CONFIRM_CODE, QUERY_TICKETS | Deferred operation to request or confirm an email code or consult GLPI tickets after committing the preceding conversation move. |
| `WhatsAppOutboundState` | PENDING, SENDING, ACCEPTED, SENT, DELIVERED, READ, FAILED, UNCERTAIN, EXPIRED | Tracks work from pending and claimed through acceptance, delivery, read, known failure, uncertainty, or service-window expiry. |
| `WhatsAppTicketSubmissionState` | PENDING, COMPLETED, FAILED, UNCERTAIN | PENDING covers dispatch and bounded retries. COMPLETED confirms a ticket and records attachment outcomes. FAILED confirms no ticket was created. UNCERTAIN requires checking GLPI before a repeat. |
| `WhatsAppTroubleshootingOutcome` | RESOLVED, NOT_RESOLVED, SKIPPED | Employee response to optional guidance. RESOLVED closes the draft. NOT_RESOLVED and SKIPPED keep the draft for review. |

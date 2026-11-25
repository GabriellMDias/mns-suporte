# API Runtime

[Setup](../../docs/setup.md) · [API principles](../../docs/api/principles.md) · [OpenAPI](../../docs/generated/api/openapi.json) · [Validation](../../docs/validation.md)

The Fastify API runtime provides configuration, structured logging and tracing, health/lifecycle behavior, the public error envelope, optional PostgreSQL access through Prisma, and optional bearer access-token verification. Product capabilities are [modules](#modules) composed in [`src/modules.ts`](src/modules.ts). The [web application](../web/README.md) consumes the generated API contract through the workspace SDK package (`packages/sdk`). The API verifies access tokens; it does not implement login, passwords, refresh tokens, or provider-specific sessions.

## Find the owning implementation

| Concern                                           | Source                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and process composition             | [`src/config.ts`](src/config.ts), [`src/main.ts`](src/main.ts)                                                                                           |
| HTTP boundary, lifecycle, and failures            | [`src/app.ts`](src/app.ts), [`src/lifecycle.ts`](src/lifecycle.ts), [`src/errors.ts`](src/errors.ts)                                                     |
| Module contract and composition                   | [`src/module.ts`](src/module.ts), [`src/modules.ts`](src/modules.ts), [`src/error-registry.ts`](src/error-registry.ts)                                   |
| Database client and token verification            | [`src/database.ts`](src/database.ts), [`src/authentication.ts`](src/authentication.ts)                                                                   |
| Prisma schema, schema meaning, and runtime grants | [`prisma/schema/`](prisma/schema/schema.prisma), `prisma/metadata/`, `prisma/runtime-grants/`, reviewed `prisma/migrations/`                             |
| Generated references                              | [`generate-references.ts`](scripts/generate-references.ts), [`openapi.ts`](scripts/openapi.ts), [`database-reference.ts`](scripts/database-reference.ts) |
| Process smokes                                    | [`scripts/smoke.mjs`](scripts/smoke.mjs) and module smokes in `scripts/smoke/`                                                                           |

## Modules

A module is one cohesive API capability. It implements the `ApiModule` contract in [`src/module.ts`](src/module.ts): a name, an OpenAPI tag, its requirements (`database`, `authentication`), its executable operations, its public error codes, and an `activate` function that mounts routes once its requirements are configured. Shared runtime files never import a module; [`src/modules.ts`](src/modules.ts) is the only composition point, and dependency rules enforce that boundary.

Keep a module's files together under its name: `src/features/<module>/` for domain, application, persistence, contracts, routes, and errors; `prisma/schema/<module>.prisma` for its models; `prisma/metadata/<module>.json` for table meaning; `prisma/runtime-grants/<module>.sql` for least-privilege runtime access; a reviewed migration; tests under `test/<module>/`; and an optional emitted-process smoke at `scripts/smoke/<module>.ts`. Follow [application boundaries](../../docs/architecture/application-boundaries.md), [dependency rules](../../docs/architecture/dependency-rules.md), and the [database policies](../../docs/database/principles.md). [Orion's reference implementation](../../docs/project-derivation.md#orions-reference-implementation) is a complete example.

Outside production, a module whose requirements are not configured stays unmounted. In production, startup fails instead, so a composed capability cannot silently disappear. Generated OpenAPI and the public error registry always include every composed module, whether or not it is configured locally.

## WhatsApp webhook

The WhatsApp module receives Meta callbacks at `/webhooks/whatsapp`. Development and test can run health-only with this module unconfigured. To mount it, configure restricted PostgreSQL through `ORION_DATABASE_URL` and provide the three WhatsApp settings from the [configuration reference](../../docs/generated/configuration/api.md). Generate the callback verification token locally with a cryptographically secure random generator. The app secret and phone number ID come from the Meta dashboard. Keep secrets in ignored environment files or the deployment secret store.

The subscription GET returns the original challenge as plain text after verifying the token. The POST computes HMAC-SHA256 over the exact request bytes before parsing JSON. Supported messages and matching outbound delivery updates for the configured number commit together before acknowledgement. Incoming message IDs deduplicate redelivery. Other numbers and unsupported events are ignored. Enable HTTPS at ingress and omit query strings from ingress logs because Meta sends the verification token in the subscription query.

The inbox accepts text, interactive or template button replies, images, audio and documents. It stores normalized content and media references. The runtime role can read and append inbound events, and update only the guided worker metadata. Automated retention is tracked in the [V1 plan](../../docs/project/implementation-plan.md#v1-work).

[Meta webhook protocol](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) · [Module source](src/features/whatsapp/module.ts) · [Database schema](prisma/schema/whatsapp.prisma)

### Reply dispatch

`WHATSAPP_ACCESS_TOKEN` enables the outbox worker when the webhook and PostgreSQL are configured. It uses the pinned Graph API version from `WHATSAPP_GRAPH_API_VERSION`. The credential belongs in the deployment secret store with permission to send from the configured business number. Tests supply synthetic credentials and mock the Meta transport.

The conversation flow can enqueue a text or up-to-three-button reply with a stable intent UUID and its service-window deadline. The enqueue operation accepts the current database transaction so the conversation step and reply intent can commit together. It rejects an attempt to reuse the same ID for different content. Claiming a row is conditional and happens before calling Meta. The dispatch limits an attempt to four seconds and honors throttling backoff, including a longer provider retry delay. It retries only an explicit Meta throttle rejection, at most four attempts and within the reply deadline.

A timeout, disconnected response, malformed success, provider server error or abandoned claim can leave an unknown result. The row becomes `UNCERTAIN` and stays out of dispatch until reconciled by delivery evidence. The signed delivery callback identifies the local intent through the opaque ID or the known Meta message ID. Events can arrive before the send response. Later or repeated weaker events leave confirmed delivery or read status intact. The runtime can update dispatch evidence, and the stored intent stays immutable.

The internal queue entry point is [outbox.ts](src/features/whatsapp/outbox.ts). The [guided conversation](#guided-whatsapp-conversation) and [closure watcher](#whatsapp-closure-notices) create delivery intents. Use test traffic until the operational controls in the [V1 plan](../../docs/project/implementation-plan.md#v1-work) are in place.

[Meta Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) · [Reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) · [Business-scoped recipients](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)

## GLPI integration

The server-side [GLPI client](src/integrations/glpi/client.ts) targets the REST v1 API used by the legacy support channel. Configure the base API URL, the GLPI API-client token and the scoped service-account user token together in the server environment. The [configuration reference](../../docs/generated/configuration/api.md) lists the keys. Use HTTPS for any real instance. HTTP is permitted on loopback in development and test. The transport rejects redirects.

The user token is sent only to `initSession`. Requests with an established session use the application token and session token. Concurrent calls share session initialization. A directory read refreshes and retries once after GLPI explicitly rejects an expired session. The runtime and reverse proxy should exclude query strings, request bodies and authentication headers from logs because directory queries carry corporate email addresses.

Directory lookup pages through `search/User`, verifies the entire normalized email against returned addresses, and checks the active flag. It accepts exactly one active GLPI user ID. Multiple matching users, incomplete or inconsistent pagination, and provider errors return distinct internal outcomes. The employee identity workflow will use neutral replies and verify mailbox ownership before linking an account.

Ticket creation uses the verified GLPI requester ID and escapes the plain-text description for GLPI's HTML field. A confirmed creation includes the positive ticket ID from GLPI. The GLPI adapter uploads documents via multipart form data, then reads the ticket to confirm that it contains the returned document ID. An explicit denial is distinguishable from a timeout, lost response or malformed success after dispatch. Each adapter call sends at most one write.

The adapter is covered by [synthetic contract and transport tests](test/glpi/client.test.ts). The employee verification and ticket workflows are tracked in the [V1 plan](../../docs/project/implementation-plan.md#v1-work). Live testing requires the scoped service account in [PH-08](../../docs/project/human-actions.md#ph-08).

[GLPI REST v1 reference](https://github.com/glpi-project/glpi/blob/10.0/bugfixes/apirest.md) · [GLPI User search fields](https://github.com/glpi-project/glpi/blob/10.0/bugfixes/src/User.php)

## Employee email verification

The [identity service](src/features/whatsapp/identity-service.ts) establishes mailbox control for a WhatsApp sender and one GLPI user. It queries the directory only for configured corporate domains and issues a code only after a unique active match. The sender scope includes the WhatsApp business phone ID and prefers the Meta business-scoped sender ID. Phone-only senders use their phone identifier. A changed sender scope requires verification.

One reservation permits one SMTP submission. A code has the prefix `MNS-` and expires after ten minutes. Each challenge permits five attempts. The sender and mailbox each allow three reservations in a rolling hour. Repeated inbound message IDs cannot consume another attempt or trigger another email. Reserving a new challenge supersedes the previous one. Consuming a code and creating the verified link commit together. The link expires after thirty days.

The webhook stores a keyed digest for a standalone verification code and removes complete code mentions from other message text. Challenges and mailbox quotas also use keyed digests. Rotating the key invalidates pending codes and starts new mailbox quota counters. Issuing the code and querying GLPI happen outside database locks. The conversation flow must durably enqueue the same neutral acknowledgement before doing any directory or mail work. That rule keeps mailbox eligibility and SMTP outcomes out of the response. A failed or unconfirmed relay response does not cause an automatic resend. The employee can make a new request within the quota.

Configure the seven `IDENTITY_*` settings as a group with [GLPI](#glpi-integration). Generate the 32-byte secret with a cryptographically secure random generator and place it with the relay credentials in the server secret store. The [SMTP adapter](src/integrations/mail/verification.ts) uses implicit TLS on port 465 and requires STARTTLS on other ports, with normal certificate verification. Keep the identity service internal. The [guided conversation](#guided-whatsapp-conversation) processes signed verification events.

[Identity integration tests](test/whatsapp/identity.test.ts) · [SMTP transport test](test/whatsapp/verification-mail.test.ts) · [Nodemailer SMTP](https://nodemailer.com/smtp)

## Guided WhatsApp conversation

Set `WHATSAPP_SUPPORT_CONTACT` to the approved IT mailbox or HTTPS support page to enable guided processing. It requires the [WhatsApp outbound](#reply-dispatch), [GLPI](#glpi-integration), [employee verification](#employee-email-verification), and PostgreSQL settings. With the contact unset, the API can still receive signed events for integration testing. The configured contact is available to an employee before verification and during intake.

The conversation offers ticket intake, ticket consultation, and the IT contact. Intake collects category, unit or department, description, impact, and up to five media references. An employee can review and edit fields, cancel an unconfirmed draft, or return to it via the menu after a restart. Review buttons carry the current draft revision. The stored draft belongs to its verified GLPI user, and a different verified user on the same sender scope does not inherit it.

Confirmation enqueues [ticket submission](#glpi-ticket-submission). Verified employees can [consult their tickets](#glpi-ticket-consultation) and opt in to [closure notices](#whatsapp-closure-notices).

Inbound events and replies use PostgreSQL. A short transaction serializes the next inbox event for one business number and commits the conversation move and its outbound reply together. Email requests commit the neutral reply before querying GLPI or submitting mail. Deferred identity and consultation operations can be reclaimed after a 45-second lease. An old claim cannot finalize a newer one. The employee's verified link recovers a successful confirmation when a worker was interrupted after consuming the code. Inbound events outside the customer service window are completed without applying a move or sending a reply.

[Conversation state and prompts](src/features/whatsapp/conversation.ts) · [Processing and recovery](src/features/whatsapp/conversation-processor.ts) · [Restart and transport tests](test/whatsapp/conversation.test.ts) · [Meta customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)

### Static troubleshooting

Before review, a single clear symptom match can show a short instruction for an unavailable printer or a connectivity problem. The employee can report that it worked, continue to the ticket, or skip the suggestion. Unmatched and ambiguous reports go straight to review. Confirmed drafts and field edits do not repeat the advice.

The conversation commits at most one feedback record per draft together with the selected transition. A resolved report closes the draft. The other choices preserve all entered fields and media references for ticket review. The feedback table stores the opaque draft ID, versioned guide ID, choice and timestamp. Keep earlier guide versions readable when changing the catalogue, because in-progress conversations can still reference them.

[Guide catalogue](src/features/whatsapp/troubleshooting.ts) · [Feedback schema](prisma/schema/whatsapp-troubleshooting.prisma)

### GLPI ticket submission

The conversation transaction saves the confirmed fields, draft and queue entry together. The draft UUID identifies one submission and appears in the GLPI description as the MNS reference. Drafts confirmed before submission was available return to review for a fresh confirmation. The worker creates the ticket before downloading any attachments.

The media reader requests Meta metadata scoped to the configured phone number and accepts only the HTTPS WhatsApp attachment path on Meta's download host. It rejects redirects and enforces type, length and the supplied checksum. The worker sends up to five JPEG, PNG, OGG, MP3, AAC, MP4 audio, AMR or PDF documents, up to 10 MB each. Media bytes stay in memory and are sent to the configured GLPI endpoint. The final reply gives the confirmed ticket number and distinguishes verified, failed and unconfirmed attachments.

Each stage has a 45-second lease. Transient download failures, a GLPI failure before sending the write, and explicit session expiry may retry up to a total of three attempts with delays of two and eight seconds. After a definite creation failure, the employee can reopen the saved draft and confirm again. A lost response or expired claim for a possibly sent write is recorded as uncertain. The worker does not replay that write. It continues remaining attachments for an already confirmed ticket.

For an uncertain creation, IT can search the GLPI description for the exact MNS reference from the conversation and confirm whether the ticket exists before recreating it manually. For an uncertain document, inspect the known ticket's documents for the filename beginning with `mns-<draft ID>-<attachment number>`. The employee can use the ticket number to send missing files to IT. The queue stores outcome and counts. It releases the copied description after creation and clears the reply address and media references at termination. The reply uses the confirmation's service window and requires the requester to still own the verified sender link at completion.

[Submission worker](src/features/whatsapp/ticket-submission-worker.ts) · [Recovery tests](test/whatsapp/ticket-submission.test.ts) · [Meta media retrieval](https://www.postman.com/meta/whatsapp-business-platform/request/ptjyi84/retrieve-media-url) · [GLPI upload contract](https://github.com/glpi-project/glpi/blob/10.0/bugfixes/apirest.md#upload-a-document-file)

### GLPI ticket consultation

Choose **Meus chamados** for up to five active tickets per page, ordered by GLPI ticket number, or send **Chamado 123** to view a specific ticket. The detail shows its title, status and latest update when GLPI provides one. This also covers existing GLPI tickets created through other channels and allows lookup of closed tickets by number. The open list includes new, assigned, planned and pending tickets.

The adapter scopes each search to the verified GLPI user and confirms the corresponding requester relation in `Ticket_User` before rendering a result. Ticket numbers from text and pagination buttons are search inputs. Requester authorization comes from GLPI. Missing tickets and denied details produce the same response. The reply projects the ticket number, title, status and update date.

Consultation runs outside the database transaction. A deferred request retains its original GLPI requester across a restart. The worker checks the verified sender binding at the start and again before committing a reply. Protected replies expire after one minute or at the end of the service window, whichever comes first. Dispatch checks the verified binding before each attempt.

[Lookup adapter](src/integrations/glpi/ticket-lookup.ts) · [Signed conversation tests](test/whatsapp/conversation.test.ts) · [GLPI Ticket requester relation](https://github.com/glpi-project/glpi/blob/10.0/bugfixes/src/Ticket_User.php)

### WhatsApp closure notices

Verified employees can send **Avisos** and choose **Ativar avisos** for tickets they confirm after opting in. **Parar avisos** withdraws the grant for that WhatsApp sender, including when email verification has expired. Enabling again issues a new grant for subsequent tickets. Existing tickets first opened through the legacy system are covered by the cutover reconciliation in PJ-18.

After GLPI confirms ticket creation, the worker checks the ticket and its requester every five minutes. GLPI status `6` triggers one notice per submitted draft. GLPI outages and expired identity bindings defer checks for fifteen minutes. The worker retires watches when the grant or ownership disappears. It commits the closure intent and retires the watch in one transaction. Dispatch checks the opt-in and verified binding again on each attempt, reuses the outbound throttle rules and tracks Meta delivery evidence.

The notice uses text during the 24-hour window determined from signed incoming messages. For delivery outside that window, set `WHATSAPP_CLOSURE_TEMPLATE_NAME` after Meta approves the matching utility template. Without a configured template, the watcher defers a closed ticket until an eligible window or template is available. A notice queued with a template has a 48-hour dispatch lifetime. A text-only notice queued without one expires with its service window.

Use the utility template `mns_chamado_encerrado_v1`, language `pt_BR`, a single positional body parameter with example `123`, and the following body.

```text
O chamado nº {{1}} foi encerrado pela equipe de TI. Digite Chamado seguido do número para consultar ou Parar avisos para cancelar os avisos.
```

[Worker lifecycle test](test/whatsapp/closure.test.ts) · [Meta template payload](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text) · [Meta customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows)

## Local commands

Use [setup](../../docs/setup.md) for the frozen install, generated Prisma client, environment loading, containers, and startup order. `pnpm -C apps/api dev` loads the ignored root `.env.local` when present; `start` runs emitted code and expects its process environment without loading that file.

From the repository root:

| Purpose                                                                      | Command                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| Generate ignored Prisma client                                               | `pnpm -C apps/api db:generate`                           |
| Apply committed migrations to the configured database                        | `pnpm -C apps/api db:migrate:deploy`                     |
| Check API behavior/types                                                     | `pnpm -C apps/api test` and `pnpm -C apps/api typecheck` |
| Emit/start API                                                               | `pnpm -C apps/api build`, then `pnpm -C apps/api start`  |
| Intentionally regenerate tracked API/database/configuration/error references | `pnpm -C apps/api references:write`                      |
| Check current API/database/SDK references without editing them               | `pnpm references:check`                                  |

Tests and reference generation use fresh migrated Testcontainers PostgreSQL, so a compatible container runtime must be reachable. Follow the [artifact workflow](../../docs/architecture/backend-execution-and-generated-artifacts.md) for downstream SDK/portal generation after source changes. The root `pnpm validate` also checks emitted builds, real-process recovery, and browser behavior; a focused package check alone does not replace it.

## Configuration and database access

[`config.ts`](src/config.ts) is the sole runtime environment parser; the [generated configuration reference](../../docs/generated/configuration/api.md) owns the setting catalog. `ORION_ENV` is always required. `ORION_DATABASE_URL` enables the database for modules that require it and adds a bounded database check to readiness. `ORION_TOKEN_ISSUER`, `ORION_TOKEN_AUDIENCE`, and `ORION_TOKEN_JWKS_URL` enable bearer authentication and must be configured together.

`ORION_DATABASE_URL` is the restricted runtime credential. Only the Prisma CLI reads `ORION_MIGRATION_DATABASE_URL`, supplied separately for migration commands; the CLI does not automatically load the API's root `.env.local`. Keep both out of tracked files and do not leave the migration credential in the runtime environment.

The runtime role needs `USAGE` on the application schema plus only the table and column privileges that each module declares in `prisma/runtime-grants/`. It needs no DDL grant. The [database fixture](scripts/migrated-database.ts) provisions separate migration/runtime roles and applies those grants, so integration tests run with the same least-privilege runtime role.

The [release workflow](../../docs/database/release-evolution.md) owns durable migration recording. An empty registry is not permission to rewrite unverified history.

## Identity and contract

The shared [token verifier](src/authentication.ts) accepts verified `at+jwt` tokens signed with RS256 or ES256 by the configured issuer for the configured audience. It validates expiration and requires nonempty `sub`, valid issuance/expiry timing, a stable `orion_principal_id` UUID, `orion_actor_type=human`, and a string `scope`. It yields the principal ID and the issuer-granted scopes; each module maps scopes to its own capabilities. Stored ownership must survive provider changes; request bodies cannot grant identity or capability. The [authentication policy](../../docs/security/authentication.md) and [ADR-0012](../../docs/adr/0012-verify-jwt-access-tokens-at-the-first-api-boundary.md) govern this boundary; no concrete provider is selected or provisioned.

Executable module contracts own operations, stable operation IDs, typed inputs/outputs, and expected failures. The [OpenAPI reference](../../docs/generated/api/openapi.json) includes health and every composed module's operations; the [error reference](../../docs/generated/api/errors.md) derives from the shared and module registries.

## Request protection

A module that exposes authenticated routes should apply request limiting before token verification and database access, as the reference module does with a process-local source-IP limit; health probes stay outside it. Exhaustion returns `429 RATE_LIMITED` in the public envelope with a bounded `Retry-After`. This is resource protection, not a product quota.

Process-local limiting uses the direct peer address; trusted proxies are not configured. A multi-replica or reverse-proxy deployment must define shared/edge limiting and trusted client-IP handling before promising fleet-wide or per-user limits.

## Lifecycle and diagnostics

`main.ts` validates configuration, initializes Pino/OpenTelemetry, then dynamically imports Fastify, Prisma, and composed modules before listening. Preserve that order for instrumented infrastructure. Incoming W3C trace context propagates; each request receives a fresh server-generated `x-request-id`. Errors follow the [public envelope](../../docs/api/error-contract.md). Logs and traces identify the service by the API package name.

Startup reports initialization, liveness reports process-local health, and readiness becomes unavailable while draining or when a configured database is unavailable. A configured database is probed before readiness and through a bounded readiness check. SIGINT/SIGTERM trigger bounded HTTP, database, and telemetry shutdown.

Logs and exported spans/metric dimensions use allowlisted operational fields. The runtime does not log payloads, raw URLs, headers, configuration objects, or arbitrary exception messages. Unexpected failures produce one sanitized diagnostic occurrence. A readiness failure or a lost response cannot prove that a prior write failed; see [delivery and side effects](../../docs/architecture/delivery-and-side-effects.md).

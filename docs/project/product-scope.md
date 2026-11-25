# MNS Suporte Product Scope

[Implementation plan](implementation-plan.md) · [Project README](../../README.md)

MNS Suporte is an internal IT support channel for MNS employees. Employees use WhatsApp to open and consult GLPI tickets or find the IT contact. The IT team receives and resolves the tickets in GLPI. The V1 menu and employee-facing prompts use Brazilian Portuguese.

## V1 workflow

1. Verify the employee with a short-lived code delivered to their corporate mailbox after an exact, unique lookup in the corporate directory exposed by GLPI. Bind the verified GLPI identity to the WhatsApp account. Limit challenges and attempts, and use neutral replies during lookup.
2. Offer to open a ticket, list the employee's open tickets, or direct them to IT. The human contact is an explicit menu option and remains available during intake.
3. Collect category, unit or department, description, impact, and optional photos, audio or documents. Keep a resumable draft. Offer a relevant static instruction when one exists. The employee can mark it helpful, request more support, or skip to ticket creation.
4. Present a draft summary for review. On confirmation, create the ticket and attach media in GLPI. Confirm creation only after obtaining the GLPI ticket ID. Surface attachment failures independently from ticket creation.
5. Check ownership in GLPI before displaying ticket details. Record permission for outbound updates, check for closure and send a notification. Use the approved Meta utility template outside the customer service window.

Email password reset was retired from the product scope. The verification code proves access to the mailbox for onboarding.

## Delivery and data boundaries

- Meta Cloud API carries conversations. Use a TLS webhook, verify its requests, scope incoming events to the configured business number, and persist supported inbound messages before acknowledging them. Use the business-scoped sender identifier when available and retain a supplied phone number only where needed for identity continuity and routing.
- GLPI remains authoritative for employee directory records, ticket ownership, tickets, attachments and ticket status. Its service account receives scoped permissions.
- PostgreSQL owns verified links, in-progress conversations, integration delivery state and job deduplication. Treat identifiers, user-provided support content and attachments as restricted. Exclude them from routine logs, keep media references only while needed for delivery to GLPI, and establish automated retention before real traffic.
- Record ambiguous provider outcomes for reconciliation. A missing response after ticket submission may hide a successful creation. Replays or restarts must preserve the original intent and must not create a second ticket.
- Existing GLPI tickets remain in GLPI. Reverify legacy identity links. Reconcile pending legacy notifications with the live GLPI status and the employee's verified identity before sending from the new service.

## AI extension

The conversation service owns its state and the complete guided flow. An optional assistant may return candidate field values, approved knowledge article references and a draft summary. Application rules validate those outputs and require employee review before ticket creation. On timeout, unavailability or lack of relevant guidance, continue from the saved step with the guided prompts. Limit context to approved content and the minimum necessary support data. Treat user messages and retrieved articles as untrusted input. AI receives no write capability in GLPI.

## Release acceptance

- An employee can verify ownership of their corporate mailbox, resume a draft after restart, open a ticket with an attachment, consult their own tickets and receive a closure notice in the test environment.
- Direct access to IT and every core flow work with the guided messages alone.
- Replayed or concurrent inbound deliveries do not duplicate tickets. A GLPI outage preserves the draft and permits safe recovery.
- Another employee cannot view ticket details or trigger actions with a stale or unverified messenger identity.
- Release evidence includes local validation, a pilot on real service boundaries, backup and restore checks, and a supervised cutover rehearsal.

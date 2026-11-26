# V1 Deployment and Recovery

The operator authorized for the MNS Suporte Compose project owns these procedures. They apply to the packaged API, migration job, PostgreSQL, maintenance worker and encrypted backup job. A company deployment requires company ingress, log routing and secret-store access. Follow the [production access policy](../security/production-access.md) and [incident response policy](../security/incident-response.md).

## Disposable rehearsal

Run `pnpm ops:rehearse` from the repository root with Docker Compose and `tar` available. The command builds the current images and the preceding Git revision as an API image. Use `MNS_REHEARSAL_PREVIOUS` to select a tested compatible revision when the immediate parent is unsuitable. CI uses its comparison base.

The rehearsal uses two generated project names, isolated database volumes, temporary synthetic credentials and ephemeral loopback ports. It checks API readiness, production startup with missing settings, database grants, retention, sanitized alerts, encrypted backup integrity, a restore into a fresh volume and a rollback to the previous image with the original volume intact. It removes only its generated projects and temporary artifacts.

## Local webhook pilot

Use this procedure for the authorized Meta test number. The local receiver starts against the dedicated `mns_suporte` PostgreSQL on `127.0.0.1:55432`. It uses the webhook signing secret and verification token from the ignored `.env.local`. The receiver has no outbound WhatsApp, GLPI, or SMTP credentials, so it can acknowledge signed callbacks without dispatching replies or creating tickets. The full conversation pilot requires separately authorized test data and delivery.

1. Confirm the local PostgreSQL container is healthy, `.env.local` selects its restricted runtime role, and Meta identifies the configured phone number and app as the intended pilot assets. Confirm the app's existing callback and fields before requesting a change. A callback configured on the app applies to its subscribed accounts. Keep established integrations on their authorized endpoints.
2. From the repository root, generate and build the API, then start the pilot with the approved Phone Number ID. Run this in the foreground for a manual session.

   ```powershell
   pnpm db:generate
   pnpm -C apps/api build
   $pilotPhoneId = Read-Host 'Authorized Meta pilot Phone Number ID'
   node infra/pilot-webhook.mjs $pilotPhoneId
   ```

   Cloudflared must be available on `PATH`. The script prints `local_api_ready` after checking the API's loopback health and `pilot_callback` when the temporary HTTPS URL is allocated. Share only the callback URL. The loopback proxy admits `GET` and `POST` on the exact `/webhooks/whatsapp` path.

3. Check that the public `/health/ready` returns 404, an invalid challenge token and an unsigned POST return 403, and the actual verification token echoes the challenge. A signed empty envelope should return `EVENT_RECEIVED`. Construct those requests from the ignored file in memory and record only the statuses.
4. Configure the exact HTTPS callback and existing verification token in the authorized Meta app once its confirmation gate is satisfied. Confirm that `messages` is listed and that the app is subscribed to the pilot phone's WhatsApp Business Account. Record the verified callback response separately from a delivered WhatsApp message. For a test sent to an approved recipient, confirm delivery from the associated local outbox record after a signed Meta status callback.
5. Before closing an active pilot, remove the temporary callback in the Meta app or restore its authorized prior callback. End the foreground session with Ctrl+C. For a background session with a recorded PID on Windows, stop the verified launcher and its children from the repository root.

   ```powershell
   $pilotProcessId = [int](Get-Content -Raw -LiteralPath '.env.local.d/pilot.pid')
   $pilotProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$pilotProcessId"
   if ($pilotProcess.Name -eq 'node.exe' -and $pilotProcess.CommandLine -match 'infra[/\\]pilot-webhook\.mjs\s') {
     taskkill.exe /PID $pilotProcessId /T /F
   }
   ```

   Verify the public URL is unavailable after stopping.

### Resume after a restart

If the launcher is gone after a workstation restart, confirm the same dedicated PostgreSQL is healthy and start the receiver again using steps 1–3. Reuse the existing database so verified identities, consent and delivery history survive. Each Quick Tunnel launch allocates a new URL. In the authorized Meta app, replace the previous pilot callback with the newly printed `pilot_callback`. In the dashboard, open **Configure Webhooks**, reenter `WHATSAPP_WEBHOOK_VERIFY_TOKEN` from `.env.local` in **Verify token**, then select **Verify and save**. Do not share the token or change the existing `messages` subscription to rotate the URL.

Confirm that the app shows the new URL, `messages` is still subscribed, and the intended WhatsApp Business Account still lists the app. Then use a Meta test event or a new message from the authorized participant to verify receipt through the new tunnel. A direct challenge against the URL checks reachability and token acceptance. Meta delivery also requires its saved callback and a signed POST.

For a manual inbound test, the approved participant replies `Oi` to the test message or sends it to the pilot number. Verify that the signed callback was acknowledged and the inbound count for the pilot number increased in the local database. The receiver only acknowledges webhooks. Guided replies and GLPI submission belong to the separately authorized full conversation pilot.

In the full conversation pilot, start onboarding with `Oi` and submit the corporate email from each WhatsApp account. Use one number listed uniquely on the corresponding active GLPI user and another number that is absent from the directory. Verify that the listed number receives the menu without email delivery and the unlisted number requires its own code. Inspect both links under the same GLPI user in MNS Suporte.

For the next live checks, use an approved corporate mailbox and verify receipt of its test code separately from SMTP authentication. Use the GLPI homologation environment, or obtain explicit authorization for the legacy environment and the synthetic record scope. Record the approved requester and unique draft reference before the first submission. Confirm the resulting ticket ID in GLPI. If the create outcome is ambiguous, search for that reference before considering another create request. Enable the closure template only after Meta reports approval for the pilot account.

## Deploy

1. Verify authorization, image references, backup destination, expected migration history and reverse-proxy access. Record the last known good API image and release ID. Build or pull the release images and preserve their digests. Use a distinct tag for each release.
2. Use the [Compose settings example](../../infra/compose.env.example) as the path and image contract. Project the following files into restricted host paths from the approved secret store. The directory must prevent other host users from traversing it. Give the explicitly mounted files read access to their container service users. Use independently generated passwords and keep the backup passphrase apart from archives and database credentials.

   | File                   | Purpose                                                                                          |
   | ---------------------- | ------------------------------------------------------------------------------------------------ |
   | `admin.password`       | PostgreSQL initialization and authorized database administration                                 |
   | `migration.password`   | Schema owner used by the migration and backup jobs                                               |
   | `runtime.password`     | Restricted API login with the schema's declared grants                                           |
   | `maintenance.password` | Login that executes the two restricted maintenance functions                                     |
   | `api.env`              | [API integration settings](../generated/configuration/api.md) for Meta, GLPI and corporate email |
   | `MNS_BACKUP_KEY_FILE`  | Separate secret-store file containing the GnuPG passphrase                                       |

   Set the backup directory owner to the configured backup container UID and GID. PostgreSQL passwords are read during initialization and by the role-specific services. A later password rotation needs an authorized PostgreSQL role change and a coordinated secret replacement.

3. Run the Compose commands from an approved checkout. Set `MNS_COMPOSE_ENV` to the path of the environment file for this deployment.

   ```sh
   mns() { docker compose -p mns-suporte -f infra/compose.yaml --env-file "$MNS_COMPOSE_ENV" "$@"; }
   mns config --quiet
   mns --profile tools build api migrate backup
   mns up -d --no-build --wait api maintenance
   mns ps -a
   ```

   Take a pre-change backup of any existing database before starting a new migration image. Compose waits for PostgreSQL and a successful migration and grants job. The API refuses production startup when WhatsApp dispatch, GLPI or email settings are incomplete. If startup fails, check the authorized settings and the migration job's exit status. Stop before repeating a migration whose result is unclear.

4. Verify `/health/ready` on the API loopback port and confirm the running image digest. The company reverse proxy must terminate TLS and forward the Meta callback path `/webhooks/whatsapp` while preserving its raw request body. Keep PostgreSQL and health diagnostics private. Check the callback challenge and a synthetic end-to-end conversation during the pilot.

## Back up

Run the backup job before migrations and via the approved host scheduler once daily after pilot setup. Use a new name for each archive. Collect failed job exits in the operational alert sink. Use the approved encrypted off-host storage with an initial archive expiry of 30 days. Confirm the restore time and capacity during the pilot.

```sh
mns run --rm --no-deps backup create "mns-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
```

The job streams a PostgreSQL custom-format dump into GnuPG AES-256 encryption. It publishes the encrypted file only after both commands succeed. A duplicate archive name fails. The published file resides in `MNS_BACKUP_DIR`. Check for a successful exit and a nonempty archive, then verify recovery with the restore procedure.

## Restore into a fresh database

1. Select an authorized backup, its matching GnuPG secret and an isolated Compose project. Set its own fresh database secret files, the backup path and `MNS_ENVIRONMENT=test` in a separate environment file. Use an empty `api.env` to keep Meta and GLPI workers disabled during recovery checks.
2. Start PostgreSQL alone and run the restore. The database must be freshly initialized and free of application schema. The job authenticates the encrypted dump before applying it in a single PostgreSQL transaction. GnuPG plaintext stays in the backup container's temporary memory filesystem. Size `MNS_RESTORE_TMPFS_BYTES` above the decrypted archive size and within the available recovery host memory. Its default is 512 MiB.

   ```sh
   mns_restore() { docker compose -p mns-suporte-restore -f infra/compose.yaml --env-file "$MNS_RESTORE_ENV" "$@"; }
   mns_restore up -d --no-build --wait db
   mns_restore run --rm --no-deps backup restore "$MNS_ARCHIVE"
   mns_restore up -d --no-build --wait api
   ```

3. Verify API readiness, the expected migration records, least-privilege role permissions and representative data in the recovered volume. A failed authentication or restore stops the procedure. Inspect the target before retrying.
4. Before switching real ingress or enabling delivery, reconcile outstanding ticket and message states against GLPI and Meta. An older snapshot can omit effects the providers already accepted. If the original database is available, preserve it until recovery is accepted.

## Inspect operations

Review the API and maintenance services with `mns ps -a` and `mns logs --since 15m api maintenance`. The maintenance process samples readiness and aggregate queue conditions once per minute. It emits `operational_alert` with a condition, firing or resolved state, environment and release. Route these events through the company log collector. A stopped maintenance process or absent logs require a host health check.

| Condition                                                                        | Diagnosis and response                                                                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_readiness`, `maintenance_database`                                          | Check container status, the migration job, PostgreSQL readiness and projected secrets. Confirm the API responds and maintenance resumes.                                          |
| `conversation_backlog`, `ticket_submission_backlog`, `whatsapp_delivery_backlog` | Check worker warnings and provider availability. Verify a new synthetic input drains.                                                                                             |
| `ticket_submission_uncertain`                                                    | Locate the GLPI ticket using the exact MNS draft reference before any repeat. Follow the [ticket submission recovery procedure](../../apps/api/README.md#glpi-ticket-submission). |
| `whatsapp_delivery_uncertain`                                                    | Check signed Meta delivery evidence. A lost acknowledgement can hide an accepted message. Keep uncertain intents available for reconciliation.                                    |

## Retention

Production maintenance runs one pruning pass per hour, with up to 250 rows per category and one active pass per database. It skips rows locked by workers. Monitor the aggregate `retention_completed` event. Run an authorized extra bounded pass with `mns run --rm --no-deps maintenance node ops/maintenance.mjs --once` when a backlog persists.

| Data                                          | Action                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Received WhatsApp content                     | Redact processed bodies and media references after two days. Keep sender and event identifiers for service-window checks and redelivery deduplication for 30 days from receipt. |
| Identity challenges                           | Delete after two days from issuance.                                                                                                                                            |
| Identity links and closure preferences        | Keep expired links for 30 days after expiry. Purge withdrawn grants after 30 days and aged grants without a matching current or grace-period link.                              |
| Conversation drafts                           | Delete after 30 days of inactivity. An unfinished submission keeps its draft. An uncertain submission keeps its draft for its 180-day reconciliation period.                    |
| Outbound intents and troubleshooting feedback | Remove expired outbound records after 90 days from the dispatch deadline and troubleshooting feedback 90 days after recording.                                                  |
| Ticket submissions                            | Remove terminal records after 180 days when their closure watch has ended. Keep unfinished submissions and active watches. GLPI holds the authoritative support records.        |

Retention applies to the application PostgreSQL database. Provider records remain subject to their own lifecycle. Older backup copies follow the backup archive expiry.

## Roll back the API

Use the last verified image and matching release ID after checking that it can run against the currently migrated schema. Leave the database volume attached. Recreate only the API with the selected image and `mns up -d --no-build --no-deps --force-recreate --wait api`. Verify the actual running digest, readiness and a synthetic conversation. Reconcile any active work before accepting recovery.

For incompatible migrations, stop the rollout and choose a forward correction or restore into a separate volume. Escalate to the authorized MNS infrastructure or data owner if access, provider outcomes, or the database state cannot be verified.

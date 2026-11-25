CREATE SCHEMA IF NOT EXISTS mns_ops;
REVOKE ALL ON SCHEMA mns_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA mns_ops TO mns_maintenance;

CREATE OR REPLACE FUNCTION mns_ops.prune() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    report jsonb;
BEGIN
    IF NOT pg_try_advisory_xact_lock(1835955059, 1) THEN
        RETURN jsonb_build_object('busy', true);
    END IF;

    WITH
    scrubbed AS (
        UPDATE public.whatsapp_inbound_messages
        SET content = '{"type":"redacted"}'::jsonb
        WHERE message_id IN (
            SELECT message_id FROM public.whatsapp_inbound_messages
            WHERE conversation_processed_at < now() - interval '2 days'
              AND received_at >= now() - interval '30 days'
              AND content <> '{"type":"redacted"}'::jsonb
            ORDER BY conversation_processed_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    inbox AS (
        DELETE FROM public.whatsapp_inbound_messages
        WHERE message_id IN (
            SELECT message_id FROM public.whatsapp_inbound_messages
            WHERE received_at < now() - interval '30 days'
              AND (conversation_claim_until IS NULL OR conversation_claim_until < now())
            ORDER BY received_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    outbox AS (
        DELETE FROM public.whatsapp_outbound_messages
        WHERE id IN (
            SELECT id FROM public.whatsapp_outbound_messages
            WHERE expires_at < now() - interval '90 days'
              AND (attempt_started_at IS NULL OR attempt_started_at < now() - interval '1 minute')
            ORDER BY expires_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    challenges AS (
        DELETE FROM public.whatsapp_identity_events
        WHERE event_key IN (
            SELECT event_key FROM public.whatsapp_identity_events
            WHERE created_at < now() - interval '2 days'
            ORDER BY created_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    identities AS (
        DELETE FROM public.whatsapp_verified_identities
        WHERE scope_key IN (
            SELECT scope_key FROM public.whatsapp_verified_identities
            WHERE expires_at < now() - interval '30 days'
            ORDER BY expires_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    preferences AS (
        DELETE FROM public.whatsapp_closure_preferences
        WHERE scope_key IN (
            SELECT pref.scope_key FROM public.whatsapp_closure_preferences AS pref
            WHERE pref.revoked_at < now() - interval '30 days'
               OR (pref.granted_at < now() - interval '30 days' AND NOT EXISTS (
                    SELECT FROM public.whatsapp_verified_identities AS identity
                    WHERE identity.scope_key = pref.scope_key AND identity.glpi_user_id = pref.glpi_user_id
                      AND identity.expires_at >= now() - interval '30 days'
               ))
            ORDER BY pref.granted_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    conversations AS (
        DELETE FROM public.whatsapp_conversations
        WHERE scope_key IN (
            SELECT conversation.scope_key FROM public.whatsapp_conversations AS conversation
            WHERE updated_at < now() - interval '30 days' AND NOT EXISTS (
                SELECT FROM public.whatsapp_ticket_submissions AS submission
                WHERE submission.scope_key = conversation.scope_key
                  AND submission.draft_id::text = conversation.state #>> '{draft,id}'
                  AND (submission.state = 'PENDING' OR
                       (submission.state = 'UNCERTAIN' AND submission.updated_at >= now() - interval '180 days'))
            )
            ORDER BY updated_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    submissions AS (
        DELETE FROM public.whatsapp_ticket_submissions
        WHERE draft_id IN (
            SELECT draft_id FROM public.whatsapp_ticket_submissions
            WHERE state <> 'PENDING' AND closure_check_at IS NULL
              AND updated_at < now() - interval '180 days'
            ORDER BY updated_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    ),
    feedback AS (
        DELETE FROM public.whatsapp_troubleshooting_feedback
        WHERE draft_id IN (
            SELECT draft_id FROM public.whatsapp_troubleshooting_feedback
            WHERE recorded_at < now() - interval '90 days'
            ORDER BY recorded_at LIMIT 250 FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    )
    SELECT jsonb_build_object(
        'scrubbed', (SELECT count(*) FROM scrubbed), 'inbox', (SELECT count(*) FROM inbox),
        'outbox', (SELECT count(*) FROM outbox), 'challenges', (SELECT count(*) FROM challenges),
        'identities', (SELECT count(*) FROM identities), 'preferences', (SELECT count(*) FROM preferences),
        'conversations', (SELECT count(*) FROM conversations), 'submissions', (SELECT count(*) FROM submissions),
        'feedback', (SELECT count(*) FROM feedback)
    ) INTO report;
    RETURN report;
END;
$function$;

CREATE OR REPLACE FUNCTION mns_ops.signals() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT jsonb_build_object(
        'conversation_backlog', EXISTS (
            SELECT FROM public.whatsapp_inbound_messages
            WHERE conversation_processed_at IS NULL AND received_at < now() - interval '5 minutes'
        ),
        'ticket_submission_backlog', EXISTS (
            SELECT FROM public.whatsapp_ticket_submissions
            WHERE state = 'PENDING' AND available_at < now() - interval '5 minutes'
        ),
        'whatsapp_delivery_backlog', EXISTS (
            SELECT FROM public.whatsapp_outbound_messages
            WHERE (state = 'PENDING' AND expires_at > now() AND available_at < now() - interval '2 minutes')
               OR (state = 'SENDING' AND attempt_started_at < now() - interval '1 minute')
        ),
        'ticket_submission_uncertain', EXISTS (
            SELECT FROM public.whatsapp_ticket_submissions WHERE state = 'UNCERTAIN'
        ),
        'whatsapp_delivery_uncertain', EXISTS (
            SELECT FROM public.whatsapp_outbound_messages WHERE state = 'UNCERTAIN'
        )
    );
$function$;

REVOKE ALL ON FUNCTION mns_ops.prune(), mns_ops.signals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mns_ops.prune(), mns_ops.signals() TO mns_maintenance;

BEGIN;

ALTER TABLE "whatsapp_verified_identities"
    ADD COLUMN "link_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "phone_last_four" TEXT,
    ADD COLUMN "revoked_at" TIMESTAMPTZ(3),
    ADD COLUMN "revoked_by" UUID,
    ADD CONSTRAINT "whatsapp_verified_identities_phone_suffix" CHECK ("phone_last_four" ~ '^[0-9]{4}$'),
    ADD CONSTRAINT "whatsapp_verified_identities_revocation" CHECK (
        ("revoked_at" IS NULL AND "revoked_by" IS NULL)
        OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoked_at" >= "verified_at")
    );

-- Recover only a display suffix from signed messages still retained by the pilot.
WITH sender_scopes AS (
    SELECT encode(sha256(convert_to(
        '[' || to_json(business_phone_id)::text || ',[' ||
        CASE WHEN sender_business_id IS NULL THEN '"phone",' ELSE '"business",' END ||
        to_json(COALESCE(sender_business_id, sender_phone))::text || ']]',
        'UTF8'
    )), 'hex') AS scope_key, right(sender_phone, 4) AS phone_last_four, received_at, message_id
    FROM whatsapp_inbound_messages
    WHERE sender_phone ~ '^[1-9][0-9]{5,14}$'
), last_sender AS (
    SELECT DISTINCT ON (s.scope_key) s.scope_key, s.phone_last_four
    FROM sender_scopes s
    INNER JOIN whatsapp_verified_identities i USING (scope_key)
    ORDER BY s.scope_key, s.received_at DESC, s.message_id DESC
)
UPDATE whatsapp_verified_identities i
SET phone_last_four = s.phone_last_four
FROM last_sender s
WHERE i.scope_key = s.scope_key;

CREATE UNIQUE INDEX "whatsapp_verified_identities_link_id_key"
    ON "whatsapp_verified_identities" ("link_id");
CREATE INDEX "whatsapp_verified_identities_user_links_idx"
    ON "whatsapp_verified_identities" ("glpi_user_id", "link_id");

COMMIT;

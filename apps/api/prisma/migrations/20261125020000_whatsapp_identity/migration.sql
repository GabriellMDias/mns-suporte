CREATE TABLE "whatsapp_identity_events" (
    "event_key" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "mailbox_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT FALSE,
    "attempts_left" INTEGER NOT NULL DEFAULT 0,
    "glpi_user_id" BIGINT,
    "code_digest" TEXT,
    CONSTRAINT "whatsapp_identity_events_pkey" PRIMARY KEY ("event_key"),
    CONSTRAINT "whatsapp_identity_events_attempts" CHECK ("attempts_left" BETWEEN 0 AND 5),
    CONSTRAINT "whatsapp_identity_events_active" CHECK (NOT "active" OR ("expires_at" IS NOT NULL AND "attempts_left" > 0)),
    CONSTRAINT "whatsapp_identity_events_code" CHECK ("code_digest" IS NULL OR ("active" AND "glpi_user_id" IS NOT NULL AND "glpi_user_id" > 0 AND "code_digest" ~ '^[a-f0-9]{64}$'))
);

CREATE INDEX "whatsapp_identity_events_scope_idx" ON "whatsapp_identity_events"("scope_key", "created_at");
CREATE INDEX "whatsapp_identity_events_mailbox_idx" ON "whatsapp_identity_events"("mailbox_key", "created_at");

CREATE TABLE "whatsapp_verified_identities" (
    "scope_key" TEXT NOT NULL,
    "glpi_user_id" BIGINT NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "whatsapp_verified_identities_pkey" PRIMARY KEY ("scope_key"),
    CONSTRAINT "whatsapp_verified_identities_user" CHECK ("glpi_user_id" > 0),
    CONSTRAINT "whatsapp_verified_identities_expiration" CHECK ("expires_at" > "verified_at")
);

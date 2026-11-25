CREATE TABLE "whatsapp_closure_preferences" (
    "scope_key" TEXT NOT NULL,
    "glpi_user_id" BIGINT NOT NULL,
    "grant_id" UUID NOT NULL,
    "recipient" JSONB,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    CONSTRAINT "whatsapp_closure_preferences_pkey" PRIMARY KEY ("scope_key"),
    CONSTRAINT "whatsapp_closure_preferences_active_recipient" CHECK (
        "glpi_user_id" > 0 AND ("revoked_at" IS NULL) = ("recipient" IS NOT NULL)
    )
);

ALTER TABLE "whatsapp_ticket_submissions"
    ADD COLUMN "closure_consent_id" UUID,
    ADD COLUMN "closure_check_at" TIMESTAMPTZ(3),
    ADD CONSTRAINT "whatsapp_ticket_submissions_closure_watch" CHECK (
        "closure_check_at" IS NULL OR ("closure_consent_id" IS NOT NULL AND "ticket_id" IS NOT NULL)
    );

CREATE INDEX "whatsapp_ticket_submissions_closure_idx"
    ON "whatsapp_ticket_submissions" ("business_phone_id", "closure_check_at", "draft_id")
    WHERE "closure_check_at" IS NOT NULL;

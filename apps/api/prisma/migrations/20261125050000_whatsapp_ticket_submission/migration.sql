CREATE TYPE "WhatsAppTicketSubmissionState" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'UNCERTAIN');

CREATE TABLE "whatsapp_ticket_submissions" (
    "draft_id" UUID NOT NULL,
    "business_phone_id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "requester_id" BIGINT NOT NULL,
    "recipient" JSONB,
    "reply_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "media_ids" JSONB NOT NULL,
    "attachment_count" INTEGER NOT NULL,
    "next_attachment" INTEGER NOT NULL DEFAULT 0,
    "attached_count" INTEGER NOT NULL DEFAULT 0,
    "uncertain_attachments" INTEGER NOT NULL DEFAULT 0,
    "ticket_id" BIGINT,
    "state" "WhatsAppTicketSubmissionState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "claim_id" UUID,
    "mutating" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_ticket_submissions_pkey" PRIMARY KEY ("draft_id"),
    CONSTRAINT "whatsapp_ticket_submissions_progress_check" CHECK (
        "attachment_count" BETWEEN 0 AND 5 AND "next_attachment" BETWEEN 0 AND "attachment_count"
        AND "attached_count" >= 0 AND "uncertain_attachments" >= 0
        AND "attached_count" + "uncertain_attachments" <= "next_attachment"
        AND "attempts" >= 0
        AND ("state" <> 'COMPLETED' OR ("ticket_id" IS NOT NULL AND "next_attachment" = "attachment_count"))
        AND ("state" NOT IN ('FAILED', 'UNCERTAIN') OR "ticket_id" IS NULL)
        AND (NOT "mutating" OR "claim_id" IS NOT NULL)
    )
);

CREATE INDEX "whatsapp_ticket_submissions_dispatch_idx"
    ON "whatsapp_ticket_submissions" ("business_phone_id", "state", "available_at", "draft_id");

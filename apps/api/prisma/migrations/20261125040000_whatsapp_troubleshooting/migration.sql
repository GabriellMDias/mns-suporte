CREATE TYPE "WhatsAppTroubleshootingOutcome" AS ENUM ('RESOLVED', 'NOT_RESOLVED', 'SKIPPED');

CREATE TABLE "whatsapp_troubleshooting_feedback" (
    "draft_id" UUID NOT NULL,
    "guidance_id" TEXT NOT NULL,
    "outcome" "WhatsAppTroubleshootingOutcome" NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "whatsapp_troubleshooting_feedback_pkey" PRIMARY KEY ("draft_id")
);

CREATE INDEX "whatsapp_troubleshooting_feedback_outcome_idx"
    ON "whatsapp_troubleshooting_feedback"("guidance_id", "outcome");

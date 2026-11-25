CREATE TABLE "whatsapp_inbound_messages" (
    "message_id" TEXT NOT NULL,
    "business_phone_id" TEXT NOT NULL,
    "sender_business_id" TEXT,
    "sender_phone" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("message_id"),
    CONSTRAINT "whatsapp_inbound_messages_sender_required" CHECK (
        "sender_business_id" IS NOT NULL OR "sender_phone" IS NOT NULL
    )
);

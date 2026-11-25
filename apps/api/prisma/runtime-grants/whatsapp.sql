-- Webhook ingestion may append messages and keep the first accepted delivery.
GRANT INSERT ON whatsapp_inbound_messages TO orion_runtime;

-- Dispatch may claim and record message outcomes. The message intent is immutable.
GRANT SELECT, INSERT ON whatsapp_outbound_messages TO orion_runtime;
GRANT UPDATE (state, available_at, attempt_started_at, attempts, provider_message_id, provider_error_code, delivery_status_at) ON whatsapp_outbound_messages TO orion_runtime;

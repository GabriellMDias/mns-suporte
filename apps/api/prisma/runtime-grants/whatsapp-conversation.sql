GRANT SELECT ON whatsapp_inbound_messages TO orion_runtime;
GRANT UPDATE (conversation_processed_at, conversation_action, conversation_claim_id, conversation_claim_until, conversation_requester_id) ON whatsapp_inbound_messages TO orion_runtime;
GRANT SELECT, INSERT ON whatsapp_conversations TO orion_runtime;
GRANT UPDATE (state, updated_at) ON whatsapp_conversations TO orion_runtime;

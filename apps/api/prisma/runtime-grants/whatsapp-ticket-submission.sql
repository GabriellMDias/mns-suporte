GRANT SELECT, INSERT ON whatsapp_ticket_submissions TO orion_runtime;
GRANT UPDATE (recipient, reply_expires_at, title, description, media_ids, attachment_count, next_attachment, attached_count, uncertain_attachments, ticket_id, state, attempts, available_at, claim_id, mutating, updated_at) ON whatsapp_ticket_submissions TO orion_runtime;

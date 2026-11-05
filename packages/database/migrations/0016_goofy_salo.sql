ALTER TABLE `marketplace_entitlement` MODIFY COLUMN `expires_at` datetime(6);--> statement-breakpoint
ALTER TABLE `marketplace_entitlement` MODIFY COLUMN `model_call_limit` int unsigned;
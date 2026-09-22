-- Initial-release precondition: assistant and assistant_release must be empty. A populated
-- deployment requires an audited display-name, slug-digest, draft-revision, and active-release
-- mapping backfill before applying the NOT NULL columns and foreign keys below.
CREATE TABLE `assistant_active_release` (
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`release_id` binary(16) NOT NULL,
	`activated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_assistant_active_release` PRIMARY KEY(`merchant_id`,`assistant_id`),
	CONSTRAINT `uq_assistant_active_release_release` UNIQUE(`merchant_id`,`assistant_id`,`release_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `assistant` ADD `display_name` varchar(200) NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant` ADD `public_slug_digest` binary(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_release` ADD `draft_revision` int unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant` ADD CONSTRAINT `uq_assistant_public_slug_digest` UNIQUE(`public_slug_digest`);--> statement-breakpoint
ALTER TABLE `assistant_active_release` ADD CONSTRAINT `fk_assistant_active_release_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_active_release` ADD CONSTRAINT `fk_assistant_active_release_release` FOREIGN KEY (`merchant_id`,`assistant_id`,`release_id`) REFERENCES `assistant_release`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;

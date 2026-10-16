CREATE TABLE `assistant_evaluation_run` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`improvement_id` binary(16) NOT NULL,
	`task_version` int unsigned NOT NULL,
	`draft_revision` int unsigned NOT NULL,
	`facts_hash` binary(32) NOT NULL,
	`question` text NOT NULL,
	`expected_answer` text NOT NULL,
	`answer` mediumtext,
	`state` varchar(24) NOT NULL,
	`error_code` varchar(64),
	`verdict` varchar(16),
	`prompt_template_version` varchar(64) NOT NULL,
	`model_policy_version` varchar(64) NOT NULL,
	`created_by` binary(16) NOT NULL,
	`reviewed_by` binary(16),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`completed_at` datetime(6),
	`reviewed_at` datetime(6),
	CONSTRAINT `pk_assistant_evaluation_run` PRIMARY KEY(`id`),
	CONSTRAINT `uq_evaluation_scope` UNIQUE(`merchant_id`,`assistant_id`,`improvement_id`,`id`)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `assistant_improvement` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`source_session_id` binary(16),
	`source_message_id` binary(16),
	`source_release_id` binary(16),
	`reason` varchar(32) NOT NULL,
	`question` text NOT NULL,
	`expected_answer` text NOT NULL,
	`notes` text NOT NULL,
	`original_answer` mediumtext,
	`applied_block` text,
	`applied_draft_revision` int unsigned,
	`published_release_id` binary(16),
	`published_task_version` int unsigned,
	`created_by` binary(16) NOT NULL,
	`updated_by` binary(16) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_assistant_improvement` PRIMARY KEY(`id`),
	CONSTRAINT `uq_improvement_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`),
	CONSTRAINT `uq_improvement_source` UNIQUE(`merchant_id`,`assistant_id`,`source_message_id`)
) ENGINE=InnoDB;
--> statement-breakpoint
ALTER TABLE `assistant_evaluation_run` ADD CONSTRAINT `fk_evaluation_improvement` FOREIGN KEY (`merchant_id`,`assistant_id`,`improvement_id`) REFERENCES `assistant_improvement`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_improvement` ADD CONSTRAINT `fk_improvement_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_improvement` ADD CONSTRAINT `fk_improvement_session` FOREIGN KEY (`merchant_id`,`assistant_id`,`source_session_id`) REFERENCES `conversation_session`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_improvement` ADD CONSTRAINT `fk_improvement_message` FOREIGN KEY (`merchant_id`,`assistant_id`,`source_message_id`) REFERENCES `message`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_improvement` ADD CONSTRAINT `fk_improvement_source_release` FOREIGN KEY (`merchant_id`,`assistant_id`,`source_release_id`) REFERENCES `assistant_release`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_improvement` ADD CONSTRAINT `fk_improvement_published_release` FOREIGN KEY (`merchant_id`,`assistant_id`,`published_release_id`) REFERENCES `assistant_release`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_evaluation_latest` ON `assistant_evaluation_run` (`merchant_id`,`assistant_id`,`improvement_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_improvement_recent` ON `assistant_improvement` (`merchant_id`,`assistant_id`,`updated_at`,`id`);

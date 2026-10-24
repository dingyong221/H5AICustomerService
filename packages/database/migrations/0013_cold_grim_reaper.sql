CREATE TABLE `assistant_publication_governance` (
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`preview_id` binary(16),
	`preview_revision` int unsigned,
	`preview_facts_hash` binary(32),
	`preview_question` text,
	`preview_answer` text,
	`preview_verdict` varchar(16),
	`previewed_at` datetime(6),
	`judged_by` binary(16),
	`judged_at` datetime(6),
	`withdrawn_through_no` int unsigned NOT NULL DEFAULT 0,
	`withdrawal_reason` varchar(500),
	`withdrawn_by` binary(16),
	`withdrawn_at` datetime(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_assistant_publication_governance` PRIMARY KEY(`merchant_id`,`assistant_id`)
);
--> statement-breakpoint
ALTER TABLE `assistant_publication_governance` ADD CONSTRAINT `fk_publication_governance_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_publication_governance` ADD CONSTRAINT `fk_publication_governance_judge` FOREIGN KEY (`judged_by`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_publication_governance` ADD CONSTRAINT `fk_publication_governance_withdrawer` FOREIGN KEY (`withdrawn_by`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;
CREATE TABLE `assistant_draft` (
	`assistant_id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`revision` int unsigned NOT NULL,
	`config` json NOT NULL,
	`validation` json NOT NULL,
	`updated_by` binary(16),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_assistant_draft` PRIMARY KEY(`assistant_id`),
	CONSTRAINT `uq_assistant_draft_scope` UNIQUE(`merchant_id`,`assistant_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `assistant` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`public_slug` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'draft_only',
	`active_release_id` binary(16),
	`draft_revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_assistant` PRIMARY KEY(`id`),
	CONSTRAINT `uq_assistant_scope` UNIQUE(`merchant_id`,`id`),
	CONSTRAINT `uq_assistant_public_slug` UNIQUE(`public_slug`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16),
	`actor_type` varchar(32) NOT NULL,
	`actor_id` varchar(128) NOT NULL,
	`action` varchar(128) NOT NULL,
	`target_type` varchar(64) NOT NULL,
	`target_id` varchar(128) NOT NULL,
	`result` varchar(32) NOT NULL,
	`request_id` varchar(128) NOT NULL,
	`reason` varchar(512),
	`metadata` json,
	`occurred_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_audit_log` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `idempotency_record` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16),
	`actor_scope_digest` binary(32) NOT NULL,
	`operation` varchar(128) NOT NULL,
	`key_digest` binary(32) NOT NULL,
	`request_hash` binary(32) NOT NULL,
	`state` varchar(32) NOT NULL,
	`resource_type` varchar(64),
	`resource_id` binary(16),
	`response_code` int unsigned,
	`response_body` json,
	`expires_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_idempotency_record` PRIMARY KEY(`id`),
	CONSTRAINT `uq_idempotency_scope_key` UNIQUE(`actor_scope_digest`,`operation`,`key_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `job` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16),
	`type` varchar(128) NOT NULL,
	`dedup_key` binary(32) NOT NULL,
	`payload` json NOT NULL,
	`state` varchar(32) NOT NULL DEFAULT 'pending',
	`priority` int NOT NULL DEFAULT 0,
	`attempt` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 5,
	`run_after` datetime(6) NOT NULL,
	`lease_owner` varchar(128),
	`lease_until` datetime(6),
	`last_error_code` varchar(64),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`completed_at` datetime(6),
	CONSTRAINT `pk_job` PRIMARY KEY(`id`),
	CONSTRAINT `uq_job_type_dedup` UNIQUE(`type`,`dedup_key`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `knowledge_revision` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`source_id` binary(16) NOT NULL,
	`revision_no` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`content_hash` binary(32) NOT NULL,
	`source_metadata` json NOT NULL,
	`object_key` varchar(1024),
	`parser_version` varchar(64),
	`embedding_model` varchar(128),
	`embedding_version` varchar(64),
	`derived_index_ref` varchar(512),
	`failure_code` varchar(64),
	`effective_from` datetime(6),
	`effective_until` datetime(6),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`processed_at` datetime(6),
	CONSTRAINT `pk_knowledge_revision` PRIMARY KEY(`id`),
	CONSTRAINT `uq_knowledge_revision_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`),
	CONSTRAINT `uq_knowledge_revision_number` UNIQUE(`merchant_id`,`assistant_id`,`source_id`,`revision_no`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `knowledge_source` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`type` varchar(32) NOT NULL,
	`title` varchar(300) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`current_revision_no` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_knowledge_source` PRIMARY KEY(`id`),
	CONSTRAINT `uq_knowledge_source_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `merchant` (
	`id` binary(16) NOT NULL,
	`name` varchar(200) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant` PRIMARY KEY(`id`),
	CONSTRAINT `uq_merchant_scope` UNIQUE(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `message` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`session_id` binary(16) NOT NULL,
	`turn_id` binary(16) NOT NULL,
	`seq_no` int unsigned NOT NULL,
	`role` varchar(24) NOT NULL,
	`state` varchar(32) NOT NULL,
	`client_request_id` varchar(128),
	`content` mediumtext NOT NULL,
	`error_code` varchar(64),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`completed_at` datetime(6),
	CONSTRAINT `pk_message` PRIMARY KEY(`id`),
	CONSTRAINT `uq_message_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`),
	CONSTRAINT `uq_message_sequence` UNIQUE(`session_id`,`seq_no`),
	CONSTRAINT `uq_message_client_request` UNIQUE(`session_id`,`client_request_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `outbox_event` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16),
	`event_type` varchar(128) NOT NULL,
	`aggregate_type` varchar(64) NOT NULL,
	`aggregate_id` binary(16) NOT NULL,
	`schema_version` int unsigned NOT NULL,
	`payload` json NOT NULL,
	`state` varchar(32) NOT NULL DEFAULT 'pending',
	`attempt` int unsigned NOT NULL DEFAULT 0,
	`available_at` datetime(6) NOT NULL,
	`lease_owner` varchar(128),
	`lease_until` datetime(6),
	`occurred_at` datetime(6) NOT NULL,
	`published_at` datetime(6),
	`trace_id` varchar(128),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_outbox_event` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `assistant_release` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`release_no` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL,
	`config_snapshot` json NOT NULL,
	`prompt_template_version` varchar(64) NOT NULL,
	`retrieval_policy_version` varchar(64) NOT NULL,
	`model_policy_version` varchar(64) NOT NULL,
	`created_by` binary(16),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`activated_at` datetime(6),
	CONSTRAINT `pk_assistant_release` PRIMARY KEY(`id`),
	CONSTRAINT `uq_release_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`),
	CONSTRAINT `uq_release_number` UNIQUE(`merchant_id`,`assistant_id`,`release_no`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `conversation_session` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`release_id` binary(16) NOT NULL,
	`visitor_credential_id` binary(16) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`next_sequence` int unsigned NOT NULL DEFAULT 1,
	`active_turn_id` binary(16),
	`version` int unsigned NOT NULL DEFAULT 1,
	`last_activity_at` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`ended_at` datetime(6),
	`ended_reason` varchar(64),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_conversation_session` PRIMARY KEY(`id`),
	CONSTRAINT `uq_session_scope` UNIQUE(`merchant_id`,`assistant_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `assistant_draft` ADD CONSTRAINT `fk_assistant_draft_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant` ADD CONSTRAINT `fk_assistant_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_revision` ADD CONSTRAINT `fk_knowledge_revision_source` FOREIGN KEY (`merchant_id`,`assistant_id`,`source_id`) REFERENCES `knowledge_source`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledge_source` ADD CONSTRAINT `fk_knowledge_source_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message` ADD CONSTRAINT `fk_message_session` FOREIGN KEY (`merchant_id`,`assistant_id`,`session_id`) REFERENCES `conversation_session`(`merchant_id`,`assistant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant_release` ADD CONSTRAINT `fk_release_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assistant` ADD CONSTRAINT `fk_assistant_active_release` FOREIGN KEY (`merchant_id`,`id`,`active_release_id`) REFERENCES `assistant_release`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_session` ADD CONSTRAINT `fk_session_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_session` ADD CONSTRAINT `fk_session_release` FOREIGN KEY (`merchant_id`,`assistant_id`,`release_id`) REFERENCES `assistant_release`(`merchant_id`,`assistant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_assistant_merchant_status` ON `assistant` (`merchant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_merchant_time` ON `audit_log` (`merchant_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_request` ON `audit_log` (`request_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_target` ON `audit_log` (`target_type`,`target_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_idempotency_expiry` ON `idempotency_record` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_idempotency_merchant` ON `idempotency_record` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_claim` ON `job` (`state`,`run_after`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_lease_recovery` ON `job` (`state`,`lease_until`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_merchant` ON `job` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_revision_status` ON `knowledge_revision` (`merchant_id`,`assistant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_source_status` ON `knowledge_source` (`merchant_id`,`assistant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_merchant_status` ON `merchant` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_session_created` ON `message` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_claim` ON `outbox_event` (`state`,`available_at`,`lease_until`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_aggregate` ON `outbox_event` (`aggregate_type`,`aggregate_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_release_status` ON `assistant_release` (`merchant_id`,`assistant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_session_resume` ON `conversation_session` (`merchant_id`,`assistant_id`,`visitor_credential_id`,`status`,`expires_at`);

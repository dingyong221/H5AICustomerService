CREATE TABLE `external_identity` (
	`id` binary(16) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`issuer` varchar(255) NOT NULL,
	`audience` varchar(191) NOT NULL,
	`subject_lookup_key` binary(32) NOT NULL,
	`subject_lookup_key_version` int unsigned NOT NULL,
	`phone_match_verified_at` datetime(6),
	`last_seen_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_external_identity` PRIMARY KEY(`id`),
	CONSTRAINT `uq_external_identity_subject` UNIQUE(`provider`,`issuer`,`audience`,`subject_lookup_key`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `industry_template` (
	`id` binary(16) NOT NULL,
	`code` varchar(64) NOT NULL,
	`version` int unsigned NOT NULL,
	`display_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`required_materials` json NOT NULL,
	`required_policies` json NOT NULL,
	`template` json NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_industry_template` PRIMARY KEY(`id`),
	CONSTRAINT `uq_industry_template_code_version` UNIQUE(`code`,`version`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `merchant_membership` (
	`merchant_id` binary(16) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`role` varchar(32) NOT NULL DEFAULT 'owner',
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant_membership` PRIMARY KEY(`merchant_id`,`merchant_user_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `merchant_user` (
	`id` binary(16) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant_user` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `onboarding_session` (
	`id` binary(16) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`merchant_id` binary(16),
	`assistant_id` binary(16),
	`industry_template_id` binary(16),
	`state` varchar(32) NOT NULL,
	`cancelled_from_state` varchar(32),
	`answers` json NOT NULL,
	`missing_items` json NOT NULL,
	`generation_error_code` varchar(64),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`cancelled_at` datetime(6),
	`completed_at` datetime(6),
	CONSTRAINT `pk_onboarding_session` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `external_identity` ADD CONSTRAINT `fk_external_identity_merchant_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `merchant_membership` ADD CONSTRAINT `fk_merchant_membership_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `merchant_membership` ADD CONSTRAINT `fk_merchant_membership_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onboarding_session` ADD CONSTRAINT `fk_onboarding_session_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onboarding_session` ADD CONSTRAINT `fk_onboarding_session_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onboarding_session` ADD CONSTRAINT `fk_onboarding_session_industry_template` FOREIGN KEY (`industry_template_id`) REFERENCES `industry_template`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onboarding_session` ADD CONSTRAINT `fk_onboarding_session_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_external_identity_user` ON `external_identity` (`merchant_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_industry_template_status` ON `industry_template` (`status`,`code`,`version`);--> statement-breakpoint
CREATE INDEX `idx_merchant_membership_user` ON `merchant_membership` (`merchant_user_id`,`status`,`merchant_id`);--> statement-breakpoint
CREATE INDEX `idx_merchant_user_status` ON `merchant_user` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_onboarding_user_updated` ON `onboarding_session` (`merchant_user_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_onboarding_state` ON `onboarding_session` (`state`,`updated_at`,`id`);

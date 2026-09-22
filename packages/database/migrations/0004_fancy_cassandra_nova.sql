-- Initial-release precondition: OAuth codes, refresh families, authorization transactions, and
-- consent grants must be empty. A populated deployment requires an audited identity/grant backfill
-- before applying the NOT NULL columns and session/identity foreign keys below.
CREATE TABLE `platform_login_session` (
	`session_digest` binary(32) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`csrf_digest` binary(32) NOT NULL,
	`authentication_level` varchar(32) NOT NULL,
	`authenticated_at` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`revoked_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_platform_login_session` PRIMARY KEY(`session_digest`),
	CONSTRAINT `uq_platform_login_session_account` UNIQUE(`session_digest`,`merchant_user_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `oauth_authorization_code` MODIFY COLUMN `consent_grant_id` binary(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token_family` MODIFY COLUMN `consent_grant_id` binary(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD `external_identity_id` binary(16);--> statement-breakpoint
ALTER TABLE `connector_consent_grant` ADD `external_identity_id` binary(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `external_identity` ADD CONSTRAINT `uq_external_identity_account` UNIQUE(`id`,`merchant_user_id`);--> statement-breakpoint
ALTER TABLE `platform_login_session` ADD CONSTRAINT `fk_platform_login_session_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_platform_login_session_user` ON `platform_login_session` (`merchant_user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_login_session_expiry` ON `platform_login_session` (`revoked_at`,`expires_at`,`session_digest`);--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD CONSTRAINT `fk_connector_authorization_session` FOREIGN KEY (`login_session_digest`,`merchant_user_id`) REFERENCES `platform_login_session`(`session_digest`,`merchant_user_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD CONSTRAINT `fk_connector_authorization_identity` FOREIGN KEY (`external_identity_id`,`merchant_user_id`) REFERENCES `external_identity`(`id`,`merchant_user_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_consent_grant` ADD CONSTRAINT `fk_connector_consent_identity` FOREIGN KEY (`external_identity_id`,`merchant_user_id`) REFERENCES `external_identity`(`id`,`merchant_user_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workbuddy_bridge_state` ADD CONSTRAINT `fk_workbuddy_bridge_session` FOREIGN KEY (`login_session_digest`,`merchant_user_id`) REFERENCES `platform_login_session`(`session_digest`,`merchant_user_id`) ON DELETE restrict ON UPDATE no action;

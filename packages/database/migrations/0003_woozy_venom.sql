CREATE TABLE `connector_authorization_transaction` (
	`transaction_digest` binary(32) NOT NULL,
	`login_session_digest` binary(32) NOT NULL,
	`client_id_digest` binary(32) NOT NULL,
	`redirect_uri` varchar(2048) NOT NULL,
	`resource` varchar(2048) NOT NULL,
	`resource_digest` binary(32) NOT NULL,
	`scope` varchar(64) NOT NULL,
	`code_challenge` varchar(128) NOT NULL,
	`connector_state_digest` binary(32) NOT NULL,
	`step` varchar(64) NOT NULL,
	`merchant_user_id` binary(16),
	`merchant_id` binary(16),
	`candidate_version` int unsigned NOT NULL DEFAULT 0,
	`expires_at` datetime(6) NOT NULL,
	`consumed_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_connector_authorization_tx` PRIMARY KEY(`transaction_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `connector_consent_grant` (
	`id` binary(16) NOT NULL,
	`binding_id_digest` binary(32) NOT NULL,
	`binding_id` varchar(191) NOT NULL,
	`active_key_digest` binary(32),
	`authorization_transaction_digest` binary(32) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`client_id_digest` binary(32) NOT NULL,
	`resource` varchar(2048) NOT NULL,
	`resource_digest` binary(32) NOT NULL,
	`scope` varchar(64) NOT NULL,
	`consent_version` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`granted_at` datetime(6) NOT NULL,
	`revoked_at` datetime(6),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_connector_consent_grant` PRIMARY KEY(`id`),
	CONSTRAINT `uq_connector_consent_binding` UNIQUE(`binding_id_digest`),
	CONSTRAINT `uq_connector_consent_transaction` UNIQUE(`authorization_transaction_digest`),
	CONSTRAINT `uq_connector_consent_active` UNIQUE(`active_key_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `workbuddy_bridge_state` (
	`state_digest` binary(32) NOT NULL,
	`authorization_transaction_digest` binary(32) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`login_session_digest` binary(32) NOT NULL,
	`configuration_id` varchar(128) NOT NULL,
	`configuration_version` int unsigned NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`consumed_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_workbuddy_bridge_state` PRIMARY KEY(`state_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `external_identity` ADD `status` varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_identity` ADD `bound_at` datetime(6) DEFAULT CURRENT_TIMESTAMP(6) NOT NULL;--> statement-breakpoint
ALTER TABLE `external_identity` ADD `unlink_requested_at` datetime(6);--> statement-breakpoint
ALTER TABLE `external_identity` ADD `revoked_at` datetime(6);--> statement-breakpoint
ALTER TABLE `oauth_authorization_code` ADD `consent_grant_id` binary(16);--> statement-breakpoint
ALTER TABLE `oauth_refresh_token_family` ADD `consent_grant_id` binary(16);--> statement-breakpoint
ALTER TABLE `external_identity` ADD CONSTRAINT `uq_external_identity_user_context` UNIQUE(`merchant_user_id`,`provider`,`issuer`,`audience`);--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD CONSTRAINT `fk_connector_authorization_client` FOREIGN KEY (`client_id_digest`) REFERENCES `oauth_public_client`(`client_id_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD CONSTRAINT `fk_connector_authorization_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_authorization_transaction` ADD CONSTRAINT `fk_connector_authorization_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_consent_grant` ADD CONSTRAINT `fk_connector_consent_transaction` FOREIGN KEY (`authorization_transaction_digest`) REFERENCES `connector_authorization_transaction`(`transaction_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_consent_grant` ADD CONSTRAINT `fk_connector_consent_client` FOREIGN KEY (`client_id_digest`) REFERENCES `oauth_public_client`(`client_id_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_consent_grant` ADD CONSTRAINT `fk_connector_consent_membership` FOREIGN KEY (`merchant_id`,`merchant_user_id`) REFERENCES `merchant_membership`(`merchant_id`,`merchant_user_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workbuddy_bridge_state` ADD CONSTRAINT `fk_workbuddy_bridge_authorization` FOREIGN KEY (`authorization_transaction_digest`) REFERENCES `connector_authorization_transaction`(`transaction_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workbuddy_bridge_state` ADD CONSTRAINT `fk_workbuddy_bridge_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_connector_authorization_step_expiry` ON `connector_authorization_transaction` (`step`,`expires_at`,`transaction_digest`);--> statement-breakpoint
CREATE INDEX `idx_connector_authorization_session` ON `connector_authorization_transaction` (`login_session_digest`,`expires_at`,`transaction_digest`);--> statement-breakpoint
CREATE INDEX `idx_connector_authorization_user` ON `connector_authorization_transaction` (`merchant_user_id`,`updated_at`,`transaction_digest`);--> statement-breakpoint
CREATE INDEX `idx_connector_consent_user_status` ON `connector_consent_grant` (`merchant_user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_connector_consent_merchant_status` ON `connector_consent_grant` (`merchant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_workbuddy_bridge_state_expiry` ON `workbuddy_bridge_state` (`consumed_at`,`expires_at`,`state_digest`);--> statement-breakpoint
CREATE INDEX `idx_workbuddy_bridge_state_session` ON `workbuddy_bridge_state` (`login_session_digest`,`created_at`,`state_digest`);--> statement-breakpoint
ALTER TABLE `oauth_authorization_code` ADD CONSTRAINT `fk_oauth_authorization_code_grant` FOREIGN KEY (`consent_grant_id`) REFERENCES `connector_consent_grant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token_family` ADD CONSTRAINT `fk_oauth_refresh_family_grant` FOREIGN KEY (`consent_grant_id`) REFERENCES `connector_consent_grant`(`id`) ON DELETE restrict ON UPDATE no action;

CREATE TABLE `oauth_authorization_code` (
	`code_digest` binary(32) NOT NULL,
	`client_id_digest` binary(32) NOT NULL,
	`redirect_uri` varchar(2048) NOT NULL,
	`resource` varchar(2048) NOT NULL,
	`scope` varchar(64) NOT NULL,
	`code_challenge` varchar(128) NOT NULL,
	`binding_id` varchar(191) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`consumed_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_oauth_authorization_code` PRIMARY KEY(`code_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `oauth_public_client` (
	`client_id_digest` binary(32) NOT NULL,
	`client_id` varchar(128) NOT NULL,
	`client_name` varchar(200),
	`redirect_uris` json NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_oauth_public_client` PRIMARY KEY(`client_id_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `oauth_refresh_token_family` (
	`family_id_digest` binary(32) NOT NULL,
	`family_id` varchar(128) NOT NULL,
	`client_id_digest` binary(32) NOT NULL,
	`binding_id` varchar(191) NOT NULL,
	`resource` varchar(2048) NOT NULL,
	`scope` varchar(64) NOT NULL,
	`revoked_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_oauth_refresh_token_family` PRIMARY KEY(`family_id_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`token_digest` binary(32) NOT NULL,
	`family_id_digest` binary(32) NOT NULL,
	`replacement_token_digest` binary(32),
	`expires_at` datetime(6) NOT NULL,
	`used_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_oauth_refresh_token` PRIMARY KEY(`token_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `oauth_authorization_code` ADD CONSTRAINT `fk_oauth_authorization_code_client` FOREIGN KEY (`client_id_digest`) REFERENCES `oauth_public_client`(`client_id_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token_family` ADD CONSTRAINT `fk_oauth_refresh_family_client` FOREIGN KEY (`client_id_digest`) REFERENCES `oauth_public_client`(`client_id_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD CONSTRAINT `fk_oauth_refresh_token_family` FOREIGN KEY (`family_id_digest`) REFERENCES `oauth_refresh_token_family`(`family_id_digest`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_oauth_authorization_code_expiry` ON `oauth_authorization_code` (`consumed_at`,`expires_at`,`code_digest`);--> statement-breakpoint
CREATE INDEX `idx_oauth_public_client_created` ON `oauth_public_client` (`created_at`,`client_id_digest`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_family_client` ON `oauth_refresh_token_family` (`client_id_digest`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_family_revoked` ON `oauth_refresh_token_family` (`revoked_at`,`family_id_digest`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_token_family` ON `oauth_refresh_token` (`family_id_digest`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_token_expiry` ON `oauth_refresh_token` (`used_at`,`expires_at`,`token_digest`);

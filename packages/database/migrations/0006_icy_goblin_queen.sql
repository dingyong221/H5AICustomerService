CREATE TABLE `merchant_setup_invitation` (
	`token_digest` binary(32) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`created_by_operator` varchar(128) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`claimed_at` datetime(6),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant_setup_invitation` PRIMARY KEY(`token_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `merchant_setup_invitation` ADD CONSTRAINT `fk_merchant_setup_invitation_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_merchant_setup_invitation_merchant` ON `merchant_setup_invitation` (`merchant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_merchant_setup_invitation_expiry` ON `merchant_setup_invitation` (`claimed_at`,`expires_at`);

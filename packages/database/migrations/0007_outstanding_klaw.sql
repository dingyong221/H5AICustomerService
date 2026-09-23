CREATE TABLE `merchant_password_credential` (
	`merchant_user_id` binary(16) NOT NULL,
	`phone_lookup_digest` binary(32) NOT NULL,
	`password_salt` binary(16) NOT NULL,
	`password_hash` binary(64) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant_password_credential` PRIMARY KEY(`merchant_user_id`),
	CONSTRAINT `uq_merchant_password_phone` UNIQUE(`phone_lookup_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `merchant_password_credential` ADD CONSTRAINT `fk_merchant_password_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE restrict ON UPDATE no action;

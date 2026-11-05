CREATE TABLE `marketplace_allocation` (
	`subject_digest` binary(32) NOT NULL,
	`product` varchar(64) NOT NULL,
	`merchant_user_id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `marketplace_allocation_subject_digest_product_pk` PRIMARY KEY(`subject_digest`,`product`),
	CONSTRAINT `uq_market_account_product` UNIQUE(`merchant_user_id`,`product`),
	CONSTRAINT `uq_market_merchant_product` UNIQUE(`merchant_id`,`product`),
	CONSTRAINT `uq_market_assistant_product` UNIQUE(`assistant_id`,`product`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_campaign` (
	`campaign` varchar(48) NOT NULL,
	`claimed_count` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `marketplace_campaign_campaign` PRIMARY KEY(`campaign`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_claim_code` (
	`code_digest` binary(32) NOT NULL,
	`subject_digest` binary(32) NOT NULL,
	`product` varchar(64) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `marketplace_claim_code_code_digest_pk` PRIMARY KEY(`code_digest`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_entitlement` (
	`subject_digest` binary(32) NOT NULL,
	`product` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`version` int unsigned NOT NULL,
	`valid_from` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`model_call_limit` int unsigned NOT NULL,
	`model_calls_reserved` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `marketplace_entitlement_subject_digest_product_pk` PRIMARY KEY(`subject_digest`,`product`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_free_claim` (
	`subject_digest` binary(32) NOT NULL,
	`product` varchar(64) NOT NULL,
	`claim_id` binary(16) NOT NULL,
	`source` varchar(64) NOT NULL,
	`price_version` varchar(64) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `marketplace_free_claim_subject_digest_product_pk` PRIMARY KEY(`subject_digest`,`product`),
	CONSTRAINT `uq_market_claim_id` UNIQUE(`claim_id`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_model_attempt` (
	`id` binary(16) NOT NULL,
	`subject_digest` binary(32) NOT NULL,
	`product` varchar(64) NOT NULL,
	`operation` varchar(64) NOT NULL,
	`state` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `marketplace_model_attempt_id_pk` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `marketplace_signup_throttle` (
	`scope_digest` binary(32) NOT NULL,
	`bucket` int unsigned NOT NULL,
	`attempts` int unsigned NOT NULL,
	CONSTRAINT `marketplace_signup_throttle_scope_digest` PRIMARY KEY(`scope_digest`)
);
--> statement-breakpoint
ALTER TABLE `marketplace_allocation` ADD CONSTRAINT `fk_market_allocation_entitlement` FOREIGN KEY (`subject_digest`,`product`) REFERENCES `marketplace_entitlement`(`subject_digest`,`product`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_allocation` ADD CONSTRAINT `fk_market_allocation_user` FOREIGN KEY (`merchant_user_id`) REFERENCES `merchant_user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_allocation` ADD CONSTRAINT `fk_market_allocation_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_allocation` ADD CONSTRAINT `fk_market_allocation_assistant` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_claim_code` ADD CONSTRAINT `fk_market_code_claim` FOREIGN KEY (`subject_digest`,`product`) REFERENCES `marketplace_free_claim`(`subject_digest`,`product`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_entitlement` ADD CONSTRAINT `fk_market_entitlement_claim` FOREIGN KEY (`subject_digest`,`product`) REFERENCES `marketplace_free_claim`(`subject_digest`,`product`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketplace_model_attempt` ADD CONSTRAINT `fk_market_attempt_entitlement` FOREIGN KEY (`subject_digest`,`product`) REFERENCES `marketplace_entitlement`(`subject_digest`,`product`) ON DELETE no action ON UPDATE no action;
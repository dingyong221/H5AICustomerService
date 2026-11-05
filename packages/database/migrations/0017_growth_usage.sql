CREATE TABLE `growth_invitation` (
	`merchant_id` binary(16) NOT NULL,
	`owner_id` binary(16) NOT NULL,
	`public_code` varchar(43) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `growth_invitation_merchant_id` PRIMARY KEY(`merchant_id`),
	CONSTRAINT `uq_growth_code` UNIQUE(`public_code`)
);
--> statement-breakpoint
CREATE TABLE `growth_referral` (
	`invitee_id` binary(16) NOT NULL,
	`inviter_id` binary(16) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `growth_referral_invitee_id` PRIMARY KEY(`invitee_id`)
);
--> statement-breakpoint
CREATE TABLE `growth_touch` (
	`token_digest` binary(32) NOT NULL,
	`inviter_id` binary(16) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `growth_touch_token_digest` PRIMARY KEY(`token_digest`)
);
--> statement-breakpoint
CREATE TABLE `product_usage_actor` (
	`actor_digest` binary(32) NOT NULL,
	`role` varchar(16) NOT NULL,
	`first_seen_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `product_usage_actor_actor_digest` PRIMARY KEY(`actor_digest`)
);
--> statement-breakpoint
CREATE TABLE `product_usage_budget` (
	`day` varchar(10) NOT NULL,
	`accepted` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `product_usage_budget_day` PRIMARY KEY(`day`)
);
--> statement-breakpoint
CREATE TABLE `product_usage_day` (
	`actor_digest` binary(32) NOT NULL,
	`day` varchar(10) NOT NULL,
	`role` varchar(16) NOT NULL,
	`merchant_id` binary(16),
	`views` int unsigned NOT NULL DEFAULT 0,
	`actions` int unsigned NOT NULL DEFAULT 0,
	`active_ms` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `product_usage_day_actor_digest_day_pk` PRIMARY KEY(`actor_digest`,`day`)
);
--> statement-breakpoint
CREATE TABLE `product_usage_event` (
	`event_id` binary(16) NOT NULL,
	`payload_digest` binary(32) NOT NULL,
	`actor_digest` binary(32) NOT NULL,
	`role` varchar(16) NOT NULL,
	`merchant_id` binary(16),
	`page` varchar(40) NOT NULL,
	`event` varchar(32) NOT NULL,
	`control` varchar(64) NOT NULL,
	`page_instance` binary(16) NOT NULL,
	`active_ms` int unsigned NOT NULL DEFAULT 0,
	`client_at` datetime(6) NOT NULL,
	`received_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `product_usage_event_event_id` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_growth_referrer_created` ON `growth_referral` (`inviter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_growth_touch_expiry` ON `growth_touch` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_actor_first` ON `product_usage_actor` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_day_role` ON `product_usage_day` (`day`,`role`);--> statement-breakpoint
CREATE INDEX `idx_usage_received` ON `product_usage_event` (`received_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_actor_received` ON `product_usage_event` (`actor_digest`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_merchant_received` ON `product_usage_event` (`merchant_id`,`received_at`);
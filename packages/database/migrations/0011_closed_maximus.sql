CREATE TABLE `platform_operator_login_throttle` (
	`source_digest` binary(32) NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`window_started_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_platform_operator_login_throttle` PRIMARY KEY(`source_digest`)
);
--> statement-breakpoint
CREATE INDEX `idx_platform_operator_login_throttle_updated` ON `platform_operator_login_throttle` (`updated_at`);
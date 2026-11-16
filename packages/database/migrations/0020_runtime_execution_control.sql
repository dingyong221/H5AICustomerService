CREATE TABLE `runtime_execution_control` (
	`scope_key` varchar(64) NOT NULL,
	`scope_type` varchar(16) NOT NULL,
	`merchant_id` binary(16),
	`job_id` binary(16),
	`state` varchar(32) NOT NULL DEFAULT 'active',
	`revision` bigint unsigned NOT NULL DEFAULT 0,
	`changed_at` datetime(6),
	`actor_id` varchar(128),
	`reason` varchar(512),
	`last_request_id` varchar(64),
	CONSTRAINT `pk_runtime_execution_control` PRIMARY KEY(`scope_key`),
	CONSTRAINT `chk_runtime_control_state` CHECK(`runtime_execution_control`.`state` IN ('active','manually_stopped')),
	CONSTRAINT `chk_runtime_control_scope` CHECK((`runtime_execution_control`.`scope_type`='global' AND `runtime_execution_control`.`scope_key`='global' AND `runtime_execution_control`.`merchant_id` IS NULL AND `runtime_execution_control`.`job_id` IS NULL) OR (`runtime_execution_control`.`scope_type`='merchant' AND `runtime_execution_control`.`scope_key`=CONCAT('merchant:',LOWER(HEX(`runtime_execution_control`.`merchant_id`))) AND `runtime_execution_control`.`merchant_id` IS NOT NULL AND `runtime_execution_control`.`job_id` IS NULL) OR (`runtime_execution_control`.`scope_type`='job' AND `runtime_execution_control`.`scope_key`=CONCAT('job:',LOWER(HEX(`runtime_execution_control`.`job_id`))) AND `runtime_execution_control`.`merchant_id` IS NOT NULL AND `runtime_execution_control`.`job_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_control_merchant` ON `runtime_execution_control` (`merchant_id`,`state`);
--> statement-breakpoint
INSERT INTO `runtime_execution_control` (`scope_key`,`scope_type`,`state`,`revision`) VALUES ('global','global','active',0);

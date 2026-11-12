CREATE TABLE `model_call_attempt` (
	`id` binary(16) NOT NULL,
	`merchant_id` binary(16) NOT NULL,
	`job_id` binary(16),
	`claim_generation` bigint unsigned,
	`operation` varchar(64) NOT NULL,
	`state` varchar(32) NOT NULL,
	`provider_request_id` varchar(200),
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	`completed_at` datetime(6),
	CONSTRAINT `pk_model_call_attempt` PRIMARY KEY(`id`),
	CONSTRAINT `uq_model_attempt_job_generation` UNIQUE(`job_id`,`claim_generation`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `job` ADD `claim_generation` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job` ADD `model_outcome` varchar(32) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `job` ADD `model_attempt_id` binary(16);--> statement-breakpoint
ALTER TABLE `model_call_attempt` ADD CONSTRAINT `fk_model_attempt_merchant` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_call_attempt` ADD CONSTRAINT `fk_model_attempt_job` FOREIGN KEY (`job_id`) REFERENCES `job`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_model_attempt_risk` ON `model_call_attempt` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_model_attempt_merchant` ON `model_call_attempt` (`merchant_id`,`created_at`,`id`);
--> statement-breakpoint
-- Old processing jobs have no proof that the supplier was never contacted.
-- Preserve completed history; do not charge a second quota reservation.
INSERT INTO `model_call_attempt`
  (`id`, `merchant_id`, `job_id`, `claim_generation`, `operation`, `state`, `created_at`, `updated_at`, `completed_at`)
SELECT j.id, j.merchant_id, j.id, 0, 'consumer', 'unknown', j.updated_at, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
  FROM `job` j JOIN `merchant` m ON m.id = j.merchant_id
 WHERE j.type = 'conversation.turn' AND j.state = 'processing' AND j.attempt > 0;
--> statement-breakpoint
UPDATE `job` j JOIN `model_call_attempt` a ON a.job_id = j.id AND a.claim_generation = 0
   SET j.model_outcome = 'unknown', j.model_attempt_id = a.id
 WHERE j.type = 'conversation.turn' AND j.state = 'processing' AND j.attempt > 0;

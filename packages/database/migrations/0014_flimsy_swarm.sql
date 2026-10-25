CREATE TABLE `merchant_assistant` (
	`merchant_id` binary(16) NOT NULL,
	`assistant_id` binary(16) NOT NULL,
	`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT `pk_merchant_assistant` PRIMARY KEY(`merchant_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `merchant_assistant` ADD CONSTRAINT `fk_merchant_assistant_scope` FOREIGN KEY (`merchant_id`,`assistant_id`) REFERENCES `assistant`(`merchant_id`,`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Preserve every legacy assistant and its data. A single historically published
-- assistant wins over unissued drafts. With no publication, keep the oldest draft.
-- Multiple historically published assistants deliberately collide on the merchant
-- primary key: preflight must resolve that ambiguity; never silently choose one.
INSERT INTO `merchant_assistant` (`merchant_id`, `assistant_id`, `created_at`)
SELECT a.merchant_id, a.id, a.created_at
FROM assistant a
WHERE EXISTS (
  SELECT 1 FROM assistant_release r
  WHERE r.merchant_id = a.merchant_id AND r.assistant_id = a.id
) OR a.active_release_id IS NOT NULL
OR (
  NOT EXISTS (
    SELECT 1 FROM assistant published
    WHERE published.merchant_id = a.merchant_id
      AND (published.active_release_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM assistant_release r
        WHERE r.merchant_id = published.merchant_id AND r.assistant_id = published.id
      ))
  ) AND NOT EXISTS (
    SELECT 1 FROM assistant earlier
    WHERE earlier.merchant_id = a.merchant_id
      AND (earlier.created_at < a.created_at OR (earlier.created_at = a.created_at AND earlier.id < a.id))
  )
);

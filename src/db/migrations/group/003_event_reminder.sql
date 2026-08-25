-- Marks when the time-based event reminder (scheduler/index.ts's eventReminder job)
-- was sent for this fact, so the every-5-minutes polling job doesn't re-send it on
-- every subsequent poll. NULL until sent; only meaningful for kind='event' facts
-- that have a parsed time -- everything else just never gets set.
ALTER TABLE facts ADD COLUMN reminded_at INTEGER;

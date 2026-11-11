ALTER TABLE schedules ADD COLUMN ends_at timestamptz;
UPDATE schedules SET ends_at = LEAST(starts_at + interval '1 hour',
 ((starts_at AT TIME ZONE 'Asia/Seoul')::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul');
ALTER TABLE schedules ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE schedules ADD CHECK (ends_at > starts_at);

ALTER TABLE notifications ADD COLUMN ends_at timestamptz;
UPDATE notifications n SET ends_at=s.ends_at FROM schedules s WHERE s.id=n.schedule_id;
ALTER TABLE notifications ALTER COLUMN schedule_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN digest_date date UNIQUE;
ALTER TABLE notifications ADD COLUMN digest_text text;
ALTER TABLE notifications ADD CHECK ((schedule_id IS NOT NULL AND digest_date IS NULL)
 OR (schedule_id IS NULL AND digest_date IS NOT NULL));

-- Adopt the fixed reminder policy without replaying previously completed deliveries.
UPDATE schedules SET remind_at=starts_at - interval '10 minutes';
UPDATE notifications SET due_at=starts_at - interval '10 minutes',
 next_attempt_at=starts_at - interval '10 minutes',
 status=CASE WHEN starts_at - interval '10 minutes' > now() THEN 'PENDING' ELSE 'CANCELLED' END
 WHERE status='PENDING';

-- Durable cursor: catch up missed mornings after restarts, one digest per Seoul date.
CREATE TABLE digest_cursor (id integer PRIMARY KEY CHECK(id=1), next_date date NOT NULL);
INSERT INTO digest_cursor VALUES (1, (now() AT TIME ZONE 'Asia/Seoul')::date);

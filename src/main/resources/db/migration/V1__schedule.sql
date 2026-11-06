CREATE TABLE schedules (
 id uuid PRIMARY KEY, title varchar(200) NOT NULL, description varchar(2000) NOT NULL,
 starts_at timestamptz NOT NULL, remind_at timestamptz NOT NULL,
 version bigint NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(remind_at <= starts_at)
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY, schedule_id uuid NOT NULL REFERENCES schedules(id), revision bigint NOT NULL,
 title varchar(200) NOT NULL, starts_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
 status varchar(16) NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','UNKNOWN','FAILED','CANCELLED')),
 attempt_count integer NOT NULL DEFAULT 0, active_attempt uuid, claimed_at timestamptz,
 next_attempt_at timestamptz NOT NULL, UNIQUE(schedule_id,revision)
);
CREATE INDEX notifications_due ON notifications(next_attempt_at) WHERE status='PENDING';
CREATE TABLE notification_attempts (
 id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES notifications(id),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 status varchar(16) NOT NULL, http_status integer, message_id varchar(32), detail varchar(120),
 manual_retry boolean NOT NULL DEFAULT false
);
CREATE INDEX attempts_notification ON notification_attempts(notification_id,started_at);

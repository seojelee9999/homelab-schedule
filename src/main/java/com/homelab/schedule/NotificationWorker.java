package com.homelab.schedule;

import java.time.*;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class NotificationWorker {
    private static final Logger log = LoggerFactory.getLogger(NotificationWorker.class);
    public record Claim(UUID notificationId, UUID attemptId) {}
    private final JdbcTemplate db;
    private final DiscordClient discord;
    private final TransactionTemplate transaction;
    private final boolean enabled;
    private final long claimTimeoutSeconds;

    public NotificationWorker(JdbcTemplate db, DiscordClient discord, PlatformTransactionManager manager,
                              @Value("${schedule.worker-enabled}") boolean enabled,
                              @Value("${schedule.claim-timeout-seconds:60}") long claimTimeoutSeconds) {
        if (claimTimeoutSeconds < 30) throw new IllegalArgumentException("Claim timeout must be at least 30 seconds");
        this.db = db;
        this.discord = discord;
        this.enabled = enabled;
        this.claimTimeoutSeconds = claimTimeoutSeconds;
        this.transaction = new TransactionTemplate(manager);
        // A claim must commit before any HTTP request, even if called from another transaction.
        this.transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @Scheduled(fixedDelayString = "${schedule.poll-ms:5000}")
    public void poll() {
        if (!enabled) return;
        try {
            enqueueDigests();
            recoverExpired();
            for (int i = 0; i < 20 && !Thread.currentThread().isInterrupted(); i++) {
                Claim claim = claimNext();
                if (claim == null) break;
                send(claim);
            }
        } catch (RuntimeException e) {
            // A failed result commit leaves durable SENDING for recovery, never an automatic retry.
            log.warn("Notification cycle could not finish; durable claims will be checked on the next cycle");
        }
    }

    public void enqueueDigests() {
        transaction.executeWithoutResult(tx -> {
            LocalDate day = db.queryForObject("SELECT next_date FROM digest_cursor WHERE id=1 FOR UPDATE", LocalDate.class);
            ZonedDateTime now = ZonedDateTime.now(ScheduleService.SEOUL);
            // Bound recovery work per poll; the cursor keeps every missed morning durable.
            for (int i = 0; i < 7 && !day.atTime(6, 0).atZone(ScheduleService.SEOUL).isAfter(now); i++, day = day.plusDays(1)) {
                var start = day.atStartOfDay(ScheduleService.SEOUL).toOffsetDateTime();
                var end = day.plusDays(1).atStartOfDay(ScheduleService.SEOUL).toOffsetDateTime();
                var entries = db.query("SELECT title,description,starts_at,ends_at FROM schedules WHERE deleted_at IS NULL AND starts_at>=? AND starts_at<? ORDER BY starts_at,id",
                        (rs, row) -> DiscordClient.timeRange(rs.getObject("starts_at", OffsetDateTime.class).toInstant(),
                                rs.getObject("ends_at", OffsetDateTime.class).toInstant()) + " · " + rs.getString("title")
                                + (rs.getString("description").isBlank() ? "" : "\n  " + rs.getString("description")), start, end);
                String text = entries.isEmpty() ? "등록된 일정이 없습니다." : String.join("\n\n", entries);
                var due = day.atTime(6, 0).atZone(ScheduleService.SEOUL).toOffsetDateTime();
                db.update("""
                        INSERT INTO notifications(id,revision,title,starts_at,due_at,status,next_attempt_at,digest_date,digest_text)
                        VALUES(?,1,?,?,?,'PENDING',?,?,?) ON CONFLICT(digest_date) DO NOTHING
                        """, UUID.randomUUID(), day + " · 하루 일정 " + entries.size() + "개", due, due, due, day, text);
                db.update("UPDATE digest_cursor SET next_date=? WHERE id=1", day.plusDays(1));
            }
        });
    }

    public Claim claimNext() {
        return transaction.execute(tx -> {
            List<UUID> ids = db.query("""
                    SELECT id FROM notifications WHERE status='PENDING' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
                    """, (rs, row) -> rs.getObject("id", UUID.class));
            if (ids.isEmpty()) return null;
            Claim claim = new Claim(ids.get(0), UUID.randomUUID());
            db.update("""
                    UPDATE notifications SET status='SENDING',active_attempt=?,claimed_at=now(),
                    attempt_count=attempt_count+1 WHERE id=?
                    """, claim.attemptId(), claim.notificationId());
            db.update("INSERT INTO notification_attempts(id,notification_id,status) VALUES(?,?,'SENDING')",
                    claim.attemptId(), claim.notificationId());
            return claim;
        });
    }

    public void send(Claim claim) {
        transaction.executeWithoutResult(tx -> {
            var rows = db.query("""
                    SELECT title,starts_at,ends_at,digest_text,claimed_at <= clock_timestamp() - (? * interval '1 second') AS expired
                    FROM notifications WHERE id=? AND status='SENDING' AND active_attempt=? FOR UPDATE
                    """, (rs, row) -> new Pending(rs.getString("title"), rs.getObject("starts_at", OffsetDateTime.class),
                            rs.getObject("ends_at", OffsetDateTime.class), rs.getString("digest_text"), rs.getBoolean("expired")), claimTimeoutSeconds, claim.notificationId(), claim.attemptId());
            if (rows.isEmpty()) return; // Recovery, resolution, or a newer attempt fenced this sender out.
            Pending pending = rows.get(0);
            if (pending.expired()) { markUnknown(claim); return; }
            // Keep the row lock throughout HTTP and the result update. Recovery uses SKIP LOCKED.
            DiscordClient.Delivery result = pending.digestText() == null
                    ? discord.send(claim.notificationId(), pending.title(), pending.startsAt().toInstant(), pending.endsAt().toInstant())
                    : discord.sendDigest(claim.notificationId(), pending.title(), pending.digestText());
            db.update("""
                    UPDATE notification_attempts SET status=?,finished_at=clock_timestamp(),http_status=?,
                    message_id=?,detail=? WHERE id=?
                    """, result.status().equals("PENDING") ? "RATE_LIMITED" : result.status(), result.httpStatus(),
                    result.messageId(), result.detail(), claim.attemptId());
            db.update("""
                    UPDATE notifications SET status=?,active_attempt=NULL,claimed_at=NULL,
                    next_attempt_at=CASE WHEN ? THEN clock_timestamp() + (? * interval '1 millisecond')
                    ELSE next_attempt_at END WHERE id=?
                    """, result.status(), result.retryMillis() != null,
                    result.retryMillis() == null ? 0L : result.retryMillis(), claim.notificationId());
        });
    }

    public int recoverExpired() {
        return transaction.execute(tx -> {
            List<Claim> claims = db.query("""
                    SELECT id,active_attempt FROM notifications WHERE status='SENDING'
                    AND claimed_at <= now() - (? * interval '1 second')
                    ORDER BY claimed_at LIMIT 100 FOR UPDATE SKIP LOCKED
                    """, (rs, row) -> new Claim(rs.getObject("id", UUID.class), rs.getObject("active_attempt", UUID.class)),
                    claimTimeoutSeconds);
            claims.forEach(this::markUnknown);
            return claims.size();
        });
    }

    private void markUnknown(Claim claim) {
        db.update("""
                UPDATE notification_attempts SET status='UNKNOWN',finished_at=clock_timestamp(),
                detail='Claim expired; delivery requires operator review' WHERE id=? AND status='SENDING'
                """, claim.attemptId());
        db.update("UPDATE notifications SET status='UNKNOWN',active_attempt=NULL,claimed_at=NULL WHERE id=?",
                claim.notificationId());
    }

    private record Pending(String title, OffsetDateTime startsAt, OffsetDateTime endsAt, String digestText, boolean expired) {}
}

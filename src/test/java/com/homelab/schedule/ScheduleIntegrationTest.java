package com.homelab.schedule;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.server.ResponseStatusException;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {"schedule.worker-enabled=false", "schedule.discord-webhook-url="})
@AutoConfigureMockMvc
class ScheduleIntegrationTest {
    // A separate schema per run protects pre-existing tables. Use a dedicated test database regardless.
    private static final String SCHEMA = "schedule_it_" + UUID.randomUUID().toString().replace("-", "");
    @DynamicPropertySource static void isolatedSchema(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.hikari.schema", () -> SCHEMA);
        properties.add("spring.flyway.default-schema", () -> SCHEMA);
        properties.add("spring.flyway.schemas", () -> SCHEMA);
    }
    @Autowired JdbcTemplate db;
    @Autowired ScheduleService schedules;
    @Autowired NotificationWorker worker;
    @Autowired PlatformTransactionManager manager;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @MockitoBean DiscordClient discord;

    @BeforeEach void clearTestSchema() {
        db.execute("TRUNCATE notification_attempts,notifications,schedules");
        when(discord.send(any(), anyString(), any(), any())).thenReturn(
                new DiscordClient.Delivery("SENT", 200, "123456789", null, "Confirmed by Discord"));
    }
    @AfterAll static void dropTestSchema(@Autowired JdbcTemplate db) {
        db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    private ScheduleService.Input input(Long version) {
        LocalDateTime later = LocalDate.now(ScheduleService.SEOUL).plusDays(1).atTime(10, 0);
        return new ScheduleService.Input("회의 @everyone", "메모", later, later.plusHours(1), version);
    }
    private UUID notification(UUID schedule) {
        return db.queryForObject("SELECT id FROM notifications WHERE schedule_id=? ORDER BY revision DESC LIMIT 1", UUID.class, schedule);
    }
    private UUID due() {
        UUID id = notification(schedules.create(input(null)));
        db.update("UPDATE notifications SET next_attempt_at=now()-interval '1 second' WHERE id=?", id);
        return id;
    }
    private String notificationStatus(UUID id) { return db.queryForObject("SELECT status FROM notifications WHERE id=?", String.class, id); }
    private void expire(UUID id) { db.update("UPDATE notifications SET claimed_at=now()-interval '2 minutes' WHERE id=?", id); }
    private void conflict(Runnable action) {
        assertEquals(409, assertThrows(ResponseStatusException.class, action::run).getStatusCode().value());
    }

    @Test void crudKeepsSeoulInstantAndOptimisticVersionAndCancelsOldRevision() throws Exception {
        var in = input(null);
        String response = mvc.perform(post("/api/schedules").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(in))).andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        UUID id = UUID.fromString(json.readTree(response).path("id").asText());
        var rows = json.readTree(mvc.perform(get("/api/schedules")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertEquals(in.startsAt().atZone(ScheduleService.SEOUL).toInstant(), Instant.parse(rows.get(0).path("starts_at").asText()));
        assertEquals(1, rows.get(0).path("version").asInt());
        UUID oldNotification = notification(id);
        mvc.perform(put("/api/schedules/" + id).with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(input(1L)))).andExpect(status().isOk());
        assertEquals("CANCELLED", notificationStatus(oldNotification));
        UUID newNotification = notification(id);
        assertNotEquals(oldNotification, newNotification);
        mvc.perform(delete("/api/schedules/" + id + "?version=1").with(csrf())).andExpect(status().isConflict());
        mvc.perform(delete("/api/schedules/" + id + "?version=2").with(csrf())).andExpect(status().isOk());
        assertEquals("CANCELLED", notificationStatus(newNotification));
        mvc.perform(get("/api/schedules")).andExpect(content().json("[]"));
        mvc.perform(delete("/api/schedules/" + id + "?version=3").with(csrf())).andExpect(status().isNotFound());
        assertNull(worker.claimNext());
    }

    @Test void realCsrfTokenWorksWithTheBrowserSession() throws Exception {
        String body = json.writeValueAsString(input(null));
        mvc.perform(post("/api/schedules").contentType("application/json").content(body)).andExpect(status().isForbidden());
        var tokenResponse = mvc.perform(get("/api/csrf")).andExpect(status().isOk()).andReturn();
        var token = json.readTree(tokenResponse.getResponse().getContentAsString());
        var session = (MockHttpSession) tokenResponse.getRequest().getSession(false);
        assertNotNull(session);
        mvc.perform(post("/api/schedules").session(session).header(token.path("headerName").asText(), token.path("token").asText())
                .contentType("application/json").content(body)).andExpect(status().isCreated());
        mvc.perform(get("/")).andExpect(status().isOk()).andExpect(forwardedUrl("index.html"));
        mvc.perform(get("/index.html")).andExpect(status().isOk()).andExpect(content().contentTypeCompatibleWith("text/html"));
        mvc.perform(get("/app.js")).andExpect(status().isOk());
    }

    @Test void batchCreatesEveryRowWithItsOwnReminderAndRejectsInvalidRowsAtomically() throws Exception {
        LocalDateTime midnight = LocalDate.now(ScheduleService.SEOUL).plusDays(3).atTime(0, 0);
        var first = new ScheduleService.Input("자정 작업", "전날 알림", midnight, midnight.plusHours(1), null);
        var second = new ScheduleService.Input("오전 작업", "", midnight.plusHours(9), midnight.plusHours(10), null);
        mvc.perform(post("/api/schedules/batch").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("items", List.of(first, second)))))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.ids.length()").value(2));
        assertEquals(2, db.queryForObject("SELECT count(*) FROM schedules", Integer.class));
        assertEquals(2, db.queryForObject("SELECT count(*) FROM notifications WHERE status='PENDING'", Integer.class));
        assertEquals(first.startsAt().minusMinutes(10).atZone(ScheduleService.SEOUL).toInstant(),
                db.queryForObject("SELECT due_at FROM notifications WHERE title='자정 작업'", java.sql.Timestamp.class).toInstant());
        var invalid = new ScheduleService.Input("invalid", "", midnight, midnight.minusHours(1), null);
        mvc.perform(post("/api/schedules/batch").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("items", List.of(first, invalid)))))
                .andExpect(status().isBadRequest());
        assertEquals(2, db.queryForObject("SELECT count(*) FROM schedules", Integer.class));
        for (String body : List.of("{\"items\":[]}", "{\"items\":[null]}",
                json.writeValueAsString(Map.of("items", List.of(new ScheduleService.Input(" ", "", midnight, midnight, null)))),
                json.writeValueAsString(Map.of("items", Collections.nCopies(49, first))))) {
            mvc.perform(post("/api/schedules/batch").with(csrf()).contentType("application/json").content(body))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(post("/api/schedules/batch").contentType("application/json")
                .content(json.writeValueAsString(Map.of("items", List.of(first)))))
                .andExpect(status().isForbidden());
    }

    @Test void batchRollsBackEarlierRowsIfALaterDatabaseWriteFails() {
        var good = input(null);
        db.execute("CREATE FUNCTION reject_batch_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='reject' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$");
        db.execute("CREATE TRIGGER reject_batch BEFORE INSERT ON schedules FOR EACH ROW EXECUTE FUNCTION reject_batch_row()");
        try {
            var bad = new ScheduleService.Input("reject", "", good.startsAt(), good.endsAt(), null);
            assertThrows(RuntimeException.class, () -> schedules.createBatch(List.of(good, bad)));
            assertEquals(0, db.queryForObject("SELECT count(*) FROM schedules", Integer.class));
            assertEquals(0, db.queryForObject("SELECT count(*) FROM notifications", Integer.class));
        } finally {
            db.execute("DROP TRIGGER reject_batch ON schedules");
            db.execute("DROP FUNCTION reject_batch_row()");
        }
    }

    @Test void calendarRangeUsesSeoulBoundariesAndIsNotTruncatedAt500() throws Exception {
        LocalDate first = LocalDate.now(ScheduleService.SEOUL).plusYears(1).withDayOfMonth(1);
        LocalDateTime start = first.atStartOfDay();
        schedules.create(new ScheduleService.Input("before", "", start.minusMinutes(1), start, null));
        UUID template = schedules.create(new ScheduleService.Input("inside", "", start, start.plusHours(1), null));
        schedules.create(new ScheduleService.Input("after", "", first.plusMonths(1).atStartOfDay(), first.plusMonths(1).atTime(1, 0), null));
        db.update("INSERT INTO schedules(id,title,description,starts_at,ends_at,remind_at) SELECT gen_random_uuid(),s.title,s.description,s.starts_at,s.ends_at,s.remind_at FROM schedules s CROSS JOIN generate_series(1,500) WHERE s.id=?", template);
        db.update("INSERT INTO notifications(id,schedule_id,revision,title,starts_at,due_at,status,next_attempt_at) SELECT gen_random_uuid(),s.id,s.version,s.title,s.starts_at,s.remind_at,'PENDING',s.remind_at FROM schedules s WHERE NOT EXISTS(SELECT 1 FROM notifications n WHERE n.schedule_id=s.id)");
        var data = json.readTree(mvc.perform(get("/api/schedules").param("from", first.toString()).param("to", first.plusMonths(1).toString()))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertEquals(501, data.size());
        for (var row : data) assertEquals("inside", row.path("title").asText());
        mvc.perform(get("/api/schedules").param("from", first.toString())).andExpect(status().isBadRequest());
        mvc.perform(get("/api/schedules").param("from", first.toString()).param("to", first.toString())).andExpect(status().isBadRequest());
        mvc.perform(get("/api/schedules").param("from", first.toString()).param("to", first.plusDays(63).toString())).andExpect(status().isBadRequest());
    }

    @Test void rejectsInvalidInputAndStaleUpdates() throws Exception {
        var good = input(null);
        var bodies = List.of(
                new ScheduleService.Input(" ", "", good.startsAt(), good.endsAt(), null),
                new ScheduleService.Input("x".repeat(201), "", good.startsAt(), good.endsAt(), null),
                new ScheduleService.Input("x", "x".repeat(2001), good.startsAt(), good.endsAt(), null),
                new ScheduleService.Input("x", "", good.startsAt(), good.startsAt().plusDays(1), null),
                new ScheduleService.Input("x", "", good.startsAt(), LocalDateTime.now(ScheduleService.SEOUL).minusDays(1), null));
        for (var body : bodies) mvc.perform(post("/api/schedules").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(body))).andExpect(status().isBadRequest());
        UUID id = schedules.create(good);
        mvc.perform(put("/api/schedules/" + id).with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(input(null)))).andExpect(status().isConflict());
        schedules.update(id, input(1L));
        conflict(() -> schedules.update(id, input(1L)));
    }

    @Test void concurrentReplicasOnlySendOnceAndPersistHistory() throws Exception {
        UUID id = due();
        var other = new NotificationWorker(db, discord, manager, false, 60);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<?>> results = new ArrayList<>();
            for (NotificationWorker replica : List.of(worker, other)) results.add(pool.submit(() -> {
                try { assertTrue(start.await(5, TimeUnit.SECONDS)); }
                catch (InterruptedException e) { throw new AssertionError(e); }
                var claim = replica.claimNext();
                if (claim != null) replica.send(claim);
            }));
            start.countDown();
            for (Future<?> result : results) result.get(10, TimeUnit.SECONDS);
        } finally { pool.shutdownNow(); }
        verify(discord, times(1)).send(eq(id), anyString(), any(), any());
        assertEquals("SENT", notificationStatus(id));
        assertEquals(1, db.queryForObject("SELECT attempt_count FROM notifications WHERE id=?", Integer.class, id));
        var history = json.readTree(mvc.perform(get("/api/notifications")).andReturn().getResponse().getContentAsString()).get(0);
        assertNotNull(Instant.parse(history.path("due_at").asText()));
        assertEquals("123456789", history.path("attempts").get(0).path("message_id").asText());
        assertNotNull(Instant.parse(history.path("attempts").get(0).path("finished_at").asText()));
    }

    @Test void restartRecoveryAndManualRetryFenceOldSender() throws Exception {
        UUID id = due();
        var old = worker.claimNext();
        assertEquals("SENDING", notificationStatus(id));
        expire(id);
        var restarted = new NotificationWorker(db, discord, manager, false, 60);
        assertEquals(1, restarted.recoverExpired());
        assertEquals("UNKNOWN", notificationStatus(id));
        assertNull(worker.claimNext());
        worker.send(old);
        verifyNoInteractions(discord);
        mvc.perform(post("/api/notifications/" + id + "/resolve").with(csrf()).contentType("application/json")
                .content("{\"retry\":true,\"acceptDuplicateRisk\":false}")).andExpect(status().isConflict());
        mvc.perform(post("/api/notifications/" + id + "/resolve").with(csrf()).contentType("application/json")
                .content("{\"retry\":true,\"acceptDuplicateRisk\":true}")).andExpect(status().isOk());
        var fresh = worker.claimNext();
        assertNotEquals(old.attemptId(), fresh.attemptId());
        worker.send(old); // Even a new SENDING state cannot revive an old claim token.
        verifyNoInteractions(discord);
        worker.send(fresh);
        assertEquals("SENT", notificationStatus(id));
        verify(discord, times(1)).send(eq(id), anyString(), any(), any());
    }

    @Test void expiredSenderDoesNotSendEvenBeforeRecoveryRuns() {
        UUID id = due();
        var claim = worker.claimNext();
        expire(id);
        worker.send(claim);
        assertEquals("UNKNOWN", notificationStatus(id));
        verifyNoInteractions(discord);
    }

    @Test void unknownAndSendingBlockChangesUntilClosedWithoutRetry() {
        UUID schedule = schedules.create(input(null));
        UUID id = notification(schedule);
        db.update("UPDATE notifications SET next_attempt_at=now() WHERE id=?", id);
        worker.claimNext();
        conflict(() -> schedules.update(schedule, input(1L)));
        conflict(() -> schedules.delete(schedule, 1));
        expire(id);
        worker.recoverExpired();
        conflict(() -> schedules.update(schedule, input(1L)));
        conflict(() -> schedules.delete(schedule, 1));
        schedules.resolve(id, false, false);
        assertEquals("CANCELLED", notificationStatus(id));
        schedules.delete(schedule, 1);
        assertNull(worker.claimNext());
        verifyNoInteractions(discord);
    }

    @Test void rateLimitReschedulesButUncertainDeliveryDoesNot() {
        UUID id = due();
        when(discord.send(any(), anyString(), any(), any())).thenReturn(new DiscordClient.Delivery("PENDING", 429, null, 2500L, "Rate limited"));
        worker.send(worker.claimNext());
        assertEquals("PENDING", notificationStatus(id));
        assertTrue(db.queryForObject("SELECT next_attempt_at>now() FROM notifications WHERE id=?", Boolean.class, id));
        assertNull(worker.claimNext());
        assertEquals("RATE_LIMITED", db.queryForObject("SELECT status FROM notification_attempts WHERE notification_id=?", String.class, id));
        db.update("UPDATE notifications SET next_attempt_at=now() WHERE id=?", id);
        when(discord.send(any(), anyString(), any(), any())).thenReturn(DiscordClient.Delivery.unknown(503));
        worker.send(worker.claimNext());
        assertEquals("UNKNOWN", notificationStatus(id));
        assertNull(worker.claimNext());
    }

    @Test void failedDeliveryCanBeRetriedOrCancelledByScheduleUpdate() {
        UUID id = due();
        when(discord.send(any(), anyString(), any(), any())).thenReturn(new DiscordClient.Delivery("FAILED", 400, null, null, "Rejected"));
        worker.send(worker.claimNext());
        assertEquals("FAILED", notificationStatus(id));
        schedules.resolve(id, true, false);
        assertEquals("PENDING", notificationStatus(id));
        UUID schedule = db.queryForObject("SELECT schedule_id FROM notifications WHERE id=?", UUID.class, id);
        schedules.update(schedule, input(1L));
        assertEquals("CANCELLED", notificationStatus(id));
        assertNull(worker.claimNext());
    }

    @Test void recoverySkipsTheRowHeldDuringAnActiveHttpRequest() throws Exception {
        UUID id = due();
        var claim = worker.claimNext();
        db.update("UPDATE notifications SET claimed_at=now()-interval '40 seconds' WHERE id=?", id);
        var recoveringReplica = new NotificationWorker(db, discord, manager, false, 30);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(discord.send(any(), anyString(), any(), any())).thenAnswer(invocation -> {
            entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return new DiscordClient.Delivery("SENT", 200, "123", null, "Confirmed");
        });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> result = pool.submit(() -> worker.send(claim));
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            assertEquals(0, recoveringReplica.recoverExpired());
            release.countDown();
            result.get(5, TimeUnit.SECONDS);
        } finally { release.countDown(); pool.shutdownNow(); }
        assertEquals("SENT", notificationStatus(id));
    }

    @Test void resultWriteFailureLeavesDurableClaimForRecovery() {
        UUID id = due();
        var claim = worker.claimNext();
        db.execute("""
                CREATE FUNCTION reject_sent() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.status='SENT' THEN RAISE EXCEPTION 'test result failure'; END IF; RETURN NEW; END $$
                """);
        db.execute("CREATE TRIGGER reject_sent BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION reject_sent()");
        try { assertThrows(RuntimeException.class, () -> worker.send(claim)); }
        finally {
            db.execute("DROP TRIGGER reject_sent ON notifications");
            db.execute("DROP FUNCTION reject_sent()");
        }
        verify(discord, times(1)).send(eq(id), anyString(), any(), any());
        assertEquals("SENDING", notificationStatus(id));
        assertEquals("SENDING", db.queryForObject("SELECT status FROM notification_attempts WHERE id=?", String.class, claim.attemptId()));
        expire(id);
        worker.recoverExpired();
        assertEquals("UNKNOWN", notificationStatus(id));
        assertNull(worker.claimNext());
    }
}

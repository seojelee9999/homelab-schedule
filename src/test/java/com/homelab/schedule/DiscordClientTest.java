package com.homelab.schedule;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DiscordClientTest {
    private final ObjectMapper json = new ObjectMapper();
    private final UUID id = UUID.randomUUID();
    private final URI endpoint = DiscordClient.endpoint("https://discord.com/api/webhooks/123/test-token");

    private DiscordClient.Delivery response(int code, String body, String header) {
        return new DiscordClient(json, endpoint, (uri, payload) -> new DiscordClient.Reply(code, body, header))
                .send(id, "알림", Instant.parse("2030-01-01T03:00:00Z"));
    }

    @Test void confirmedDeliveryIncludesCorrelationIdSeoulTimeAndNoMentions() {
        var client = new DiscordClient(json, endpoint, (uri, payload) -> {
            assertEquals("wait=true", uri.getQuery());
            var body = json.readTree(payload);
            assertTrue(body.path("allowed_mentions").path("parse").isArray());
            assertEquals(0, body.path("allowed_mentions").path("parse").size());
            assertTrue(body.path("content").asText().contains(id.toString()));
            assertTrue(body.path("content").asText().contains("2030-01-01 12:00 (Asia/Seoul)"));
            return new DiscordClient.Reply(200, "{\"id\":\"1234567890\"}", null);
        });
        var result = client.send(id, "@everyone 한글 일정", Instant.parse("2030-01-01T03:00:00Z"));
        assertEquals("SENT", result.status());
        assertEquals("1234567890", result.messageId());
    }

    @Test void rateLimitUsesSecondsIncludingFractionsAndHeaderFallback() {
        assertEquals(1250L, response(429, "{\"retry_after\":1.25}", null).retryMillis());
        assertEquals("PENDING", response(429, "{\"retry_after\":0}", null).status());
        assertEquals(1000L, response(429, "{\"retry_after\":0}", null).retryMillis());
        assertEquals(2500L, response(429, "not json", "2.5").retryMillis());
        assertEquals("FAILED", response(429, "{\"retry_after\":-1}", "NaN").status());
        assertNull(response(429, "{}", "Infinity").retryMillis());
    }

    @Test void ambiguousResponsesNeverAutomaticallyRetry() {
        for (int code : new int[]{200, 204, 302, 408, 500, 502, 503}) {
            var result = response(code, "{}", null);
            assertEquals("UNKNOWN", result.status(), "status " + code);
            assertNull(result.retryMillis());
        }
        assertEquals("UNKNOWN", response(200, "not json", null).status());
        assertEquals("UNKNOWN", response(200, "null", null).status());
        assertEquals("UNKNOWN", response(200, "{\"id\":\"invalid\"}", null).status());
    }

    @Test void explicitRejectionsRequireManualRetry() {
        for (int code : new int[]{400, 401, 403, 404}) {
            var result = response(code, "sensitive response body", null);
            assertEquals("FAILED", result.status());
            assertNull(result.retryMillis());
            assertFalse(result.detail().contains("sensitive"));
        }
    }

    @Test void transportFailureDoesNotExposeSecrets() {
        var client = new DiscordClient(json, endpoint, (uri, payload) -> { throw new IOException(uri.toString()); });
        var result = client.send(id, "알림", Instant.now());
        assertEquals("UNKNOWN", result.status());
        assertFalse(result.toString().contains("test-token"));
    }

    @Test void interruptionIsPreservedAndDoesNotRetry() {
        var client = new DiscordClient(json, endpoint, (uri, payload) -> { throw new InterruptedException(); });
        try {
            assertEquals("UNKNOWN", client.send(id, "알림", Instant.now()).status());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally { Thread.interrupted(); }
    }

    @Test void invalidEndpointErrorsNeverContainTheInput() {
        for (String url : new String[]{"http://discord.com/api/webhooks/123/secret",
                "https://evil.test/api/webhooks/123/secret", "https://discord.com/api/webhooks/123/secret?wait=false",
                "https://discord.com:444/api/webhooks/123/secret", "https://secret@discord.com/api/webhooks/123/secret",
                "https://discord.com/api/webhooks/123/secret#fragment", "invalid secret"}) {
            var error = assertThrows(IllegalArgumentException.class, () -> DiscordClient.endpoint(url));
            assertFalse(error.getMessage().contains("secret"));
            assertNull(error.getCause());
        }
    }
}

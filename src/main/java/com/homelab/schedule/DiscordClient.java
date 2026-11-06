package com.homelab.schedule;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class DiscordClient {
    record Reply(int status, String body, String retryAfter) {}
    @FunctionalInterface
    interface Transport { Reply post(URI uri, String body) throws IOException, InterruptedException; }
    public record Delivery(String status, Integer httpStatus, String messageId, Long retryMillis, String detail) {
        static Delivery unknown(Integer code) {
            return new Delivery("UNKNOWN", code, null, null, "Delivery could not be confirmed");
        }
    }

    private final ObjectMapper json;
    private final URI endpoint;
    private final Transport transport;

    @Autowired
    public DiscordClient(ObjectMapper json, @Value("${schedule.discord-webhook-url}") String webhook,
                         @Value("${schedule.worker-enabled}") boolean enabled) {
        this(json, enabled ? endpoint(webhook) : null, new HttpTransport());
    }

    // Package-private transport injection keeps tests independent of Discord and credentials.
    DiscordClient(ObjectMapper json, URI endpoint, Transport transport) {
        this.json = json;
        this.endpoint = endpoint;
        this.transport = transport;
    }

    static URI endpoint(String webhook) {
        // Do not attach the input or original exception: the path contains a secret.
        try {
            URI uri = URI.create(webhook);
            if (!"https".equals(uri.getScheme()) || !"discord.com".equals(uri.getHost())
                    || uri.getUserInfo() != null || uri.getPort() != -1 || uri.getFragment() != null
                    || uri.getQuery() != null
                    || !uri.getPath().matches("/api(?:/v[0-9]+)?/webhooks/[0-9]+/[A-Za-z0-9_-]+")) {
                throw new IllegalArgumentException();
            }
            return URI.create(webhook + "?wait=true");
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Configure a valid Discord HTTPS incoming webhook URL");
        }
    }

    public Delivery send(UUID notificationId, String title, Instant startsAt) {
        if (endpoint == null) return new Delivery("FAILED", null, null, null, "Webhook is disabled");
        Integer code = null;
        try {
            String when = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm '(Asia/Seoul)'")
                    .withZone(ScheduleService.SEOUL).format(startsAt);
            String content = "일정 알림 · " + title + "\n시작 · " + when + "\n알림 ID · " + notificationId;
            String body = json.writeValueAsString(Map.of("content", content,
                    "allowed_mentions", Map.of("parse", List.of())));
            Reply reply = transport.post(endpoint, body);
            code = reply.status();
            if (code >= 200 && code < 300) {
                String id = json.readTree(reply.body()).path("id").asText("");
                if (id.matches("[0-9]{1,32}")) return new Delivery("SENT", code, id, null, "Confirmed by Discord");
                return Delivery.unknown(code);
            }
            if (code == 429) {
                Long delay = null;
                try { delay = retryMillis(json.readTree(reply.body()).path("retry_after").asText()); }
                catch (IOException | RuntimeException ignored) { /* Try the documented header. */ }
                if (delay == null) delay = retryMillis(reply.retryAfter());
                if (delay != null) return new Delivery("PENDING", code, null, delay, "Rate limited by Discord");
                return new Delivery("FAILED", code, null, null, "Rate limit without a valid retry delay");
            }
            // A request timeout may have occurred after the remote side accepted the message.
            if (code >= 400 && code < 500 && code != 408) {
                return new Delivery("FAILED", code, null, null, "Discord rejected the request");
            }
            return Delivery.unknown(code);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Delivery.unknown(code);
        } catch (IOException | RuntimeException e) {
            // Never persist/log a response body, webhook URI, or transport exception.
            return Delivery.unknown(code);
        }
    }

    private static Long retryMillis(String seconds) {
        if (seconds == null) return null;
        try {
            double value = Double.parseDouble(seconds);
            // Reject unreasonable values instead of retrying earlier than Discord requested.
            if (!Double.isFinite(value) || value < 0 || value > 31_536_000) return null;
            return Math.max(1000L, (long) Math.ceil(value * 1000));
        } catch (NumberFormatException e) { return null; }
    }

    private static final class HttpTransport implements Transport {
        private HttpClient client;
        private synchronized HttpClient client() {
            if (client == null) client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                    .followRedirects(HttpClient.Redirect.NEVER).build();
            return client;
        }
        public Reply post(URI uri, String body) throws IOException, InterruptedException {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> response = client().send(request, HttpResponse.BodyHandlers.ofString());
            return new Reply(response.statusCode(), response.body(), response.headers().firstValue("Retry-After").orElse(null));
        }
    }
}

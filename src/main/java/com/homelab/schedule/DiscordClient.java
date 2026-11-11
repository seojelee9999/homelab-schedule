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
    interface Transport {
        Reply post(URI uri, String body) throws IOException, InterruptedException;
        default Reply postFile(URI uri, String payload, String text) throws IOException, InterruptedException {
            throw new IOException("Attachments are not supported by this transport");
        }
    }
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

    static String timeRange(Instant start, Instant end) {
        var format = DateTimeFormatter.ofPattern("HH:mm").withZone(ScheduleService.SEOUL);
        String finish = end.atZone(ScheduleService.SEOUL).toLocalDate().isAfter(start.atZone(ScheduleService.SEOUL).toLocalDate())
                && end.atZone(ScheduleService.SEOUL).toLocalTime().equals(LocalTime.MIDNIGHT) ? "24:00" : format.format(end);
        return format.format(start) + "–" + finish;
    }

    public Delivery send(UUID notificationId, String title, Instant startsAt) {
        return send(notificationId, title, startsAt, null);
    }

    public Delivery send(UUID notificationId, String title, Instant startsAt, Instant endsAt) {
        String when = DateTimeFormatter.ofPattern("yyyy년 M월 d일 (EEE)", Locale.KOREAN)
                .withZone(ScheduleService.SEOUL).format(startsAt);
        String time = endsAt == null ? DateTimeFormatter.ofPattern("HH:mm").withZone(ScheduleService.SEOUL).format(startsAt)
                : timeRange(startsAt, endsAt);
        Map<String,Object> embed = Map.of(
                "author", Map.of("name", "차곡 · 일정 알림"),
                "title", time + " · " + title,
                "color", 0x175d50,
                "fields", List.of(
                        Map.of("name", "날짜", "value", when, "inline", true),
                        Map.of("name", endsAt == null ? "시작 시간" : "일정 시간", "value", time + " · 서울 (KST)", "inline", true),
                        Map.of("name", "시작까지", "value", "<t:" + startsAt.getEpochSecond() + ":R>", "inline", false)),
                "footer", Map.of("text", "Asia/Seoul · 알림 ID " + notificationId));
        return deliver(Map.of("embeds", List.of(embed), "allowed_mentions", Map.of("parse", List.of())), null);
    }

    public Delivery sendDigest(UUID notificationId, String title, String text) {
        // Long days (including existing data and notes) remain complete in a UTF-8 attachment.
        boolean attach = text.length() > 3500;
        Map<String,Object> embed = Map.of("title", title, "color", 0x175d50,
                "description", attach ? "오늘의 전체 시간표는 첨부 파일에서 확인하세요." : text,
                "footer", Map.of("text", "매일 오전 6시 · Asia/Seoul · 알림 ID " + notificationId));
        Map<String,Object> payload = new HashMap<>(Map.of("embeds", List.of(embed), "allowed_mentions", Map.of("parse", List.of())));
        if (attach) payload.put("attachments", List.of(Map.of("id", 0, "filename", "daily-schedule.txt")));
        return deliver(payload, attach ? title + "\n\n" + text : null);
    }

    private Delivery deliver(Map<String,Object> payload, String attachment) {
        if (endpoint == null) return new Delivery("FAILED", null, null, null, "Webhook is disabled");
        Integer code = null;
        try {
            String body = json.writeValueAsString(payload);
            Reply reply = attachment == null ? transport.post(endpoint, body) : transport.postFile(endpoint, body, attachment);
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
            return postBody(uri, "application/json", body);
        }
        public Reply postFile(URI uri, String payload, String text) throws IOException, InterruptedException {
            String boundary = "schedule-" + UUID.randomUUID();
            String body = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n"
                    + payload + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"daily-schedule.txt\"\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n"
                    + text + "\r\n--" + boundary + "--\r\n";
            return postBody(uri, "multipart/form-data; boundary=" + boundary, body);
        }
        private Reply postBody(URI uri, String contentType, String body) throws IOException, InterruptedException {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(8))
                    .header("Content-Type", contentType)
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> response = client().send(request, HttpResponse.BodyHandlers.ofString());
            return new Reply(response.statusCode(), response.body(), response.headers().firstValue("Retry-After").orElse(null));
        }
    }
}

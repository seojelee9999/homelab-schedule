package com.homelab.schedule;
import java.time.*;
import java.sql.Timestamp;
import java.util.*;
import jakarta.validation.constraints.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.springframework.http.HttpStatus.*;
@Service
public class ScheduleService {
 static final ZoneId SEOUL=ZoneId.of("Asia/Seoul");
 final JdbcTemplate db;
 public ScheduleService(JdbcTemplate db) { this.db=db; }
 public record Input(@NotBlank @Size(max=200) String title,@NotNull @Size(max=2000) String description,
  @NotNull LocalDateTime startsAt,@NotNull LocalDateTime remindAt,Long version) {}
 static ResponseStatusException conflict(String s) { return new ResponseStatusException(CONFLICT,s); }
 void validate(Input in) {
  if(in.remindAt().isAfter(in.startsAt())) throw new ResponseStatusException(BAD_REQUEST,"알림은 일정 시작 이전이어야 합니다.");
  if(!in.remindAt().atZone(SEOUL).toInstant().isAfter(Instant.now())) throw new ResponseStatusException(BAD_REQUEST,"알림은 현재 이후로 지정하세요.");
 }
 public List<Map<String,Object>> list() {
  return timestamps(db.queryForList("SELECT s.*,n.id notification_id,n.status notification_status FROM schedules s JOIN notifications n ON n.schedule_id=s.id AND n.revision=s.version WHERE s.deleted_at IS NULL ORDER BY starts_at LIMIT 500"));
 }
 // JdbcTemplate returns java.sql.Timestamp; always expose ISO instants, never numeric epochs.
 static List<Map<String,Object>> timestamps(List<Map<String,Object>> rows) {
  rows.forEach(row -> row.replaceAll((key,value) -> value instanceof Timestamp t ? t.toInstant().toString() : value));
  return rows;
 }
 @Transactional public UUID create(Input in) {
  validate(in); UUID id=UUID.randomUUID();
  db.update("INSERT INTO schedules(id,title,description,starts_at,remind_at) VALUES(?,?,?,?,?)",id,in.title().strip(),in.description(),in.startsAt().atZone(SEOUL).toOffsetDateTime(),in.remindAt().atZone(SEOUL).toOffsetDateTime());
  enqueue(id); return id;
 }
 void lock(UUID id,Long version) {
  var rows=db.queryForList("SELECT version FROM schedules WHERE id=? AND deleted_at IS NULL FOR UPDATE",id);
  if(rows.isEmpty()) throw new ResponseStatusException(NOT_FOUND,"일정이 없습니다.");
  if(version==null || ((Number)rows.get(0).get("version")).longValue()!=version) throw conflict("다른 변경이 있습니다. 새로고침하세요.");
  var jobs=db.queryForList("SELECT status FROM notifications WHERE schedule_id=? FOR UPDATE",id);
  if(jobs.stream().anyMatch(j -> Set.of("SENDING","UNKNOWN").contains(j.get("status")))) throw conflict("전송 중이거나 불명확한 알림을 먼저 확인하세요.");
 }
 @Transactional public void update(UUID id,Input in) {
  validate(in); lock(id,in.version()); cancel(id);
  db.update("UPDATE schedules SET title=?,description=?,starts_at=?,remind_at=?,version=version+1 WHERE id=?",in.title().strip(),in.description(),in.startsAt().atZone(SEOUL).toOffsetDateTime(),in.remindAt().atZone(SEOUL).toOffsetDateTime(),id);
  enqueue(id);
 }
 @Transactional public void delete(UUID id,long version) {
  lock(id,version); cancel(id);
  db.update("UPDATE schedules SET deleted_at=now(),version=version+1 WHERE id=?",id);
 }
 void cancel(UUID id) { db.update("UPDATE notifications SET status='CANCELLED' WHERE schedule_id=? AND status IN ('PENDING','FAILED')",id); }
 void enqueue(UUID id) {
  db.update("INSERT INTO notifications(id,schedule_id,revision,title,starts_at,due_at,status,next_attempt_at) SELECT ?,id,version,title,starts_at,remind_at,'PENDING',remind_at FROM schedules WHERE id=?",UUID.randomUUID(),id);
 }
 public List<Map<String,Object>> history() {
  var jobs=timestamps(db.queryForList("SELECT * FROM notifications ORDER BY due_at DESC,id LIMIT 500"));
  Map<Object,List<Map<String,Object>>> attempts=new HashMap<>();
  for(var row:timestamps(db.queryForList("SELECT * FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications ORDER BY due_at DESC,id LIMIT 500) ORDER BY started_at,id"))) {
   attempts.computeIfAbsent(row.get("notification_id"),key -> new ArrayList<>()).add(row);
  }
  for(var job:jobs) job.put("attempts",attempts.getOrDefault(job.get("id"),List.of()));
  return jobs;
 }
 @Transactional public void resolve(UUID id,boolean retry,boolean acceptDuplicateRisk) {
  var rows=db.queryForList("SELECT status FROM notifications WHERE id=? FOR UPDATE",id);
  if(rows.isEmpty()) throw new ResponseStatusException(NOT_FOUND);
  String status=(String)rows.get(0).get("status");
  if(!Set.of("UNKNOWN","FAILED").contains(status)) throw conflict("확인이 필요한 알림만 처리할 수 있습니다.");
  if(retry && status.equals("UNKNOWN") && !acceptDuplicateRisk) throw conflict("Discord 확인 후 중복 가능성을 승인해야 합니다.");
  db.update("INSERT INTO notification_attempts(id,notification_id,status,finished_at,detail,manual_retry) VALUES(?,?,?,now(),?,?)",UUID.randomUUID(),id,"RESOLVED",retry?"Operator requested retry":"Operator closed without retry",retry);
  db.update("UPDATE notifications SET status=?,next_attempt_at=now(),active_attempt=NULL,claimed_at=NULL WHERE id=?",retry?"PENDING":"CANCELLED",id);
 }
}

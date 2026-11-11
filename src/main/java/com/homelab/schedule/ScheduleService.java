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
  @NotNull LocalDateTime startsAt,@NotNull LocalDateTime endsAt,Long version) {}
 static ResponseStatusException conflict(String s) { return new ResponseStatusException(CONFLICT,s); }
 void validate(Input in) {
  if(!in.endsAt().isAfter(in.startsAt()) || in.endsAt().isAfter(in.startsAt().toLocalDate().plusDays(1).atStartOfDay()))
   throw new ResponseStatusException(BAD_REQUEST,"종료 시간은 시작 이후부터 같은 날 24시까지여야 합니다.");
 }
 public List<Map<String,Object>> list() {
  return timestamps(db.queryForList("SELECT s.*,n.id notification_id,n.status notification_status FROM schedules s JOIN notifications n ON n.schedule_id=s.id AND n.revision=s.version WHERE s.deleted_at IS NULL ORDER BY starts_at LIMIT 500"));
 }
 public List<Map<String,Object>> list(LocalDate from,LocalDate to) {
  if(from==null && to==null) return list();
  if(from==null || to==null || !to.isAfter(from) || to.isAfter(from.plusDays(62)))
   throw new ResponseStatusException(BAD_REQUEST,"조회 기간은 시작일 포함, 종료일 제외로 최대 62일입니다.");
  return timestamps(db.queryForList("SELECT s.*,n.id notification_id,n.status notification_status FROM schedules s JOIN notifications n ON n.schedule_id=s.id AND n.revision=s.version WHERE s.deleted_at IS NULL AND s.starts_at>=? AND s.starts_at<? ORDER BY s.starts_at,s.id",
   from.atStartOfDay(SEOUL).toOffsetDateTime(),to.atStartOfDay(SEOUL).toOffsetDateTime()));
 }
 @Transactional public List<UUID> createBatch(List<Input> items) {
  if(items==null || items.isEmpty() || items.size()>48)
   throw new ResponseStatusException(BAD_REQUEST,"시간표는 1~48개의 일정으로 작성하세요.");
  LocalDate day=items.get(0).startsAt().toLocalDate();
  for(Input in:items) {
   validate(in);
   if(!in.startsAt().toLocalDate().equals(day)) throw new ResponseStatusException(BAD_REQUEST,"시간표의 날짜는 모두 같아야 합니다.");
  }
  return items.stream().map(this::create).toList();
 }
 // JdbcTemplate returns java.sql.Timestamp; always expose ISO instants, never numeric epochs.
 static List<Map<String,Object>> timestamps(List<Map<String,Object>> rows) {
  rows.forEach(row -> row.replaceAll((key,value) -> value instanceof Timestamp t ? t.toInstant().toString() : value));
  return rows;
 }
 @Transactional public UUID create(Input in) {
  serializeWrites(); validate(in); UUID id=UUID.randomUUID();
  db.update("INSERT INTO schedules(id,title,description,starts_at,ends_at,remind_at) VALUES(?,?,?,?,?,?)",id,in.title().strip(),in.description(),in.startsAt().atZone(SEOUL).toOffsetDateTime(),in.endsAt().atZone(SEOUL).toOffsetDateTime(),in.startsAt().minusMinutes(10).atZone(SEOUL).toOffsetDateTime());
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
  serializeWrites(); validate(in); lock(id,in.version()); cancel(id);
  db.update("UPDATE schedules SET title=?,description=?,starts_at=?,ends_at=?,remind_at=?,version=version+1 WHERE id=?",in.title().strip(),in.description(),in.startsAt().atZone(SEOUL).toOffsetDateTime(),in.endsAt().atZone(SEOUL).toOffsetDateTime(),in.startsAt().minusMinutes(10).atZone(SEOUL).toOffsetDateTime(),id);
  enqueue(id);
 }
 @Transactional public void delete(UUID id,long version) {
  serializeWrites(); lock(id,version); cancel(id);
  db.update("UPDATE schedules SET deleted_at=now(),version=version+1 WHERE id=?",id);
 }
 void cancel(UUID id) { db.update("UPDATE notifications SET status='CANCELLED' WHERE schedule_id=? AND status IN ('PENDING','FAILED')",id); }
 void enqueue(UUID id) {
  db.update("INSERT INTO notifications(id,schedule_id,revision,title,starts_at,ends_at,due_at,status,next_attempt_at) SELECT ?,id,version,title,starts_at,ends_at,remind_at,CASE WHEN remind_at>now() THEN 'PENDING' ELSE 'CANCELLED' END,remind_at FROM schedules WHERE id=?",UUID.randomUUID(),id);
 }
 // Serialize schedule mutations so a whole-day edit can detect concurrent additions as well as edits.
 void serializeWrites() { db.queryForList("SELECT pg_advisory_xact_lock(74133)"); }
 public record DayItem(UUID id,@NotNull @jakarta.validation.Valid Input schedule) {}
 public record DayPlan(@NotNull LocalDate date,@NotNull Map<UUID,Long> versions,
  @NotNull @Size(max=48) List<@NotNull @jakarta.validation.Valid DayItem> items) {}
 @Transactional public void saveDay(DayPlan plan) {
  serializeWrites();
  var current=list(plan.date(),plan.date().plusDays(1));
  Map<UUID,Long> versions=new HashMap<>();
  Map<UUID,Map<String,Object>> originals=new HashMap<>();
  for(var row:current) {
   UUID id=(UUID)row.get("id");
   versions.put(id,((Number)row.get("version")).longValue()); originals.put(id,row);
  }
  if(!versions.equals(plan.versions())) throw conflict("이 날짜의 일정이 변경되었습니다. 작성표를 다시 불러오세요.");
  Set<UUID> kept=new HashSet<>();
  LocalDateTime previousEnd=null;
  var sorted=plan.items().stream().sorted(Comparator.comparing(item -> item.schedule().startsAt())).toList();
  for(DayItem item:sorted) {
   Input in=item.schedule(); validate(in);
   if(!in.startsAt().toLocalDate().equals(plan.date()) || (previousEnd!=null && in.startsAt().isBefore(previousEnd)))
    throw new ResponseStatusException(BAD_REQUEST,"같은 날짜의 겹치지 않는 시간칸으로 작성하세요.");
   previousEnd=in.endsAt();
   if(item.id()!=null && (!versions.containsKey(item.id()) || !kept.add(item.id()) || !Objects.equals(in.version(),versions.get(item.id()))))
    throw conflict("일정 버전을 확인하고 작성표를 다시 불러오세요.");
  }
  for(var entry:versions.entrySet()) if(!kept.contains(entry.getKey())) delete(entry.getKey(),entry.getValue());
  for(DayItem item:sorted) {
   Input in=item.schedule();
   if(item.id()==null) { create(in); continue; }
   var old=originals.get(item.id());
   boolean unchanged=Objects.equals(old.get("title"),in.title().strip()) && Objects.equals(old.get("description"),in.description())
    && Objects.equals(old.get("starts_at"),in.startsAt().atZone(SEOUL).toInstant().toString())
    && Objects.equals(old.get("ends_at"),in.endsAt().atZone(SEOUL).toInstant().toString());
   if(!unchanged) update(item.id(),in);
  }
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

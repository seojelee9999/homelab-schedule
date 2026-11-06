package com.homelab.schedule;
import java.util.*;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.web.csrf.CsrfToken;
@RestController
@RequestMapping("/api")
class ScheduleController {
 final ScheduleService service;
 ScheduleController(ScheduleService service) { this.service=service; }
 @GetMapping("/csrf") CsrfToken csrf(CsrfToken token) { return token; }
 @GetMapping("/schedules") Object list() { return service.list(); }
 @PostMapping("/schedules") @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
 Object create(@Valid @RequestBody ScheduleService.Input in) { return Map.of("id",service.create(in)); }
 @PutMapping("/schedules/{id}") void update(@PathVariable UUID id,@Valid @RequestBody ScheduleService.Input in) { service.update(id,in); }
 @DeleteMapping("/schedules/{id}") void delete(@PathVariable UUID id,@RequestParam long version) { service.delete(id,version); }
 @GetMapping("/notifications") Object history() { return service.history(); }
 record Resolution(boolean retry,boolean acceptDuplicateRisk) {}
 @PostMapping("/notifications/{id}/resolve") void resolve(@PathVariable UUID id,@RequestBody Resolution in) { service.resolve(id,in.retry(),in.acceptDuplicateRisk()); }
 @ExceptionHandler(org.springframework.web.server.ResponseStatusException.class)
 org.springframework.http.ResponseEntity<?> failure(org.springframework.web.server.ResponseStatusException e) {
  return org.springframework.http.ResponseEntity.status(e.getStatusCode()).body(Map.of("message",e.getReason()==null?"요청을 처리할 수 없습니다.":e.getReason()));
 }
}

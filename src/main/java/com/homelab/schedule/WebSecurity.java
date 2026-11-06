package com.homelab.schedule;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
@Configuration
class WebSecurity {
 @Bean SecurityFilterChain security(HttpSecurity http) throws Exception {
  return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
    .formLogin(f -> f.disable()).httpBasic(b -> b.disable()).build();
 }
}

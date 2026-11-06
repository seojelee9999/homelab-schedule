FROM gradle:8.14.3-jdk17 AS build
WORKDIR /app
COPY build.gradle settings.gradle ./
COPY src ./src
RUN gradle --no-daemon bootJar
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/build/libs/schedule-1.0.0.jar app.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]

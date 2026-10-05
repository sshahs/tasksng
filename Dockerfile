# syntax=docker/dockerfile:1
# TasksNG web version: the TasksNG UI plus tasksng-server, which syncs with
# Baikal for each signed-in account. See "Self-hosting with Docker" in the
# README.

FROM node:22-trixie-slim AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json components.json ./
COPY public public
COPY src src
RUN npm run build

FROM rust:1-trixie AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# A workspace member; cargo reads its manifest but only builds the server.
COPY src-tauri src-tauri
# Thin LTO builds much faster than the desktop app's fat LTO, for the same
# result here.
ENV CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p tasks-server \
    && cp target/release/tasksng-server /usr/local/bin/

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin tasksng \
    && mkdir -p /data /certs \
    && chown tasksng:tasksng /data
COPY --from=server /usr/local/bin/tasksng-server /usr/local/bin/tasksng-server
COPY --from=ui /src/dist /app/dist
COPY docker/entrypoint.sh /usr/local/bin/tasksng-entrypoint
ENV TASKSNG_LISTEN=0.0.0.0:8080 \
    TASKSNG_DATA_DIR=/data \
    TASKSNG_STATIC_DIR=/app/dist
USER tasksng
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s CMD ["tasksng-server", "healthcheck"]
ENTRYPOINT ["tasksng-entrypoint"]

LABEL org.opencontainers.image.title="TasksNG" \
      org.opencontainers.image.description="Keyboard-friendly task manager for Baikal and other CalDAV servers (web version)" \
      org.opencontainers.image.source="https://github.com/sshahs/tasksng"

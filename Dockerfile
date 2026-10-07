# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS models
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl unzip \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /web
COPY web/scripts/fetch-models.sh scripts/
RUN sh scripts/fetch-models.sh

FROM node:24-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
COPY --from=models /web/static/models static/models
RUN npm run build

FROM rust:1.99-trixie AS server
WORKDIR /server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/server/target \
	cargo build --release --locked \
	&& cp target/release/speech-to-qso-server /usr/local/bin/ \
	&& mkdir /data

FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=server /usr/local/bin/speech-to-qso-server /usr/local/bin/
COPY --from=web /web/build /app/web
COPY --from=server --chown=65532:65532 /data /data
ENV LISTEN=0.0.0.0:8080 \
	WEB_DIR=/app/web \
	DATABASE_PATH=/data/speech-to-qso.db
WORKDIR /data
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGINT
ENTRYPOINT ["speech-to-qso-server"]
CMD ["serve"]

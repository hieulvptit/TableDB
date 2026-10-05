# syntax=docker/dockerfile:1
# Build context: services/api   (docker build -t tabledb-api services/api)
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# static binary: no CGO, stripped; migrations are embedded (go:embed), nothing else to copy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/tabledb-api ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tabledb-api /tabledb-api
ENV APP_ENV=prod HOST=0.0.0.0 PORT=8080 STORAGE_DIR=/var/lib/tabledb/files LOG_DIR=/var/lib/tabledb/logs
# Prod needs DATABASE_URL (the embedded PostgreSQL used for dev/test is not available in this image) — see README.
VOLUME ["/var/lib/tabledb/files"]
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/tabledb-api"]

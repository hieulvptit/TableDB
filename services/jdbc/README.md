# TableDB JDBC sidecar / service

Single JAR (`tabledb-jdbc.jar`, Java 21; one shaded runtime dependency: JSch `com.github.mwiede:jsch` for SSH tunnels, no transitive deps) speaking `docs/SIDECAR-PROTOCOL.md` over
`--stdio` (NDJSON, desktop sidecar) or `--http` (`POST /rpc`, `GET /events` long-poll, Bearer token).

## Build / test / run

```sh
mvn -q test                      # unit + stdio/http end-to-end tests (JDK 21)
mvn -q package                   # target/tabledb-jdbc.jar (shaded, Main-Class set)
scripts/fetch-drivers.sh         # -> target/drivers/{manifest.json, postgresql, trino-jdbc, ojdbc11 jars}
mvn -q -Pdrivers package         # same, as part of package
java -jar target/tabledb-jdbc.jar --stdio
JDBC_SERVICE_TOKEN=... java -jar target/tabledb-jdbc.jar --http --bind 127.0.0.1 --port 8788 [--tls-keystore x.p12]
```

Driver versions are pinned in one place: the top of `scripts/fetch-drivers.sh`. The script verifies each download
against Maven Central's `.sha1`, computes SHA-256 locally and writes `manifest.json`
(`{"drivers":[{type,file,sha256,version,class}]}`; a bare array is also accepted). Drivers are loaded **only** from
`drivers/` next to the jar (or next to `classes/` in a dev build), after the SHA-256 matches, in a private
`URLClassLoader` behind `DriverShim`. Anything else yields `E_DRIVER_UNAVAILABLE`. When `target/drivers` exists,
`RealDriversTest` also runs (real drivers, no real database, see below).

## Behaviour notes (decisions beyond the protocol text)

- Multiple statements, empty SQL, and unterminated strings/comments -> `E_BAD_REQUEST`. `mode:"read"` with a
  non-read statement (including `CALL`, PL/SQL blocks, `SELECT ... INTO`, `FOR UPDATE`, `EXPLAIN ANALYZE <dml>`)
  -> `E_READONLY_VIOLATION`. Write needs session `allowWrite` **and** `confirmWrite:true`, else `E_POLICY`.
- `maxRows`/`timeoutSec`/`pageSize` are clamped to their caps (100000 / 600 / 5000); `<1` is `E_BAD_REQUEST`.
- Session ids are random (`s_<24 hex>`). Limits/idle: env `TABLEDB_MAX_SESSIONS` (20), `TABLEDB_MAX_CURSORS` (10 per
  session), `TABLEDB_IDLE_SEC` (1800). Requests run concurrently (so `query.cancel` can overtake `query.execute`);
  responses may therefore arrive out of order - correlate by `id`.
- A response line over 8 MiB is replaced by `E_LIMIT`; pages are also cut at ~4 MiB of cell data (`hasMore:true`).
- Read-only: `setReadOnly(true)` (PostgreSQL additionally gets `readOnlyMode=always`) plus the classifier. Oracle and
  Trino do not give a hard server-side guarantee: their DB account privileges are the last barrier.
- `proxy` (HTTP CONNECT / SOCKS5, optional username/password) and `ssh` (1-4 hops, pinned host keys) work for every driver
  through a per-session loopback relay (`Tunnel`); Trino with a credential-less proxy keeps its native `httpProxy`/`socksProxy`.
  SSH keys are read by id from `--ssh-keys <dir>` only. The jar is built `Multi-Release: true` because JSch's Ed25519
  classes live under `META-INF/versions/15`.
- Trino needs TLS for password/JWT/SSO (a driver rule) so use `options.ssl:true`. `TrinoVendor` uses
  `io.trino.jdbc.TestingRedirectHandlerInjector.setRedirectHandler(Consumer<URI>)` (public in trino-jdbc 483, found
  with javap) to emit `auth.openUrl`; if a future driver drops it, SSO sessions fail with `E_DRIVER_UNAVAILABLE`.
- Logging is stderr only and scrubbed; `TABLEDB_LOG=debug` adds SQL hash + literal-masked first 200 chars.
- Limitation: database/schema names in profiles must match `[A-Za-z0-9_$#.-]{1,128}` (they go into the JDBC URL).

## Tests and what they cover

Test scope uses H2 (real JDBC engine) copied to a temp `drivers/` dir and loaded through the same `DriverRegistry` /
`DriverShim` path under the test-only type `h2test`; production accepts exactly `postgresql`, `oracle`, `trino`.
`TunnelTest` runs embedded SSH servers (Apache MINA SSHD, test scope) as bastions, H2 in TCP mode as the database and
small HTTP/SOCKS5 proxies: host key TOFU/mismatch, password and encrypted-key auth, 2-hop jump, forwarding refused, proxy
auth, SSH through a proxy, tunnel closed with the session. `RealDriversTest` uses the real jars against a fake HTTPS Trino coordinator (SSO) and closed ports.

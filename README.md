# matrix-server-performance

Performance comparison of various Matrix homeserver implementations, focused on message sending throughput.

## Results

Benchmarked on a single machine using Docker with resource limits (2 CPU / 4GB RAM per server). Each test sends 500 messages to a single room — first sequentially, then concurrently with 10 workers.

| Server | Language | Sequential (msg/s) | Seq p50 | Concurrent 10x (msg/s) | Conc p50 |
|--------|----------|-------------------|---------|----------------------|----------|
| [Conduit](https://gitlab.com/famedly/conduit) | Rust | 1,177 | 0.81ms | 2,498 | 3.9ms |
| [Tuwunel](https://github.com/matrix-construct/tuwunel) | Rust | 869 | 1.1ms | 1,826 | 5.2ms |
| [Continuwuity](https://forgejo.ellis.link/continuwuation/continuwuity) | Rust | 845 | 1.1ms | 1,456 | 6.7ms |
| [Dendrite](https://github.com/element-hq/dendrite) | Go | 92 | 10.5ms | 102 | 96ms |
| [Synapse](https://github.com/element-hq/synapse) | Python | 52 | 18ms | 108 | 92ms |

### Notes

- Conduit, Tuwunel, and Continuwuity use embedded RocksDB (no external database)
- Synapse and Dendrite use PostgreSQL 15
- All Rust servers are 10-20x faster than Go/Python for raw message throughput
- Dendrite has lower per-message latency than Synapse but doesn't scale much with concurrency
- Synapse gets a ~2x boost from concurrency despite being the slowest sequentially

## Servers

All server sources are included as git submodules under `upstream/`:

- **Synapse** — The original Matrix homeserver (Python)
- **Dendrite** — Next-gen homeserver by Element (Go)
- **Conduit** — Lightweight homeserver (Rust)
- **Continuwuity** — Fork of Conduwuit (Rust)
- **Tuwunel** — Fork of Conduwuit (Rust)
- **Telodendria** — Minimal homeserver (C) — skipped, alpha with no Docker support

## Usage

Requires Docker and Node.js 24+.

```sh
# run all servers
node main.ts

# run a specific server
node main.ts synapse

# customize
node main.ts --num-messages 1000 --concurrency 20

# run multiple specific servers
node main.ts conduit tuwunel
```

Results are saved as JSON to `results/`.

## How it works

The benchmark uses the standard Matrix Client-Server API against each server:

1. Register a user (`POST /_matrix/client/v3/register`)
2. Login (`POST /_matrix/client/v3/login`)
3. Create a room (`POST /_matrix/client/v3/createRoom`)
4. Send N messages sequentially (`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`)
5. Send N messages concurrently across M workers

Each server runs in Docker with identical resource limits. The orchestrator (`main.ts`) handles starting/stopping containers and server-specific setup (key generation, registration tokens, etc).

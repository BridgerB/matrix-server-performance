import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type BenchmarkResult, runBenchmark } from "./benchmark.ts";

const ROOT = import.meta.dirname;
const RESULTS_DIR = path.join(ROOT, "results");
const SERVERS_DIR = path.join(ROOT, "servers");

interface ServerConfig {
	name: string;
	registrationToken?: string;
	start: () => void;
	stop: () => void;
	postStart?: () => string | undefined;
}

function dockerServer(
	name: string,
	opts?: {
		preStart?: () => void;
		postStart?: () => string | undefined;
		registrationToken?: string;
	},
): ServerConfig {
	const composeFile = path.join(SERVERS_DIR, name, "docker-compose.yml");
	return {
		name,
		registrationToken: opts?.registrationToken,
		postStart: opts?.postStart,
		start() {
			if (opts?.preStart) opts.preStart();
			console.log(`Starting ${name}...`);
			exec(`docker compose -f ${composeFile} up -d --build`);
		},
		stop() {
			exec(`docker compose -f ${composeFile} down -v --remove-orphans`, {
				ignoreError: true,
			});
		},
	};
}

const SERVERS: ServerConfig[] = [
	dockerServer("synapse", {
		preStart() {
			const composeFile = path.join(
				SERVERS_DIR,
				"synapse",
				"docker-compose.yml",
			);
			console.log("Generating Synapse signing key...");
			exec(
				`docker compose -f ${composeFile} run --rm ` +
					`-e SYNAPSE_SERVER_NAME=benchmark.local ` +
					`-e SYNAPSE_REPORT_STATS=no ` +
					`--no-deps synapse generate`,
				{ ignoreError: true },
			);
		},
	}),
	dockerServer("conduit"),
	dockerServer("continuwuity", {
		postStart() {
			const composeFile = path.join(
				SERVERS_DIR,
				"continuwuity",
				"docker-compose.yml",
			);
			console.log("Extracting registration token from logs...");
			for (let i = 0; i < 30; i++) {
				const logs = execCapture(
					`docker compose -f ${composeFile} logs homeserver 2>&1`,
				);
				const match = logs.match(
					/using the registration token\s+(?:\x1b\[[^m]*m)*(\w+)/,
				);
				if (match) {
					console.log(`  Token: ${match[1]}`);
					return match[1];
				}
				execSync("sleep 1");
			}
			throw new Error(
				"Could not find registration token in continuwuity logs",
			);
		},
	}),
	dockerServer("tuwunel"),
	dockerServer("dendrite", {
		preStart() {
			const configDir = path.join(SERVERS_DIR, "dendrite", "config");
			const keyFile = path.join(configDir, "matrix_key.pem");
			if (!existsSync(keyFile)) {
				console.log("Generating Dendrite signing key...");
				exec(
					`docker run --rm --entrypoint="" ` +
						`-v ${configDir}:/mnt ` +
						`ghcr.io/element-hq/dendrite-monolith:latest ` +
						`/usr/bin/generate-keys -private-key /mnt/matrix_key.pem`,
				);
			}
		},
	}),
];

function exec(cmd: string, opts?: { ignoreError?: boolean }) {
	console.log(`$ ${cmd}`);
	try {
		execSync(cmd, { stdio: "inherit", timeout: 300_000 });
	} catch (e) {
		if (!opts?.ignoreError) throw e;
	}
}

function execCapture(cmd: string): string {
	return execSync(cmd, { timeout: 30_000 }).toString();
}

function parseArgs() {
	const args = process.argv.slice(2);
	let numMessages = 500;
	let concurrency = 10;
	const serverNames: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--num-messages" && args[i + 1]) {
			numMessages = parseInt(args[++i], 10);
		} else if (args[i] === "--concurrency" && args[i + 1]) {
			concurrency = parseInt(args[++i], 10);
		} else if (!args[i].startsWith("--")) {
			serverNames.push(args[i]);
		}
	}

	return { numMessages, concurrency, serverNames };
}

async function main() {
	const { numMessages, concurrency, serverNames } = parseArgs();

	const serversToRun =
		serverNames.length > 0
			? SERVERS.filter((s) => serverNames.includes(s.name))
			: SERVERS;

	if (serversToRun.length === 0) {
		console.error(
			`No matching servers. Available: ${SERVERS.map((s) => s.name).join(", ")}`,
		);
		process.exit(1);
	}

	mkdirSync(RESULTS_DIR, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const results: BenchmarkResult[] = [];

	console.log("Matrix Homeserver Benchmark");
	console.log(`  Messages per test: ${numMessages}`);
	console.log(`  Concurrency: ${concurrency}`);
	console.log(`  Servers: ${serversToRun.map((s) => s.name).join(", ")}`);
	console.log();

	for (const server of serversToRun) {
		console.log("=".repeat(60));
		console.log(` Benchmarking: ${server.name}`);
		console.log("=".repeat(60));

		server.stop();
		server.start();

		let registrationToken = server.registrationToken;
		if (server.postStart) {
			registrationToken = server.postStart();
		}

		try {
			const result = await runBenchmark({
				serverName: server.name,
				baseUrl: "http://localhost:8008",
				numMessages,
				concurrency,
				registrationToken,
			});
			results.push(result);

			const outFile = path.join(
				RESULTS_DIR,
				`${server.name}_${timestamp}.json`,
			);
			writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
			console.log(`Results saved to ${outFile}`);
		} catch (e) {
			console.error(`Benchmark failed for ${server.name}:`, e);
		} finally {
			server.stop();
		}

		console.log();
	}

	if (results.length > 0) {
		console.log("=".repeat(60));
		console.log(" Summary");
		console.log("=".repeat(60));
		for (const r of results) {
			console.log(`  ${r.server_name}:`);
			console.log(
				`    Sequential:  ${r.sequential.messages_per_second} msg/s  (p50 ${r.sequential.latency_p50_ms}ms, p99 ${r.sequential.latency_p99_ms}ms)`,
			);
			console.log(
				`    Concurrent:  ${r.concurrent.messages_per_second} msg/s  (p50 ${r.concurrent.latency_p50_ms}ms, p99 ${r.concurrent.latency_p99_ms}ms)`,
			);
		}
	}
}

main();

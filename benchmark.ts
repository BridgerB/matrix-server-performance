import crypto from "node:crypto";

interface Stats {
	num_messages: number;
	total_time_s: number;
	messages_per_second: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	latency_min_ms: number;
	latency_max_ms: number;
	latency_mean_ms: number;
	concurrency?: number;
}

export interface BenchmarkResult {
	server_name: string;
	timestamp: string;
	sequential: Stats;
	concurrent: Stats;
}

export async function waitForServer(
	baseUrl: string,
	timeoutMs = 120_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(`${baseUrl}/_matrix/client/versions`);
			if (resp.ok) return;
		} catch {
			/* server not ready yet */
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(
		`Server at ${baseUrl} did not become ready within ${timeoutMs}ms`,
	);
}

export async function register(
	baseUrl: string,
	username: string,
	password: string,
	registrationToken?: string,
): Promise<{ user_id: string; access_token: string }> {
	const url = `${baseUrl}/_matrix/client/v3/register`;
	const body: Record<string, unknown> = {
		username,
		password,
		inhibit_login: false,
	};

	// Step 1: request without auth to get session and flows
	let resp = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (resp.status === 401) {
		const data = await resp.json();
		const session = data.session;
		const flows = data.flows ?? [];
		const stages: string[] = flows[0]?.stages ?? [];

		// Step 2: complete each required stage
		for (const stage of stages) {
			if (stage === "m.login.registration_token") {
				body.auth = {
					type: "m.login.registration_token",
					token: registrationToken ?? "",
					session,
				};
			} else {
				body.auth = { type: stage, session };
			}
			resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (resp.ok) return resp.json();
			if (resp.status !== 401) break;
		}

		// Fallback: try dummy auth if stages didn't complete
		if (!resp.ok && resp.status === 401) {
			body.auth = { type: "m.login.dummy", session };
			resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		}
	}

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Register failed (${resp.status}): ${err}`);
	}
	return resp.json();
}

export async function login(
	baseUrl: string,
	username: string,
	password: string,
): Promise<string> {
	const resp = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: username },
			password,
		}),
	});
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Login failed (${resp.status}): ${err}`);
	}
	const data = await resp.json();
	return data.access_token;
}

export async function createRoom(
	baseUrl: string,
	accessToken: string,
): Promise<string> {
	const resp = await fetch(`${baseUrl}/_matrix/client/v3/createRoom`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ preset: "private_chat" }),
	});
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Create room failed (${resp.status}): ${err}`);
	}
	const data = await resp.json();
	return data.room_id;
}

export async function sendMessage(
	baseUrl: string,
	accessToken: string,
	roomId: string,
	text: string,
	txnId?: string,
): Promise<number> {
	const id = txnId ?? crypto.randomUUID();
	const url = `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${id}`;
	const start = performance.now();
	const resp = await fetch(url, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ msgtype: "m.text", body: text }),
	});
	const elapsed = performance.now() - start;
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Send message failed (${resp.status}): ${err}`);
	}
	return elapsed;
}

function computeStats(latencies: number[], wallTimeMs: number): Stats {
	const sorted = [...latencies].sort((a, b) => a - b);
	const n = sorted.length;
	const percentile = (p: number) => sorted[Math.min(Math.floor(n * p), n - 1)];
	const mean = sorted.reduce((a, b) => a + b, 0) / n;

	return {
		num_messages: n,
		total_time_s: round(wallTimeMs / 1000, 3),
		messages_per_second: round(n / (wallTimeMs / 1000), 2),
		latency_p50_ms: round(percentile(0.5), 2),
		latency_p95_ms: round(percentile(0.95), 2),
		latency_p99_ms: round(percentile(0.99), 2),
		latency_min_ms: round(sorted[0], 2),
		latency_max_ms: round(sorted[n - 1], 2),
		latency_mean_ms: round(mean, 2),
	};
}

function round(n: number, decimals: number): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

async function benchmarkSequential(
	baseUrl: string,
	accessToken: string,
	roomId: string,
	numMessages: number,
): Promise<{ latencies: number[]; wallTimeMs: number }> {
	const latencies: number[] = [];
	const start = performance.now();
	for (let i = 0; i < numMessages; i++) {
		const lat = await sendMessage(baseUrl, accessToken, roomId, `seq msg ${i}`);
		latencies.push(lat);
	}
	return { latencies, wallTimeMs: performance.now() - start };
}

async function benchmarkConcurrent(
	baseUrl: string,
	accessToken: string,
	roomId: string,
	numMessages: number,
	concurrency: number,
): Promise<{ latencies: number[]; wallTimeMs: number }> {
	const perWorker = Math.floor(numMessages / concurrency);
	const remainder = numMessages % concurrency;

	const start = performance.now();
	const tasks = Array.from({ length: concurrency }, async (_, w) => {
		const count = perWorker + (w < remainder ? 1 : 0);
		const lats: number[] = [];
		for (let i = 0; i < count; i++) {
			const lat = await sendMessage(
				baseUrl,
				accessToken,
				roomId,
				`conc msg ${w}-${i}`,
			);
			lats.push(lat);
		}
		return lats;
	});

	const results = await Promise.all(tasks);
	const wallTimeMs = performance.now() - start;
	return { latencies: results.flat(), wallTimeMs };
}

export async function runBenchmark(opts: {
	serverName: string;
	baseUrl: string;
	numMessages: number;
	concurrency: number;
	registrationToken?: string;
}): Promise<BenchmarkResult> {
	const { serverName, baseUrl, numMessages, concurrency, registrationToken } =
		opts;

	console.log(`Waiting for ${serverName} at ${baseUrl}...`);
	await waitForServer(baseUrl);
	console.log(`${serverName} is ready.`);

	const username = `bench_${crypto.randomUUID().slice(0, 8)}`;
	const password = "benchmarkpassword123";

	console.log(`Registering user ${username}...`);
	await register(baseUrl, username, password, registrationToken);

	console.log("Logging in...");
	const accessToken = await login(baseUrl, username, password);

	console.log("Creating room...");
	const roomId = await createRoom(baseUrl, accessToken);
	console.log(`Room: ${roomId}`);

	console.log(`\n--- Sequential: ${numMessages} messages ---`);
	const seq = await benchmarkSequential(
		baseUrl,
		accessToken,
		roomId,
		numMessages,
	);
	const seqStats = computeStats(seq.latencies, seq.wallTimeMs);
	console.log(
		`  ${seqStats.messages_per_second} msg/s | p50 ${seqStats.latency_p50_ms}ms | p99 ${seqStats.latency_p99_ms}ms`,
	);

	console.log(
		`\n--- Concurrent (${concurrency} workers): ${numMessages} messages ---`,
	);
	const conc = await benchmarkConcurrent(
		baseUrl,
		accessToken,
		roomId,
		numMessages,
		concurrency,
	);
	const concStats = computeStats(conc.latencies, conc.wallTimeMs);
	concStats.concurrency = concurrency;
	console.log(
		`  ${concStats.messages_per_second} msg/s | p50 ${concStats.latency_p50_ms}ms | p99 ${concStats.latency_p99_ms}ms`,
	);

	return {
		server_name: serverName,
		timestamp: new Date().toISOString(),
		sequential: seqStats,
		concurrent: concStats,
	};
}

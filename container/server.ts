import { loadConfig } from "./src/config";
import { createDatabase } from "./src/database";
import { createApp } from "./src/http";
import { ZerionClient } from "./src/zerion";
import { EvmClient } from "./src/evm";
import { MarketClient } from "./src/market";
import { UtxoClient } from "./src/utxo";
import { PortfolioClient } from "./src/portfolio";
import { HistoryClient } from "./src/history";
import { AccountClient } from "./src/account";
import { SolanaClient } from "./src/solana";
import { Catalog } from "./src/catalog";
import { createQuoteRouter } from "./src/swap";
import { PendingSwapService } from "./src/pending-swaps";
import { CosmosFeatures } from "./src/cosmos-features";
import { MultichainClient } from "./src/multichain";
import { HiveClient } from "./src/hive";
import { VaultTelemetry } from "./src/telemetry";
import { ChainHistoryClient } from "./src/chain-history";
import { MultichainBroadcastClient } from "./src/multichain-broadcast";
import { RealtimeHub } from "./src/realtime";

const config = loadConfig();
const database = createDatabase(config);

await database.migrate();
await database.ping();

const zerion = config.zerionApiKey
	? new ZerionClient({ apiKey: config.zerionApiKey, cache: database })
	: undefined;
const evm = config.nownodesApiKey
	? new EvmClient({ apiKey: config.nownodesApiKey, cache: database })
	: undefined;
const market = config.coingeckoApiKey
	? new MarketClient({ apiKey: config.coingeckoApiKey, cache: database })
	: undefined;
const utxo = config.nownodesApiKey
	? new UtxoClient({ apiKey: config.nownodesApiKey, cache: database })
	: undefined;
const multichain = config.nownodesApiKey ? new MultichainClient({ apiKey: config.nownodesApiKey, cache: database }) : undefined;
const hive = new HiveClient(database, fetch, {
	enabled: config.hiveOnboardingEnabled,
	account: config.hiveSponsorAccount,
	activeWif: config.hiveSponsorActiveWif,
	database,
	evm,
});
const portfolio = new PortfolioClient({ zerion, evm, market, utxo, multichain, hive });
const chainHistory = config.nownodesApiKey ? new ChainHistoryClient({ apiKey: config.nownodesApiKey, cache: database }) : undefined;
const history = new HistoryClient({ zerion, utxo, multichain: chainHistory, hive });
const account = config.nownodesApiKey
	? new AccountClient({ apiKey: config.nownodesApiKey, cache: database })
	: undefined;
const solana = config.nownodesApiKey
	? new SolanaClient({ apiKey: config.nownodesApiKey })
	: undefined;
const catalog = new Catalog({ zeroxEnabled: Boolean(config.zeroxApiKey), swapkitEnabled: Boolean(config.swapkitApiKey) });
const quoteRouter = createQuoteRouter({ zeroxApiKey: config.zeroxApiKey, swapkitApiKey: config.swapkitApiKey, nownodesApiKey: config.nownodesApiKey });
const pendingSwaps = new PendingSwapService(database);
const cosmosFeatures = new CosmosFeatures(database);
const telemetry = new VaultTelemetry(database);
const multichainBroadcast = config.nownodesApiKey ? new MultichainBroadcastClient({ apiKey: config.nownodesApiKey }) : undefined;
const realtime = new RealtimeHub(history);

const app = createApp({ config, database, zerion, evm, market, utxo, portfolio, history, account, solana, catalog, quoteRouter, pendingSwaps, cosmosFeatures, hive, telemetry, multichainBroadcast, realtime });

interface SocketData { id: string; clientId?: string; heartbeat?: ReturnType<typeof setInterval> }
const server = Bun.serve<SocketData>({
	port: config.port,
	// Provider fallbacks are individually bounded but a cold multi-chain request
	// can legitimately run longer than Bun's 10s default. SSE writes a heartbeat
	// every 20s, so 60s also keeps streams healthy without disabling protection.
	idleTimeout: 60,
	fetch(request, bunServer) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/socket.io/" && url.searchParams.get("EIO") === "4" && url.searchParams.get("transport") === "websocket") {
			if (bunServer.upgrade(request, { data: { id: crypto.randomUUID() } })) return;
			return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
		}
		return app.fetch(request);
	},
	websocket: {
		open(ws) {
			ws.send(`0${JSON.stringify({ sid: ws.data.id, upgrades: [], pingInterval: 25_000, pingTimeout: 20_000, maxPayload: 1_000_000 })}`);
			ws.data.heartbeat = setInterval(() => { try { ws.send("2"); } catch { ws.close(); } }, 25_000);
		},
		async message(ws, input) {
			const frame = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
			if (frame === "40") { ws.send(`40${JSON.stringify({ sid: ws.data.id })}`); return; }
			if (frame === "3") return;
			if (!frame.startsWith("42")) return;
			try {
				const [event, payload] = JSON.parse(frame.slice(2));
				if (event !== "authenticate" || typeof payload?.queryKey !== "string") return;
				const client = await database.authenticate(payload.queryKey);
				if (!client) { ws.send(`42${JSON.stringify(["authenticated", { success: false }])}`); ws.close(4001, "unauthorized"); return; }
				ws.data.clientId = client.id;
				realtime.addSocket(client.id, ws.data.id, (name, data) => ws.send(`42${JSON.stringify([name, data])}`));
				ws.send(`42${JSON.stringify(["authenticated", { success: true, username: client.username }])}`);
			} catch { ws.close(4002, "invalid frame"); }
		},
		close(ws) {
			if (ws.data.heartbeat) clearInterval(ws.data.heartbeat);
			realtime.removeSocket(ws.data.clientId, ws.data.id);
		},
	},
});

console.log(JSON.stringify({
	event: "server_started",
	service: "keepkey-gateway",
	port: server.port,
	databasePoolMax: config.databaseMaxConnections,
	zerionEnabled: Boolean(zerion),
	evmEnabled: Boolean(evm),
	marketEnabled: Boolean(market),
	utxoEnabled: Boolean(utxo),
	portfolioEnabled: true,
	historyEnabled: true,
	accountEnabled: Boolean(account),
	solanaEnabled: Boolean(solana),
	catalogEnabled: true,
	quoteProviders: ["thorchain", "mayachain", "relay", "shapeshift", ...(config.zeroxApiKey ? ["zeroex"] : []), ...(config.swapkitApiKey ? ["swapkit-gated"] : [])],
	pendingSwapsEnabled: true,
	hiveEnabled: true,
}));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(JSON.stringify({ event: "server_stopping", signal }));
	// Container SIGTERM must not hang forever on open SSE/WebSocket sessions.
	// Clients reconnect; force-close network sessions before releasing Postgres.
	server.stop(true);
	await database.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

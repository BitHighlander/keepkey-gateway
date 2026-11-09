import { ProviderMetrics } from "./src/provider-metrics";
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
import { BlockbookLiveFeed } from "./src/blockbook-live";
import { RealtimeSocketSession } from "./src/realtime-socket";
import { RealtimeMonitor } from "./src/realtime-monitor";

const config = loadConfig();
const database = createDatabase(config);

await database.migrate();
await database.ping();

const providerMetrics = new ProviderMetrics(rows => database.recordProviderUsage(rows));
providerMetrics.start();

const zerion = config.zerionApiKey
	? new ZerionClient({ apiKey: config.zerionApiKey, cache: database, metrics: providerMetrics })
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
const catalog = new Catalog({ zeroxEnabled: Boolean(config.zeroxApiKey), swapkitEnabled: Boolean(config.swapkitApiKey), uniswapEnabled: Boolean(evm) });
const quoteRouter = createQuoteRouter({ ...config.swapProviders, zeroxApiKey: config.zeroxApiKey, swapkitApiKey: config.swapkitApiKey, nownodesApiKey: config.nownodesApiKey, evm });
const pendingSwaps = new PendingSwapService(database, { evm });
const cosmosFeatures = new CosmosFeatures(database);
const telemetry = new VaultTelemetry(database);
const multichainBroadcast = config.nownodesApiKey ? new MultichainBroadcastClient({ apiKey: config.nownodesApiKey }) : undefined;
const realtime = new RealtimeHub(history);
if (utxo) realtime.setUpstream(new BlockbookLiveFeed(utxo, {
	change: (watch, txid, confirmed) => realtime.upstreamChange(watch, txid, confirmed),
	sync: (networkId, reason) => realtime.upstreamSync(networkId, reason),
}));
const realtimeMonitor = database.realtime && config.realtimeSchedulerSecret
	? new RealtimeMonitor(history, database.realtime, (clientId, walletScope, eventName, payload, cursor) => realtime.publishStored(clientId, walletScope, eventName, payload, cursor)) : undefined;

const app = createApp({ config, database, zerion, evm, market, utxo, portfolio, history, account, solana, catalog, quoteRouter, pendingSwaps, cosmosFeatures, hive, telemetry, multichainBroadcast, realtime, realtimeMonitor });

interface SocketData { id: string; session?: RealtimeSocketSession; lastPong?: number; heartbeat?: ReturnType<typeof setInterval> }
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
			ws.data.lastPong = Date.now();
			ws.data.session = new RealtimeSocketSession(ws.data.id, realtime, key => database.authenticate(key),
				(name, data) => ws.send(`42${JSON.stringify([name, data])}`), (code, reason) => ws.close(code, reason));
			ws.data.heartbeat = setInterval(() => {
				if (Date.now() - (ws.data.lastPong || 0) > 45_000) { ws.data.session?.close(); ws.close(4000, "heartbeat timeout"); return; }
				try { ws.send("2"); } catch { ws.data.session?.close(); ws.close(); }
			}, 25_000);
		},
		async message(ws, input) {
			const frame = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
			if (frame === "40") { ws.send(`40${JSON.stringify({ sid: ws.data.id })}`); return; }
			if (frame === "3") { ws.data.lastPong = Date.now(); return; }
			if (!frame.startsWith("42")) return;
			try {
				const [event, payload] = JSON.parse(frame.slice(2));
				await ws.data.session?.receive(event, payload);
			} catch { ws.data.session?.close(); ws.close(4002, "invalid frame"); }
		},
		close(ws) {
			if (ws.data.heartbeat) clearInterval(ws.data.heartbeat);
			ws.data.session?.close();
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
	quoteProviders: ["thorchain", "mayachain", "relay", "nearIntents", "shapeshift", ...(evm ? ["uniswap"]:[]), ...(config.zeroxApiKey ? ["zeroex"] : []), ...(config.swapkitApiKey ? ["swapkit-gated"] : [])],
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
	realtime.close();
	server.stop(true);
	await providerMetrics.close();
	await database.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

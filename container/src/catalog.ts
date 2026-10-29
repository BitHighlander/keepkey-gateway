import assetData from "../data/assets.json";
import swapAssetsSnapshot from "../data/swap-assets.json";
import supportedChainsSnapshot from "../data/swap-supported-chains.json";

export interface DiscoveryAsset {
	assetId: string;
	chainId: string;
	symbol: string;
	name: string;
	decimals?: number;
	precision?: number;
	networkName?: string;
	[key: string]: unknown;
}

export interface SwapHealth {
	fetchedAt: number;
	integrations: Array<{
		key: string;
		label: string;
		status: "unknown" | "gated" | "disabled";
		detail: string;
	}>;
}

interface CatalogOptions {
	zeroxEnabled?: boolean;
	swapkitEnabled?: boolean;
}

const ASSETS = Object.values(assetData) as DiscoveryAsset[];
const MAX_SEARCH_RESULTS = 2_000;

/**
 * Pure, pinned catalog used by Vault startup and asset pickers.
 *
 * This class deliberately has no fetcher, cache, database, or timer. Catalog
 * reads therefore cannot create upstream load and remain available offline.
 */
export class Catalog {
	constructor(private readonly options: CatalogOptions = {}) {}

	search(query: string, requestedLimit = 50): DiscoveryAsset[] {
		const needle = query.trim().toLowerCase();
		const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(requestedLimit) || 50));
		const results: DiscoveryAsset[] = [];

		for (const asset of ASSETS) {
			if (results.length >= limit) break;
			if (needle && ![
				asset.symbol,
				asset.name,
				asset.networkName,
			].some((value) => typeof value === "string" && value.toLowerCase().includes(needle))) continue;

			// Vault currently prefers `precision`; discovery's canonical field is
			// `decimals`. Supplying both preserves old clients and correct token UX.
			results.push({ ...asset, precision: asset.precision ?? asset.decimals });
		}

		return results;
	}

	availableSwapAssets(): typeof swapAssetsSnapshot {
		return swapAssetsSnapshot;
	}

	supportedChains(): typeof supportedChainsSnapshot {
		return supportedChainsSnapshot;
	}

	swapHealth(now = Date.now()): SwapHealth {
		return {
			fetchedAt: now,
			integrations: [
				{ key: "thorchain", label: "THORChain", status: "unknown", detail: "Checked on quote demand; no background polling" },
				{ key: "mayachain", label: "Mayachain", status: "unknown", detail: "Checked on quote demand; no background polling" },
				{ key: "relay", label: "Relay", status: "unknown", detail: "Checked on quote demand; no background polling" },
				{ key: "zeroex", label: "0x", status: this.options.zeroxEnabled ? "unknown" : "disabled", detail: this.options.zeroxEnabled ? "API-key and app-fee route checked on quote demand" : "ZEROX_API_KEY is not configured" },
				{ key: "shapeshift", label: "ShapeShift", status: "unknown", detail: "Partner-attributed fallback (including moving swappers such as Chainflip/NEAR); checked only on quote demand" },
				{ key: "swapkit", label: "SwapKit", status: this.options.swapkitEnabled ? "gated" : "disabled", detail: this.options.swapkitEnabled ? "API-key fallback remains unavailable unless each quote proves nonzero affiliate attribution" : "SWAPKIT_API_KEY is not configured" },
			],
		};
	}
}

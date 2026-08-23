import { Container, getContainer } from "@cloudflare/containers";

interface Env {
	PIONEER_CONTAINER: DurableObjectNamespace<PioneerContainer>;
}

const MAIN_INSTANCE_ID = "pioneer-main";

// Wraps the pioneer container image (see ./container). One Durable Object
// instance == one running container; Cloudflare handles start-on-fetch and
// scale-to-zero via `sleepAfter`, and forwards WebSocket upgrades through
// `.fetch()` automatically. Pattern taken from DegenQuest's proven Cloudflare
// Containers cutover (projects/game/deploy/core-container).
export class PioneerContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "10m";
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const container = getContainer(env.PIONEER_CONTAINER, MAIN_INSTANCE_ID);
		return container.fetch(request);
	},
} satisfies ExportedHandler<Env>;

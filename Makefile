.PHONY: test typecheck dev deploy

# Unit tests for the Worker and the container (no network).
test:
	bun run test

# Both TypeScript projects: the Worker (tsconfig.json) and the container.
typecheck:
	bun run typecheck

# Local Worker + container through Wrangler.
dev:
	bun run dev

# Publishes to Cloudflare. Owner-only: never run from an agent session.
deploy:
	bun run deploy

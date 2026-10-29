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

# Publishes to Cloudflare. CI runs this on every push to master (.github/workflows/deploy.yml).
deploy:
	bun run deploy

# Orbit Management Bot

Orbit is a lightweight Discord management bot for Roblox and ER:LC-style communities, with SQLite-backed configuration, moderation, tickets, reports, and staff utilities.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the HTTP health service and Discord bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_TOKEN`
- Optional env: `DATA_DIR` (defaults to `./data`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot.ts` — Discord commands, events, buttons, modals, and permission checks
- `artifacts/api-server/src/database.ts` — SQLite schema and persistence helpers
- `artifacts/api-server/.env.example` — required environment variables

## Architecture decisions

- SQLite uses WAL mode to stay lightweight while surviving restarts.
- The bot keeps anonymous message content out of logs and stores only a hash for abuse tracing.
- Discord permissions and configured server roles are checked together for dangerous actions.

## Product

## Product

- Interactive private tickets with claims, closure, member access, and transcripts
- Tester, developer, bug, suggestion, and staff application forms
- Role/channel setup menu, welcome messages, auto roles, and auto reactions
- Case-based moderation with warnings and moderation logging
- Embed builder, anonymous DMs, role panels, polls, announcements, and utility commands

## User preferences

Keep the bot inexpensive to run and prefer Discord-native UI components over extra web infrastructure.

## Gotchas

- The bot needs Message Content, Server Members, and moderation-related intents enabled in the Discord Developer Portal.
- The bot role must sit above any role it assigns or moderates.
- Configure the server with `!setup` before using destination-based reports and logs.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

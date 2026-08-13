---
name: Discord bot operations
description: Runtime constraints for the lightweight Discord management service.
---

The Discord client should keep a small HTTP health service alongside it. This lets the managed Replit workflow remain observable and healthy even when Discord credentials are temporarily unavailable, while SQLite WAL keeps bot state restart-safe without a hosted database.

**Why:** Replit service workflows expect a listening port, but a Discord bot itself does not expose HTTP; keeping both avoids a fragile custom workflow and preserves low operating cost.

**How to apply:** Keep the health route and `PORT` handling intact when extending bot commands or interaction systems.
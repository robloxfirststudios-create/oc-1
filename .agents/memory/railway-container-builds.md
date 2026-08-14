---
name: Railway container builds
description: Deployment constraint for the Discord bot's pnpm workspace and native SQLite dependency.
---

For Railway, build the service with an explicit Dockerfile that pins pnpm and installs the native build toolchain for better-sqlite3 before running the frozen-lockfile build.

**Why:** Railway's automatic Nixpacks detection can fail at the image-build stage when inferring this workspace, even though the same pnpm build succeeds locally.

**How to apply:** Keep `railway.json` pointed at the root Dockerfile, preserve the `/api/healthz` health check, and keep `DATA_DIR` on a persistent Railway volume.
# Railway setup

This repository is configured as one Railway service. Railway should use the root of the repository; do not select an individual workspace package. The service uses the root `Dockerfile` so Railway does not need to infer the pnpm workspace build.

## Deploy

1. Create a new Railway project from this repository.
2. Add the secret variable `DISCORD_TOKEN`.
3. Add `DATA_DIR=/app/data`.
4. Deploy. Railway reads `railway.json` and builds the root `Dockerfile` automatically.
5. Add a Railway Volume mounted at `/app/data` if you want SQLite data to survive redeploys.

Railway supplies `PORT` automatically. The health check is:

```text
/api/healthz
```

The service starts both the HTTP health endpoint and the Discord bot with:

```text
pnpm start
```

## Discord requirements

Enable Message Content Intent and Server Members Intent in the Discord Developer Portal. Invite the bot with the permissions listed in `replit.md`.
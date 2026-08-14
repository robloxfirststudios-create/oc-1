FROM node:22-bookworm-slim

ENV CI=true
ENV NODE_ENV=production

WORKDIR /app

# better-sqlite3 has a native module. Keep the toolchain in the image build
# rather than relying on Railway's automatic builder to provide it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.26.1 --activate

# Copy the manifests first so dependency installation remains cacheable.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN mkdir -p artifacts/api-server
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm railway:build

CMD ["pnpm", "start"]
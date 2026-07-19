# Deploy-ready Dockerfile (optional on Railway; Railway can auto-build from Node)
#
# Fix (2026-07-19): base image was pinned to node:18-alpine, but package.json's
# engines.node requires >=20.0.0 — the compiled parseOrder.ts uses the 'v' regex
# flag, which is a SyntaxError on Node <20 at runtime, not just a lint warning.
# This was never caught because this Dockerfile was never actually built
# anywhere (Railway defaulted to its Node buildpack instead); it only surfaced
# when Render auto-detected the Dockerfile and would have used it directly.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Fix (2026-07-19): `npm ci` runs the `postinstall` script (`prisma generate`),
# which needs prisma/schema.prisma — but only package*.json had been copied at
# that point, so `npm ci` failed outright before reaching `npm run build`.
# Copying prisma/ first (schema only, not the rest of the app) keeps most of
# Docker's layer-caching benefit while fixing the ordering bug.
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]

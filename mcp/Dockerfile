# MCP server for agents. Build context is mcp/.
#
# Debian, not Alpine: the snapshot tool runs Playwright's headless Chromium,
# which Playwright builds for glibc on amd64 and arm64, not for musl. Only
# the headless shell is installed, not the full browser. The libraries are
# Playwright's Chromium list for Debian 12 (what "playwright install-deps
# chromium" installs), without Xvfb and the CJK fonts. fonts-liberation
# covers the viewer's text, DejaVu and Noto emoji its button symbols.
FROM node:22-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# System packages first, in their own layer, so a package.json change does
# not install them again.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      libfontconfig1 libfreetype6 \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright-core install --only-shell chromium \
 && npm cache clean --force
COPY src/ ./src/

ENV NODE_ENV=production PCBS_DIR=/pcbs PORT=3000
EXPOSE 3000
USER node
# tini as PID 1 reaps the browser's child processes and passes signals on.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.js"]

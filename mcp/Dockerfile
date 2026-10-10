# MCP server for agents. Build context is mcp/.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/

ENV NODE_ENV=production PCBS_DIR=/pcbs PORT=3000
EXPOSE 3000
USER node
CMD ["node", "src/main.js"]

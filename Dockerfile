# Herald / Campus Notification Engine. The UI is prebuilt into public/ by the web stage.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npx tsc --noEmit -p . && npx vite build --outDir /out

FROM node:22-alpine
ENV NODE_ENV=production DB_PATH=/data/campus.db PORT=3000
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY scripts/demo.js ./scripts/demo.js
COPY --from=web /out ./public
VOLUME ["/data"]
EXPOSE 3000
USER node
# Production refuses placeholder secrets: pass API_KEY and JWT_SECRET.
CMD ["node", "src/index.js"]

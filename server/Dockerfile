# 最小の永続化サーバ。better-sqlite3 は prebuilt バイナリを取得できるので、
# 通常はビルドツール無しで npm ci が通る（通らない環境向けの注記は compose 参照）。
FROM node:22-bookworm-slim

WORKDIR /app

# 依存だけ先に入れてキャッシュを効かせる
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# tsx をランタイムに置く（小さなサービスなのでビルド段は省略）
RUN npm install tsx@^4.19.0 --no-save --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/data/app.db
EXPOSE 3000
VOLUME ["/data"]

CMD ["npx", "tsx", "src/index.ts"]

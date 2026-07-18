// 最小の永続化サーバ（認証なし・ゲストCookie同期）。
// - GET  /api/health  … 死活
// - GET  /api/profile … ゲストの保存済み profile を返す（無ければ null）。gid Cookie を発行
// - PUT  /api/profile … profile を LWW で保存
//
// 静的配信・TLS は前段の Caddy が担う（このサーバは /api だけ）。
// 認証は後付け前提: gid（ゲスト）を users にリンクすれば、そのまま移行できる。

import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { getProfile, openDb, putProfile } from './db.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_FILE = process.env.DB_FILE ?? '/data/app.db';
const COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'dev-insecure-change-me';
const GID_COOKIE = 'gid';
const GID_MAX_AGE = 60 * 60 * 24 * 400; // 約400日

const db = openDb(DB_FILE);
const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
await app.register(cookie, { secret: COOKIE_SECRET });

/** リクエストからゲストIDを取り出す。無ければ新規発行して Cookie を貼る */
function ensureGid(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): string {
  const existing = req.cookies[GID_COOKIE];
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const gid = randomUUID();
  reply.setCookie(GID_COOKIE, gid, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // 本番は TLS 前提（Caddy）
    maxAge: GID_MAX_AGE,
  });
  return gid;
}

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/profile', async (req, reply) => {
  const gid = ensureGid(req, reply);
  const row = getProfile(db, gid);
  if (!row) return { profile: null, updatedAt: 0 };
  return { profile: JSON.parse(row.data), updatedAt: row.updated_at };
});

app.put('/api/profile', async (req, reply) => {
  const gid = ensureGid(req, reply);
  const body = req.body as { profile?: unknown; updatedAt?: number } | undefined;
  if (!body || typeof body.profile !== 'object' || body.profile === null) {
    reply.code(400);
    return { error: 'profile is required' };
  }
  const updatedAt = typeof body.updatedAt === 'number' ? body.updatedAt : Date.now();
  const stored = putProfile(db, gid, JSON.stringify(body.profile), updatedAt);
  // 保存された（勝った）方を返す。クライアントは updatedAt がズレていれば採用し直す
  return { profile: JSON.parse(stored.data), updatedAt: stored.updated_at };
});

// ---- 夜間バックアップ（整合dumpを /data/backups に。スナップショットが一貫dumpを含むように） ----
import { mkdirSync } from 'node:fs';
function scheduleBackup(): void {
  const dir = DB_FILE.replace(/[^/]+$/, '') + 'backups';
  mkdirSync(dir, { recursive: true });
  const run = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    db.backup(`${dir}/app-${stamp}.db`)
      .then(() => app.log.info(`backup done: app-${stamp}.db`))
      .catch((e) => app.log.error(e, 'backup failed'));
  };
  setInterval(run, 24 * 60 * 60 * 1000); // 24時間ごと
}
scheduleBackup();

app.listen({ port: PORT, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});

// SQLite の薄いラッパ。保存対象は「ゲスト1人＝ゲームの profile JSON 1個」だけ。
// スキーマは最小。将来の認証（users とのリンク）やリプレイ検証（runs/leaderboard）は
// テーブルを足すだけで載る。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProfileRow = { data: string; updated_at: number };

export function openDb(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // 潜行終了・買い物時だけの書き込みには十分
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      gid        TEXT PRIMARY KEY,          -- ゲストID（Cookie）。後で users と結び付けられる
      data       TEXT NOT NULL,             -- ゲームの Profile を JSON 文字列で丸ごと
      updated_at INTEGER NOT NULL,          -- クライアントの編集時刻（epoch ms）＝LWWの時計
      server_at  INTEGER NOT NULL           -- サーバ受信時刻（監査用）
    );
  `);
  return db;
}

export function getProfile(db: Database.Database, gid: string): ProfileRow | undefined {
  return db
    .prepare('SELECT data, updated_at FROM profiles WHERE gid = ?')
    .get(gid) as ProfileRow | undefined;
}

/**
 * LWW（last-write-wins）で upsert する。
 * 受信 updated_at が保存済みより古ければ書き込まず、保存済みを返す（クライアントが採用し直す）。
 * @returns 実際に保存されている行（勝った方）
 */
export function putProfile(
  db: Database.Database,
  gid: string,
  data: string,
  updatedAt: number,
): ProfileRow {
  const now = Date.now();
  const existing = getProfile(db, gid);
  if (existing && existing.updated_at >= updatedAt) {
    return existing; // サーバ側の方が新しい（or同時刻）。書き込まない
  }
  db.prepare(
    `INSERT INTO profiles (gid, data, updated_at, server_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(gid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, server_at = excluded.server_at`,
  ).run(gid, data, updatedAt, now);
  return { data, updated_at: updatedAt };
}

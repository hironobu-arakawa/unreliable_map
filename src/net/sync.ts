// クラウド同期（最小・ゲスト）。
// localStorage を手元の真実として保ちつつ、/api に write-through する薄い層。
// サーバが無い・オフライン・静的ホスティングでもゲームは普通に動く（同期はベストエフォート）。
//
// 競合は updatedAt による last-write-wins（別端末で遊んだら「新しい編集」が勝つ）。
// 認証は無し: サーバがゲストCookie(gid)で人を識別する。後で本登録に昇格できる。

import { loadProfile, saveProfile, type Profile } from '../ui/profile';

const API = '/api/profile';
const TS_KEY = 'unreliable-map/profile/updatedAt';

/** この端末の profile の最終編集時刻（LWWの時計） */
export function localUpdatedAt(): number {
  const raw = localStorage.getItem(TS_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function setLocalUpdatedAt(ts: number): void {
  try {
    localStorage.setItem(TS_KEY, String(ts));
  } catch {
    // プライベートモード等では諦める（その場のプレイは続く）
  }
}

/** サーバから取得。失敗（サーバ無し/オフライン）なら null */
async function pull(): Promise<{ profile: Profile | null; updatedAt: number } | null> {
  try {
    const res = await fetch(API, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as { profile: Profile | null; updatedAt: number };
  } catch {
    return null;
  }
}

/** サーバへ保存。返り値は実際に保存された（勝った）方の updatedAt。失敗なら null */
async function push(profile: Profile, updatedAt: number): Promise<number | null> {
  try {
    const res = await fetch(API, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile, updatedAt }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { updatedAt: number };
    return body.updatedAt;
  } catch {
    return null;
  }
}

/**
 * 起動時の同期。
 * - サーバの方が新しい（or 手元が空）→ サーバ版を採用して localStorage を更新
 * - そうでなければ手元をサーバへ押し上げる
 * @returns 採用した profile（サーバ版に差し替えたなら true）。呼び出し側が再描画に使う
 */
export async function bootstrapSync(current: Profile): Promise<{ profile: Profile; adopted: boolean }> {
  const remote = await pull();
  if (!remote) return { profile: current, adopted: false }; // オフライン等：手元のまま

  const localTs = localUpdatedAt();
  const hasLocal = localStorage.getItem('unreliable-map/profile/v1') !== null;

  if (remote.profile && (remote.updatedAt > localTs || !hasLocal)) {
    // サーバ版が新しい／この端末は初めて → 採用
    saveProfile(remote.profile);
    setLocalUpdatedAt(remote.updatedAt);
    return { profile: remote.profile, adopted: true };
  }

  // 手元が新しい → サーバへ（手元の時刻がまだ無ければ今を刻む）
  const ts = localTs > 0 ? localTs : Date.now();
  setLocalUpdatedAt(ts);
  void push(current, ts);
  return { profile: current, adopted: false };
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * ローカル保存＋サーバへ write-through（デバウンス）。
 * 潜行終了・買い物など「区切り」でだけ呼ぶ（毎行動は呼ばない）。
 */
export function persist(profile: Profile): void {
  const ts = Date.now();
  saveProfile(profile);
  setLocalUpdatedAt(ts);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void push(profile, ts);
  }, 800);
}

export { loadProfile };

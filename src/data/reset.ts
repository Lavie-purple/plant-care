/**
 * 重置本地数据（D-19）。
 *
 * 背景：只要有标签页开着，indexedDB.deleteDatabase 就会一直 blocked。
 * 用户的直觉是「浏览器卡住了」，实际上是他昨天留下的某个标签页还握着连接。
 *
 * 修法分三步：
 *   1. 先清空表（不需要删库，不受阻塞影响）——这一步能解决 90% 的「重置」需求
 *   2. 若用户明确要求删库，先通过 BroadcastChannel 通知所有标签页关闭连接
 *   3. 等一个宽限期后再试删；仍阻塞就明确告知「关掉其他标签页再试」
 *
 * 关键取舍：不清除 service worker 与缓存。
 * 它们不是用户数据，清掉会连带丢失离线能力与图标，
 * 而用户点「重置数据」通常只是想清植物记录。
 */

import { DB_NAME, DB_VERSION, getDatabaseName, SCHEMA, STORES, type StoreName } from '../storage/indexeddb.js';
import { BROADCAST_CHANNEL } from '../storage/indexeddb.js';

export const RELEASE_MSG = 'close-db-for-delete';
/** 通知后等多久再删。这个值要大于一个标签页响应并 close 的时间。 */
export const GRACE_MS = 400;

export type ResetOutcome =
  | { ok: true; mode: 'cleared'; note: string }
  | { ok: true; mode: 'deleted'; note: string }
  | { ok: false; mode: 'blocked'; note: string }
  | { ok: false; mode: 'error'; note: string };

/**
 * 第一步：清空所有表。
 * 不删库，所以不受其他标签页持有的连接影响。
 */
export async function clearTables(db: IDBDatabase): Promise<void> {
  const names = Object.keys(SCHEMA) as StoreName[];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清空表失败'));
    tx.onabort = () => reject(tx.error ?? new Error('清空被中止'));
  });
}

/** 第二步：广播「请关闭连接」，等一个宽限期 */
async function askOthersToClose(): Promise<void> {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(BROADCAST_CHANNEL);
  ch.postMessage({ kind: RELEASE_MSG });
  ch.close();
  await new Promise((r) => setTimeout(r, GRACE_MS));
}

export interface ResetOptions {
  /** 是否连带删除整个数据库文件。false（默认）只清空表。 */
  deleteDatabase?: boolean;
  /** 通知其他标签页关连接 */
  notifyOthers?: boolean;
}

/**
 * 重置本地数据。
 *
 * 默认只清空表：这是绝大多数「重置」的真实意图，而且不受阻塞影响。
 * 只有明确要求删库时才走「通知 + 删库」，而那条路在有标签页开着时
 * 仍可能被阻塞 —— 这时必须明说原因，而不是让用户干等。
 */
export async function resetLocalData(
  db: IDBDatabase | null,
  opts: ResetOptions = {},
): Promise<ResetOutcome> {
  const { deleteDatabase = false, notifyOthers = true } = opts;

  try {
    // 清表需要打开的连接。关掉本地连接再走删库流程。
    try {
      db?.close();
    } catch {
      // 已经关了就算了
    }

    if (!deleteDatabase) {
      // 清表需要连接。若没有可用连接就新开一个。
      const conn = await openFresh(getDatabaseName());
      await clearTables(conn);
      conn.close();
      return { ok: true, mode: 'cleared', note: '已清空所有本地数据，离线缓存与图标保留。' };
    }

    if (notifyOthers) await askOthersToClose();

    const result = await tryDeleteDatabase(getDatabaseName());
    if (result === 'deleted') {
      return { ok: true, mode: 'deleted', note: '已删除本地数据库。' };
    }
    if (result === 'blocked') {
      return {
        ok: false,
        mode: 'blocked',
        note:
          '数据库仍被其他标签页占用，已经通知过它们关闭连接。' +
          '请关掉本应用的其他标签页后重试，或者改用「清空数据」（不删库，效果一样）。',
      };
    }
    return { ok: false, mode: 'error', note: '删除失败，浏览器未说明原因。' };
  } catch (e) {
    return { ok: false, mode: 'error', note: e instanceof Error ? e.message : String(e) };
  }
}

function openFresh(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开数据库失败'));
  });
}

function tryDeleteDatabase(name: string): Promise<'deleted' | 'blocked' | 'error'> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => resolve('error');
    // blocked 不会再触发 success 或 error，必须单独监听
    req.onblocked = () => resolve('blocked');
  });
}

export { DB_NAME, DB_VERSION, STORES };

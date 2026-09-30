/**
 * 仓储层。所有对 IndexedDB 的读写都经过这里。
 *
 * D-17 三条要求：
 *   1. 写入后广播变更
 *   2. 接收方收到广播后从库里重读，不信任广播内容
 *   3. 写入时校验 version，冲突则抛 OptimisticLockError，绝不静默覆盖
 */

import type {
  CareRule,
  DecisionLog,
  EntityId,
  ImageRecord,
  Plant,
  PlantEvent,
  PendingRuleConflict,
  Recommendation,
  Settings,
  WateringRecord,
  WeatherSnapshot,
} from '../domain/types.js';
import {
  BROADCAST_CHANNEL,
  DB_VERSION,
  getDatabaseName,
  OptimisticLockError,
  SCHEMA,
  STORES,
  WEATHER_SNAPSHOT_RETENTION,
  type ChangeMessage,
  type StoreName,
} from './indexeddb.js';

type Versioned = { id: EntityId; version: number };

export interface RepoOptions {
  /** 便于测试注入。生产环境用 globalThis.indexedDB */
  indexedDB?: IDBFactory;
  /** 便于测试注入。生产环境用 globalThis.BroadcastChannel */
  channelFactory?: (name: string) => BroadcastChannelLike;
}

export interface BroadcastChannelLike {
  postMessage(msg: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export class Repository {
  private db: IDBDatabase | undefined;
  private channel: BroadcastChannelLike | undefined;
  private readonly factory: IDBFactory;
  private readonly channelFactory: (name: string) => BroadcastChannelLike;
  /** 本窗口自己发出的变更，收到广播时忽略，避免回环 */
  private readonly sent: Set<string> = new Set();

  constructor(private readonly opts: RepoOptions = {}) {
    const f = opts.indexedDB ?? globalThis.indexedDB;
    if (!f) throw new Error('当前环境没有 IndexedDB，无法使用本应用');
    this.factory = f;
    this.channelFactory =
      opts.channelFactory ??
      ((name): BroadcastChannelLike => {
        if (typeof BroadcastChannel === 'undefined') {
          // 单窗口环境返回空实现，调用方无需分支
          return { postMessage: () => {}, close: () => {}, onmessage: null };
        }
        // 原生 BroadcastChannel 的 onmessage 签名更宽，收窄到本接口
        return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
      });
  }

  // ---------- 生命周期 ----------

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(getDatabaseName(), DB_VERSION);
      // 早先没有这三个守卫：建表阶段一旦出错，onsuccess 和 onerror
      // 都不会触发，open() 永远挂起，界面上表现为一片黑屏且没有任何提示。
      // 现在三路都有出口：成功、明确报错、启动阶段报错、超时兜底。
      let settled = false;
      const fail = (msg: string, cause?: unknown) => {
        if (settled) return;
        settled = true;
        reject(new Error('打开本地数据库失败：' + msg + (cause !== undefined ? '（' + String(cause) + '）' : '')));
      };
      const timer = setTimeout(() => fail('超时（10 秒），可能被另一个标签页占用或存储被禁用'), 10_000);

      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          for (const [name, def] of Object.entries(SCHEMA)) {
            const store = db.objectStoreNames.contains(name)
              ? (req.transaction as IDBTransaction).objectStore(name)
              : db.createObjectStore(name, { keyPath: def.keyPath });
            for (const idx of def.indexes) {
              if (!store.indexNames.contains(idx.name)) {
                store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
              }
            }
          }
        } catch (e) {
          fail('建表阶段出错：' + (e instanceof Error ? e.message : String(e)), e);
        }
      };
      req.onsuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        fail(req.error?.message ?? '未知错误', req.error);
      };
      req.onblocked = () => fail('被其他标签页阻塞，请关掉其他打开本应用的标签页后重试');
    });

    this.channel = this.channelFactory(BROADCAST_CHANNEL);
    this.channel.onmessage = (ev) => this.onBroadcast(ev.data);
    // 新窗口加入时请求其他窗口刷新，避免漏掉自己打开前的变更
    this.broadcast({ kind: 'hello' });
  }

  close(): void {
    this.channel?.close();
    this.db?.close();
    this.db = undefined;
  }

  // ---------- 广播 ----------

  onChange(handler: (msg: ChangeMessage) => void): () => void {
    if (!this.channel) throw new Error('Repository 未打开');
    const prev = this.channel.onmessage;
    this.channel!.onmessage = (ev) => {
      prev?.(ev);
      const msg = ev.data as ChangeMessage;
      if (msg && typeof msg === 'object' && 'kind' in msg) handler(msg);
    };
    return () => {
      if (this.channel) this.channel.onmessage = prev;
    };
  }

  private broadcast(msg: ChangeMessage): void {
    this.channel?.postMessage(msg);
  }

  private onBroadcast(raw: unknown): void {
    const msg = raw as ChangeMessage;
    if (!msg || typeof msg !== 'object') return;

    // 别的标签页要删库，先放开连接让它删成功（D-19）
    if ((msg as { kind?: string }).kind === 'close-db-for-delete') {
      this.close();
      return;
    }
    if (msg.kind === 'hello') {
      // 对方刚加入，回一个 ping 让它知道我们还在
      this.broadcast({ kind: 'ping' });
    }
  }

  // ---------- 底层读写 ----------

  private async tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    if (!this.db) throw new Error('Repository 未打开，请先 await open()');
    const db = this.db;
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`IndexedDB 操作失败：${store}`));
    });
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return this.tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return this.tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  }

  async byIndex<T>(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return this.tx<T[]>(store, 'readonly', (s) => s.index(index).getAll(query) as IDBRequest<T[]>);
  }

  /**
   * 写入。带乐观锁：传入 expectedVersion 时若库里版本不符则抛冲突。
   */
  async put<T extends Versioned>(store: StoreName, value: T, expectedVersion?: number): Promise<T> {
    if (!this.db) throw new Error('Repository 未打开');
    const existing = await this.get<T>(store, value.id);
    if (expectedVersion !== undefined && existing) {
      const actual = (existing as Versioned).version;
      if (actual !== expectedVersion) {
        throw new OptimisticLockError(store, value.id, expectedVersion, actual);
      }
    }
    // 若调用方没指定期望版本，则以库中现状为基准递增，不覆盖别人的修改计数
    const nextVersion = (existing ? (existing as Versioned).version : 0) + 1;
    const record = { ...value, version: nextVersion } as T;

    await this.tx(store, 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
    this.broadcast({ kind: 'put', store, id: value.id });
    return record;
  }

  /** 强制写入，跳过版本检查。仅用于「用户明确选择覆盖冲突」的路径。 */
  async forcePut<T extends Versioned>(store: StoreName, value: T): Promise<T> {
    const existing = await this.get<T>(store, value.id);
    const nextVersion = (existing ? (existing as Versioned).version : 0) + 1;
    const record = { ...value, version: nextVersion } as T;
    await this.tx(store, 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
    this.broadcast({ kind: 'put', store, id: value.id });
    return record;
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await this.tx(store, 'readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>);
    this.broadcast({ kind: 'delete', store, id });
  }

  async clear(store?: StoreName): Promise<void> {
    if (!this.db) throw new Error('Repository 未打开');
    const names = store ? [store] : (Object.keys(SCHEMA) as StoreName[]);
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(names, 'readwrite');
      for (const n of names) t.objectStore(n).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('清空失败'));
    });
    this.broadcast({ kind: 'clear' });
  }

  // ---------- 领域便捷方法 ----------

  async getPlant(id: EntityId): Promise<Plant | undefined> {
    return this.get<Plant>(STORES.plants, id);
  }

  async allPlants(): Promise<Plant[]> {
    const list = await this.getAll<Plant>(STORES.plants);
    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async getCareRuleByPlant(plantId: EntityId): Promise<CareRule | undefined> {
    const list = await this.byIndex<CareRule>(STORES.careRules, 'by_plant', plantId);
    return list[0];
  }

  /** 取植物的浇水历史，按日期倒序 */
  async wateringHistory(plantId: EntityId): Promise<WateringRecord[]> {
    const range = IDBKeyRange.bound([plantId, ''], [plantId, '￿']);
    const list = await this.byIndex<WateringRecord>(STORES.wateringRecords, 'by_plant_date', range);
    return list.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }

  /**
   * 成长时间线。不是一个表，是 PlantEvent 的一个视图（D-08）。
   */
  async growthTimeline(plantId: EntityId): Promise<PlantEvent[]> {
    const list = await this.byIndex<PlantEvent>(STORES.plantEvents, 'by_plant', plantId);
    const types = new Set(['PHOTO', 'NEW_LEAF', 'YELLOW_LEAF', 'FLOWERING', 'FRUITING', 'REPOTTING', 'PRUNING', 'PEST', 'DISEASE']);
    return list.filter((e) => types.has(e.type)).sort((a, b) => b.date.localeCompare(a.date));
  }

  async plantEvents(plantId: EntityId): Promise<PlantEvent[]> {
    const list = await this.byIndex<PlantEvent>(STORES.plantEvents, 'by_plant', plantId);
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * 保存天气快照并按保留条数裁剪最旧的。
   *
   * 早期实现每次保存都 getAll + 全表排序，是 O(n²)：存 200 条要扫 200 次，
   * 实测 200 次写入耗时 120 秒。改为先 count，不超量直接返回（O(1)），
   * 只在真超量时才按时间索引排序并删除必要条数。
   *
   * 按时间删会误伤同一时间戳的快照，所以取全量按 (timestamp, id) 稳定排序后精确删除。
   */
  async saveWeatherSnapshot(snap: WeatherSnapshot): Promise<void> {
    await this.tx(STORES.weatherSnapshots, 'readwrite', (s) => s.put(snap) as IDBRequest<IDBValidKey>);

    const total = await this.count(STORES.weatherSnapshots);
    if (total <= WEATHER_SNAPSHOT_RETENTION) return;

    const excess = total - WEATHER_SNAPSHOT_RETENTION;
    const all = await this.getAll<WeatherSnapshot>(STORES.weatherSnapshots);
    const toDelete = all
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
      .slice(0, excess);

    const db = this.db!;
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORES.weatherSnapshots, 'readwrite');
      const store = t.objectStore(STORES.weatherSnapshots);
      for (const s of toDelete) store.delete(s.id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('裁剪天气快照失败'));
    });
  }

  private async count(store: StoreName): Promise<number> {
    return this.tx<number>(store, 'readonly', (s) => s.count());
  }

  async latestWeatherSnapshot(): Promise<WeatherSnapshot | undefined> {
    const all = await this.getAll<WeatherSnapshot>(STORES.weatherSnapshots);
    if (all.length === 0) return undefined;
    return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  }

  async getSettings(): Promise<Settings | undefined> {
    const all = await this.getAll<Settings>(STORES.settings);
    return all[0];
  }

  async saveSettings(s: Settings): Promise<void> {
    // settings 的主键是 city，改城市时先删旧的
    const existing = await this.getAll<Settings>(STORES.settings);
    for (const e of existing) {
      if (e.city !== s.city) await this.tx(STORES.settings, 'readwrite', (st) => st.delete(e.city) as IDBRequest<undefined>);
    }
    await this.tx(STORES.settings, 'readwrite', (st) => st.put(s) as IDBRequest<IDBValidKey>);
    this.broadcast({ kind: 'put', store: STORES.settings, id: s.city });
  }

  async unresolvedConflicts(): Promise<PendingRuleConflict[]> {
    const all = await this.getAll<PendingRuleConflict>(STORES.pendingConflicts);
    return all.filter((c) => !c.resolvedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 全部待补全记录，补录队列用。跨植物，按时间倒序 */
  async allPendingRecords(): Promise<WateringRecord[]> {
    const list = await this.byIndex<WateringRecord>(STORES.wateringRecords, 'by_completion', 'pending');
    return list.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }

  /** 把超过阈值的待补全记录降级为「历史空白」。返回实际降级条数。 */
  async expireStalePending(olderThanDays: number, now: Date): Promise<number> {
    const pending = await this.allPendingRecords();
    const stale = pending.filter((r) => {
      const [y, m, d] = r.date.split('-').map(Number);
      const at = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
      return Math.floor((now.getTime() - at.getTime()) / 86_400_000) >= olderThanDays;
    });
    for (const r of stale) {
      // 走 forcePut：这是系统级降级而非用户编辑，不参与乐观锁协商
      await this.forcePut<WateringRecord>(STORES.wateringRecords, { ...r, completionState: 'expired' });
    }
    return stale.length;
  }

  /**
   * 存图片。同 hash 已存在则直接返回旧记录，不重复占用空间。
   * 返回的记录带 id，调用方把它挂到 coverImageId / images 数组上。
   */
  async putImage(input: Omit<ImageRecord, 'id' | 'version'>): Promise<ImageRecord> {
    const existing = await this.getByImageHash(input.hash);
    if (existing) return existing;
    return this.put<ImageRecord>(STORES.images, { ...input, id: 'img-' + input.hash, version: 0 });
  }

  async getImage(id: string): Promise<ImageRecord | undefined> {
    return this.get<ImageRecord>(STORES.images, id);
  }

  async allImages(): Promise<ImageRecord[]> {
    return this.getAll<ImageRecord>(STORES.images);
  }

  private async getByImageHash(hash: string): Promise<ImageRecord | undefined> {
    const all = await this.allImages();
    return all.find((i) => i.hash === hash);
  }

  /** 全部决定日志 */
  async allDecisionLogs(): Promise<DecisionLog[]> {
    return this.getAll<DecisionLog>(STORES.decisionLogs);
  }

  async decisionsFor(plantId: EntityId): Promise<DecisionLog[]> {
    return this.byIndex<DecisionLog>(STORES.decisionLogs, 'by_plant', plantId);
  }

  async recommendationsFor(plantId: EntityId): Promise<Recommendation[]> {
    const list = await this.byIndex<Recommendation>(STORES.recommendations, 'by_plant', plantId);
    return list.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  /**
   * 记录一次用户决定。这是闭环的末端（P 页回顾的数据来源）。
   *
   * DecisionLog 刻意不带 version：它只追加、永不修改，
   * 乐观锁对追加记录没有意义。
   */
  async recordDecision(log: DecisionLog): Promise<DecisionLog> {
    await this.tx(STORES.decisionLogs, 'readwrite', (s) => s.put(log) as IDBRequest<IDBValidKey>);
    this.broadcast({ kind: 'put', store: STORES.decisionLogs, id: log.id });
    return log;
  }
}

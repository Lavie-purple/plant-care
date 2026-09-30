import { useCallback, useEffect, useState } from 'react';
import type { WateringMethod } from '../domain/types.js';
import type { QueueItem } from '../app/completionQueue.js';
import { DEFAULT_PENDING_DAYS } from '../app/completionQueue.js';
import { estimateWateringMl } from '../app/vertical-slice.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface CompleteQueueProps {
  service: PlantCareService;
  onDone: () => void;
}

const AMOUNTS = [200, 300, 500, 800, 1000];
const METHODS: WateringMethod[] = ['浇透', '喷雾', '浸盆'];

/**
 * 补录队列（D-06 X 方案）。
 *
 * 一屏一条，做完滑到下一条。不做一次性表单——那正是这个功能要避开的东西。
 */
export function CompleteQueue({ service, onDone }: CompleteQueueProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [amount, setAmount] = useState<number | undefined>();
  const [method, setMethod] = useState<WateringMethod | undefined>();
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      // 每次进来先扫一次过期，保证队列长度有界
      await service.sweepStalePending();
      const q = await service.completionQueue();
      setItems(q);
      setIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = items[index];

  async function save() {
    if (!current) return;
    try {
      await service.completeWatering(current.record.id, {
        ...(amount !== undefined ? { amountMl: amount } : {}),
        ...(method !== undefined ? { method } : {}),
      });
      setDone((n) => n + 1);
      setAmount(undefined);
      setMethod(undefined);
      setIndex((i) => i + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function skip() {
    setAmount(undefined);
    setMethod(undefined);
    setIndex((i) => i + 1);
  }

  if (loading) return <div className="t-meta" style={{ padding: 24 }}>正在读取待补全记录…</div>;

  if (error && items.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 20, borderColor: 'var(--ln2)' }}>
          <div className="t-heading">出错了</div>
          <div className="t-meta" style={{ marginTop: 8 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 22, textAlign: 'center' }}>
          <div className="t-title">{done > 0 ? `补完了 ${done} 条` : '没有待补全的记录'}</div>
          <div className="t-secondary" style={{ marginTop: 10 }}>
            {done > 0
              ? '剩下的可以以后再补，超过 ' + DEFAULT_PENDING_DAYS + ' 天会自动归入历史空白。'
              : '批量浇水时只记时间，剩余信息可以随时回来补。'}
          </div>
          <button className="btn btn-primary" type="button" style={{ marginTop: 18, width: '100%' }} onClick={onDone}>
            返回今日养护
          </button>
        </div>
      </div>
    );
  }

  const estimated = estimateWateringMl(current.plant.potDiameterCm);
  const expiring = current.daysUntilExpire <= 3;

  return (
    <div className="cq">
      <header className="cq-top">
        <button className="btn" type="button" onClick={onDone}>← 稍后再说</button>
        <span className="t-label num">
          {index + 1} / {items.length}
        </span>
      </header>

      <div className="cq-progress" role="progressbar" aria-valuenow={index} aria-valuemin={0} aria-valuemax={items.length}>
        <div className="cq-bar" style={{ width: `${(index / items.length) * 100}%` }} />
      </div>

      <div className="cq-card">
        <div className="cq-photo" aria-hidden="true">主图</div>
        <div className="t-title" style={{ marginTop: 12 }}>{current.plant.name}</div>
        <div className="t-meta" style={{ marginTop: 4 }}>
          {current.plant.placement}　{current.record.date} {current.record.time}　{current.record.method}
        </div>

        {expiring && (
          <div className="cq-warn">
            再 {Math.max(0, current.daysUntilExpire)} 天不补就归入历史空白，水量将记为未知
          </div>
        )}

        <div className="cq-label">这次浇了多少</div>
        <div className="cq-row">
          {AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              className={amount === a ? 'btn btn-primary' : 'btn'}
              onClick={() => setAmount(a)}
            >
              {a}
            </button>
          ))}
        </div>
        {estimated !== undefined && (
          <div className="t-meta" style={{ marginTop: 6 }}>
            参考：{current.plant.potDiameterCm}cm 盆按 500ml 基准估算约 {estimated}ml
          </div>
        )}

        <div className="cq-label">换一种方式</div>
        <div className="cq-row">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              className={method === m ? 'btn btn-primary' : 'btn'}
              onClick={() => setMethod(m)}
            >
              {m}
            </button>
          ))}
        </div>

        {amount === undefined && method === undefined && (
          <div className="t-meta" style={{ marginTop: 10, color: 'var(--t3)' }}>
            不填也可以，记录会保留为「估算水量」
          </div>
        )}
      </div>

      <div className="cq-actions">
        <button className="btn" type="button" style={{ flex: 1 }} onClick={skip}>跳过</button>
        <button className="btn btn-primary" type="button" style={{ flex: 2 }} onClick={() => void save()}>
          保存，下一盆
        </button>
      </div>

      <style>{`
        .cq { display: flex; flex-direction: column; min-height: 100%; }
        .cq-top { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); }
        .cq-progress { height: 3px; background: var(--ln); }
        .cq-bar { height: 3px; background: var(--acc); transition: width var(--d-2) var(--e); }
        .cq-card { flex: 1; padding: var(--sp-5) var(--sp-4); }
        .cq-photo { height: 140px; background: var(--s2); border: 1px solid var(--ln); border-radius: var(--r-ctl); }
        .cq-warn { margin-top: 12px; padding: 8px 10px; border: 1px dashed var(--ln2); border-radius: var(--r-ctl); font-size: var(--fs-meta); color: var(--t2); }
        .cq-label { margin: var(--sp-5) 0 var(--sp-2); font-size: var(--fs-label); color: var(--t2); }
        .cq-row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
        .cq-row .btn { flex: 1 1 0; min-width: 64px; }
        .cq-actions { position: sticky; bottom: var(--nav-h); z-index: 1; display: flex; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--sf); border-top: 1px solid var(--ln); }
      `}</style>
    </div>
  );
}

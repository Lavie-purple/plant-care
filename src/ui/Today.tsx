import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PendingRuleConflict, Plant, WeatherInput } from '../domain/types.js';
import type { EngineOutput } from '../engine/recommendation.js';
import { buildTodayBoard, isBatchActionable, type Batch, type BatchItem } from '../app/batches.js';
import { describeConflict } from '../app/ruleConflict.js';
import type { PlantCareService } from '../app/vertical-slice.js';
import { describeSource, isNavigable, type SourceContext } from './sourceLabel.js';

export interface TodayProps {
  service: PlantCareService;
  /** 点击植物名进入详情页 */
  onOpenPlant?: (plantId: string) => void;
  /** 打开补录队列 */
  onOpenQueue?: () => void;
  /** 打开添加植物 */
  onAddPlant?: () => void;
}

/**
 * Today 首页（D-01：L 动作批次）。
 *
 * 布局与视觉按 drafts/wireframe-today-2.html 的 L 方案，
 * 配色按 D-12 夜色暗色优先。
 */
export function Today({ service, onOpenPlant, onOpenQueue, onAddPlant }: TodayProps) {
  const [plants, setPlants] = useState<Plant[]>([]);
  const [entries, setEntries] = useState<{ plant: Plant; recommendation: EngineOutput['recommendation']; daysSince: number | undefined }[]>([]);
  const [weather, setWeather] = useState<WeatherInput | null>(null);
  const [sources, setSources] = useState<Map<string, SourceContext>>(new Map());
  const [conflicts, setConflicts] = useState<PendingRuleConflict[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  const [queueExpiring, setQueueExpiring] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [conflictToShow, setConflictToShow] = useState<PendingRuleConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const w = await service.loadWeather();
      setWeather(w);

      const all = await service.listPlants();
      setPlants(all);

      const next: typeof entries = [];
      const srcMap = new Map<string, SourceContext>();
      for (const p of all) {
        const { rec } = await service.recommendAndCheck(p.id, w);
        next.push({ plant: p, recommendation: rec.recommendation, daysSince: rec.daysSince });
        const history = await service.wateringHistory(p.id);
        srcMap.set(p.id, { plant: p, history, ...(w.available ? { weather: w.snapshot } : {}) });
      }
      setEntries(next);
      setSources(srcMap);
      setConflicts(await service.listConflicts());
      await service.sweepStalePending();
      const q = await service.completionQueue();
      setQueueCount(q.length);
      setQueueExpiring(q.filter((x) => x.daysUntilExpire <= 3).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const board = useMemo(() => buildTodayBoard(entries, weather?.available === false), [entries, weather]);

  async function waterAll(items: BatchItem[]) {
    if (items.length === 0) return;
    setBusy(true);
    try {
      for (const it of items) {
        await service.recordWatering(it.plant.id, { entrySource: 'bulk' });
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function waterOne(plantId: string) {
    setBusy(true);
    try {
      await service.recordWatering(plantId, { entrySource: 'single' });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 20, borderColor: 'var(--ln2)' }}>
          <div className="t-heading">出错了</div>
          <div className="t-meta" style={{ marginTop: 8 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!weather) {
    return <div className="t-meta" style={{ padding: 24 }}>正在读取天气与植物数据…</div>;
  }

  return (
    <div className="today">
      <header className="topbar">
        <span className="t-title">今日养护</span>
        <span className="t-meta num">
          {weather.available
            ? `${weather.snapshot.city} ${Math.round(weather.snapshot.temperature)}°C`
            : '天气不可用'}
        </span>
      </header>

      <section className="conclusion">
        <div className="t-meta">
          {weather.available
            ? `湿度 ${weather.snapshot.humidity}%　降雨概率 ${weather.snapshot.rainProbability}%`
            : `天气数据暂不可用（${weather.fallback.reason}）`}
        </div>
        <div className="t-display" style={{ marginTop: 6 }}>
          今天 {board.attentionCount} 盆要处理
        </div>
        <div className="t-secondary" style={{ marginTop: 6 }}>
          {weather.available
            ? '依据植物、历史和今天的天气得出'
            : '本次判断只依据上次浇水时间、养护规则和历史记录'}
        </div>
      </section>

      {!weather.available && (
        <div className="notice" role="status">
          <div>
            <div className="t-label" style={{ fontWeight: 600 }}>天气数据暂不可用</div>
            <div className="t-meta" style={{ marginTop: 2 }}>
              {weather.available === false && weather.fallback.lastSuccessAt
                ? `最后一次成功获取于 ${new Date(weather.fallback.lastSuccessAt).toLocaleString('zh-CN')}`
                : '植物管理不受影响，建议可能不如平时准确'}
            </div>
          </div>
        </div>
      )}

      {queueCount > 0 && (
        <div className="notice" role="status">
          <div style={{ flex: 1 }}>
            <div className="t-label" style={{ fontWeight: 600 }}>
              {queueCount} 条浇水记录待补全
            </div>
            <div className="t-meta" style={{ marginTop: 2 }}>
              {queueExpiring > 0
                ? `其中 ${queueExpiring} 条快到补全期限`
                : '水量与方式是估算值，可以随时补'}
            </div>
          </div>
          <button className="btn" type="button" onClick={() => onOpenQueue?.()}>去补全</button>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="notice" role="status">
          <div style={{ flex: 1 }}>
            <div className="t-label" style={{ fontWeight: 600 }}>
              {conflicts.length} 条规则冲突等你确认
            </div>
            <div className="t-meta" style={{ marginTop: 2 }}>系统不会自动改你的设置</div>
          </div>
          <button className="btn" type="button" onClick={() => setConflictToShow(conflicts[0] ?? null)}>
            去看
          </button>
        </div>
      )}

      {conflictToShow && (
        <ConflictDialog
          conflict={conflictToShow}
          service={service}
          onClose={() => setConflictToShow(null)}
          onResolved={async () => {
            setConflictToShow(null);
            await reload();
          }}
        />
      )}

      {board.batches.map((batch) => (
        <BatchSection
          key={batch.kind}
          batch={batch}
          expanded={expanded}
          onToggle={id =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onWaterAll={() => waterAll(batch.items)}
          onWaterOne={(id) => waterOne(id)}
          onOpenPlant={onOpenPlant}
          sources={sources}
          busy={busy}
        />
      ))}

      {board.batches.length === 0 && (
        <div className="empty">
          <div className="t-heading">还没有植物</div>
          <div className="t-secondary" style={{ marginTop: 8 }}>
            {plants.length === 0
              ? '先添加一盆。之后每记一次浇水，系统就能结合天气告诉你今天该处理哪几盆。'
              : '当前筛选条件下没有植物。'}
          </div>
          {plants.length === 0 && (
            <button className="btn btn-primary" type="button" style={{ marginTop: 18 }} onClick={() => onAddPlant?.()}>
              添加第一盆
            </button>
          )}
        </div>
      )}

      <footer className="statusbar">
        <span className="t-label">植物 {plants.length} 盆</span>
      </footer>

      <style>{`
        .today { display: flex; flex-direction: column; min-height: 100dvh; }
        .topbar {
          position: sticky; top: 0; z-index: var(--z-sticky);
          display: flex; align-items: center; justify-content: space-between;
          padding: var(--sp-3) var(--sp-4);
          background: var(--sf); border-bottom: 1px solid var(--ln);
        }
        .conclusion { padding: var(--sp-5) var(--sp-4); border-bottom: 1px solid var(--ln); }
        .notice {
          display: flex; align-items: center; gap: var(--sp-3);
          padding: var(--sp-3) var(--sp-4);
          background: var(--acc-soft); border-bottom: 1px solid var(--ln);
        }
        .statusbar {
          position: sticky; bottom: 0; z-index: var(--z-sticky);
          padding: var(--sp-3) var(--sp-4);
          background: var(--sf); border-top: 1px solid var(--ln);
        }
      `}</style>
    </div>
  );
}

function BatchSection({
  batch,
  expanded,
  onToggle,
  onWaterAll,
  onWaterOne,
  onOpenPlant,
  sources,
  busy,
}: {
  batch: Batch;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onWaterAll: () => void;
  onWaterOne: (plantId: string) => void;
  onOpenPlant?: ((plantId: string) => void) | undefined;
  sources: Map<string, SourceContext>;
  busy: boolean;
}) {
  const isRest = batch.kind === 'no_action';
  const canBatch = isBatchActionable(batch.kind);

  return (
    <section aria-labelledby={`batch-${batch.kind}`}>
      <div className="batch-head">
        <h2 id={`batch-${batch.kind}`} className="t-heading" style={{ margin: 0 }}>{batch.title}</h2>
        <span className="t-meta num">{batch.items.length} 盆</span>
      </div>

      {batch.commonReasons.length > 0 && (
        <div className="batch-why">
          <div className="t-meta">共同依据：{batch.commonReasons[0]}</div>
        </div>
      )}

      <ul className="batch-items">
        {batch.items.map((item) => {
          const id = item.plant.id;
          const open = expanded.has(id);
          return (
            <li key={id} className={isRest ? 'item item-rest' : 'item'}>
              <div className="item-row">
                <div className="photo" aria-hidden="true" />
                <div className="item-info">
                  <button
                    className="t-label plant-name"
                    type="button"
                    onClick={() => onOpenPlant?.(item.plant.id)}
                    disabled={!onOpenPlant}
                  >
                    {item.plant.name}
                  </button>
                  <div className="t-meta num">
                    {item.intervalText}　{item.plant.placement}
                  </div>
                </div>
                {canBatch && (
                  <button className="btn" type="button" disabled={busy} onClick={() => onWaterOne(id)}>
                    浇水
                  </button>
                )}
                <button
                  className="btn"
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggle(id)}
                >
                  为什么
                </button>
              </div>
              {open && (
                <div className="reasons">
                  <div className="t-meta" style={{ marginBottom: 6 }}>
                    信心 {Math.round(item.recommendation.confidence * 100)}%　·　{item.recommendation.suggestedAction}
                  </div>
                  {item.recommendation.reasons.map((r) => (
                    <div key={r.sourceId + r.text} className="reason">
                      <div className="t-secondary">{r.text}</div>
                      <div className="t-meta">
                        来源：{describeSource(r, sources.get(id) ?? {})}
                        {isNavigable(r) ? ' · 可点开核对' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canBatch && batch.kind === 'water_now' && (
        <div className="batch-action">
          <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={onWaterAll}>
            {busy ? '处理中…' : `${batch.items.length} 盆都浇完了`}
          </button>
          <div className="t-meta" style={{ textAlign: 'center', marginTop: 8 }}>
            {batch.hint}
          </div>
        </div>
      )}

      <style>{`
        .batch-head {
          display: flex; align-items: baseline; justify-content: space-between;
          padding: var(--sp-4) var(--sp-4) var(--sp-2);
          border-top: 1px solid var(--ln);
        }
        .batch-why { padding: 0 var(--sp-4) var(--sp-2); }
        .batch-items { list-style: none; padding: 0 var(--sp-4); }
        .item { border: 1px solid var(--ln); border-radius: var(--r-ctl); background: var(--sf); margin-bottom: var(--sp-2); }
        .item-rest { opacity: 0.5; }
        .item-row { display: flex; align-items: center; gap: var(--sp-3); padding: 9px; }
        .photo { width: 46px; height: 46px; flex: 0 0 auto; background: var(--s2); border-radius: var(--r-ctl); }
        .item-info { flex: 1; min-width: 0; }
        .plant-name { background: none; border: none; padding: 0; font-weight: 600; color: var(--t1); text-align: left; }
        .plant-name:not(:disabled):hover { text-decoration: underline; }
        .plant-name:disabled { cursor: default; }
        .reasons { padding: var(--sp-3); border-top: 1px dashed var(--ln); background: var(--bg); }
        .reason { padding: 6px 0; }
        .batch-action { padding: var(--sp-2) var(--sp-4) var(--sp-4); }
      `}</style>
    </section>
  );
}

/**
 * 规则冲突确认弹窗（W3）。
 *
 * 唯一能改写 CareRule 的地方。两个要点：
 *   1. 明确说「系统不会自动改」，让用户知道这个决定权在自己
 *   2. 「以后按系统建议自动调整」默认不勾，勾了也要在设置里可关
 */
function ConflictDialog({
  conflict,
  service,
  onClose,
  onResolved,
}: {
  conflict: PendingRuleConflict;
  service: PlantCareService;
  onClose: () => void;
  onResolved: () => Promise<void>;
}) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = describeConflict(conflict);
  const plantId = conflict.plantId;

  async function choose(mode: 'keep-user' | 'take-computed') {
    setBusy(true);
    setError(null);
    try {
      // W3：展示前先标记，保证同一 id 只问这一次
      const marked = await service.takeConflictToPrompt(plantId);
      const target = marked?.id === conflict.id ? marked : conflict;
      await service.resolveRuleConflict(target.id, mode);
      if (mode === 'take-computed' && autoFollow) {
        // 勾了自动跟随就记下来：同类冲突不再询问。
        // 存库而不是内存，否则关掉页面就失效，用户会以为勾了没用。
        await service.setAutoFollowConflicts(true);
      }
      await onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mask" role="presentation" onClick={busy ? undefined : onClose} />
      <div className="sheet" role="dialog" aria-label="规则冲突确认">
        <div className="t-h">{d.headline}</div>

        <div className="cmp">
          <div className="cmp-cell">
            <div className="t-meta">你设的</div>
            <div className="cmp-n num">{d.userText}</div>
          </div>
          <div className="cmp-arrow mono" aria-hidden="true">→</div>
          <div className="cmp-cell cmp-new">
            <div className="t-meta">系统算的</div>
            <div className="cmp-n num">{d.computedText}</div>
          </div>
        </div>

        <div className="t-s" style={{ marginTop: 14 }}>{conflict.reason}</div>
        <div className="t-meta" style={{ marginTop: 8 }}>
          系统只是建议，<b style={{ color: 'var(--t1)' }}>不会自动改你的设置</b>。
        </div>
        <div className="t-meta" style={{ marginTop: 4 }}>创建于 {conflict.createdAt.slice(0, 16).replace('T', ' ')}</div>

        <label className="auto">
          <input type="checkbox" checked={autoFollow} onChange={(e) => setAutoFollow(e.target.checked)} />
          <div>
            <div className="t-label">以后这种情况按系统建议自动调整</div>
            <div className="t-meta" style={{ marginTop: 2 }}>随时可以在设置里关掉</div>
          </div>
        </label>

        {error && <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 10 }}>{error}</div>}

        <div className="acts">
          <button className="btn" type="button" disabled={busy} onClick={() => void choose('keep-user')}>
            保持 {d.userText}
          </button>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void choose('take-computed')}>
            改成 {d.computedText}
          </button>
        </div>

        <style>{`
          .mask { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-sheet); }
          .sheet {
            position: fixed; left: 50%; transform: translateX(-50%);
            bottom: calc(var(--nav-h) + 16px); z-index: var(--z-modal);
            width: min(560px, calc(100vw - 32px));
            background: var(--sf); border: 1px solid var(--ln2); border-radius: var(--r-ctl);
            padding: var(--sp-4); box-shadow: var(--shadow-pop);
          }
          .cmp { display: flex; align-items: center; gap: var(--sp-3); margin-top: var(--sp-4); }
          .cmp-cell { flex: 1; padding: 10px 12px; border: 1px solid var(--ln); border-radius: var(--r-ctl); }
          .cmp-new { border: 2px solid var(--t1); }
          .cmp-n { font-size: 17px; font-weight: 600; margin-top: 4px; }
          .cmp-arrow { color: var(--t3); }
          .auto { display: flex; gap: 10px; align-items: flex-start; margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--ln); cursor: pointer; }
          .auto input { margin-top: 3px; }
          .acts { display: flex; gap: var(--sp-2); margin-top: var(--sp-4); }
          .acts .btn { flex: 1; text-align: center; }
        `}</style>
      </div>
    </>
  );
}

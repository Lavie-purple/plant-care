import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeDeviation, isJudgementReliable, STATUS_SHORT, type Deviation } from '../app/deviation.js';
import { computeStats, formatStat, type Range, type WateringStats } from '../app/stats.js';
import { buildDemoData, DEMO_SPECS } from '../app/demoData.js';
import type { CareRule, DecisionLog, Plant, WateringRecord } from '../domain/types.js';
import { STORES } from '../storage/indexeddb.js';
import type { Repository } from '../storage/repository.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface InsightProps {
  service: PlantCareService;
  repo: Repository;
  page: 'judge' | 'habits';
}

/**
 * 判定页与习惯页。
 *
 * 两页共用一次数据加载，但关心的维度不同：
 *   判定 = 每盆在时间轴上的位置
 *   习惯 = 我自己的行为模式
 */
export function Insight({ service, repo, page }: InsightProps) {
  const [plants, setPlants] = useState<Plant[]>([]);
  const [rules, setRules] = useState<Map<string, CareRule>>(new Map());
  const [history, setHistory] = useState<Map<string, WateringRecord[]>>(new Map());
  const [decisions, setDecisions] = useState<DecisionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [range] = useState<Range>(30);

  const load = useCallback(async () => {
    try {
      setError(null);
      const all = await service.listPlants();
      setPlants(all);
      const rmap = new Map<string, CareRule>();
      const hmap = new Map<string, WateringRecord[]>();
      for (const p of all) {
        const rule = await service.careRule(p.id);
        if (rule) rmap.set(p.id, rule);
        hmap.set(p.id, await service.wateringHistory(p.id));
      }
      setRules(rmap);
      setHistory(hmap);
      setDecisions(await service.allDecisions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = service.now();

  const deviations = useMemo(
    () =>
      plants.map((p) =>
        computeDeviation({ plant: p, rule: rules.get(p.id), history: history.get(p.id) ?? [], today }),
      ),
    [plants, rules, history, today],
  );

  async function seedDemo() {
    setBusy(true);
    try {
      const demo = buildDemoData(today);
      for (const p of demo.plants) await repo.put<Plant>(STORES.plants, p);
      for (const r of demo.careRules) await repo.put<CareRule>(STORES.careRules, r);
      for (const w of demo.wateringRecords) await repo.put<WateringRecord>(STORES.wateringRecords, w);
      for (const d of demo.decisionLogs) await repo.recordDecision(d);
      for (const ph of demo.photos) {
        await repo.put(STORES.plantEvents, {
          id: ph.id,
          plantId: ph.plantId,
          type: 'PHOTO',
          date: ph.date,
          title: ph.title,
          images: [],
          metadata: {},
          createdAt: today.toISOString(),
          version: 1,
        });
      }
      await load();
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

  const hasData = plants.length > 0;

  return (
    <div className="insight">
      <header className="ins-top">
        <span className="t-title">{page === 'judge' ? '判定' : '习惯'}</span>
        <span className="t-meta">{plants.length} 盆</span>
      </header>

      {!hasData ? (
        <div className="ins-empty">
          <div className="t-secondary">
            {page === 'judge'
              ? '判定页要看每盆在时间轴上的位置，至少需要 3 次浇水记录才有参考价值。'
              : '习惯页要看你的行为模式，需要几周的记录才有东西可回顾。'}
          </div>
          <div className="t-meta" style={{ marginTop: 8 }}>
            没有真实数据时，可以先生成一批示例数据看功能效果。
          </div>
          <button className="btn btn-primary" type="button" style={{ marginTop: 16, width: '100%' }}
            disabled={busy} onClick={() => void seedDemo()}>
            {busy ? '生成中…' : '生成示例数据'}
          </button>
          <div className="t-meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
            示例数据带「（示例）」标记，页面顶部也会标注。它不是你的真实养护记录。
          </div>
        </div>
      ) : page === 'judge' ? (
        <JudgeList items={deviations} onSeed={seedDemo} busy={busy} />
      ) : (
        <HabitsView
          stats={computeStats({ history: [...history.values()].flat(), decisions, today, range })}
          onSeed={seedDemo}
          busy={busy}
        />
      )}

      <style>{`
        .insight { display: flex; flex-direction: column; }
        .ins-top { position: sticky; top: 0; z-index: var(--z-sticky); display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); background: var(--sf); border-bottom: 1px solid var(--ln); }
        .ins-empty { padding: var(--sp-6) var(--sp-4); text-align: center; }
        .demo-note { margin: var(--sp-3) var(--sp-4); padding: 8px 10px; border: 1px dashed var(--ln2); border-radius: var(--r-ctl); font-size: var(--fs-meta); color: var(--t2); }
        .row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--ln); }
        .rname { flex: 0 0 108px; }
        .track { flex: 1; position: relative; height: 34px; }
        .win { position: absolute; top: 6px; bottom: 6px; border-left: 1px dashed var(--t3); border-right: 1px dashed var(--t3); background: var(--s2); }
        .bar { position: absolute; top: 16px; height: 2px; background: var(--t1); }
        .mark { position: absolute; top: 2px; bottom: 2px; width: 2px; background: var(--acc); }
        .rstate { flex: 0 0 72px; text-align: right; font-size: var(--fs-meta); }
        .st-overdue { color: var(--acc); font-weight: 600; }
        .st-window { color: var(--t1); }
        .st-too_early, .st-no_rule { color: var(--t3); }
        .st-no_record { color: var(--t2); }
        .thin { font-size: var(--fs-meta); color: var(--t3); }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); }
        .card { border: 1px solid var(--ln); border-radius: var(--r-ctl); padding: var(--sp-3); }
        .card .v { font-size: 19px; font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .seg { display: flex; gap: 6px; padding: 0 var(--sp-4) var(--sp-3); }
      `}</style>
    </div>
  );
}

function JudgeList({ items, onSeed, busy }: { items: Deviation[]; onSeed: () => void; busy: boolean }) {
  const hasDemo = items.some((d) => d.name.includes('（示例）'));
  return (
    <>
      {hasDemo && (
        <div className="demo-note">
          列表里带「（示例）」的是生成的演示数据，不是你的真实记录。
        </div>
      )}
      {items.map((d) => {
        const reliable = isJudgementReliable(d);
        return (
          <div className="row" key={d.plantId}>
            <div className="rname">
              <div className="t-label" style={{ fontWeight: 600 }}>{d.name}</div>
              <div className="thin">{d.placement}　{d.daysSince === null ? '尚无记录' : d.daysSince + ' 天'}</div>
              {!reliable && d.basis === 'user_rule' && (
                <div className="thin">已记 {d.sampleCount}/3 次，参考价值有限</div>
              )}
            </div>
            <div className="track">
              {d.basis === 'user_rule' && (
                <div className="win" style={{ left: d.windowStart + '%', width: Math.max(2, d.windowEnd - d.windowStart) + '%' }} />
              )}
              {d.daysSince !== null && (
                <div className="bar" style={{ left: 0, width: d.markPosition + '%' }} />
              )}
              <div className="mark" style={{ left: '100%', transform: 'translateX(-1px)' }} />
            </div>
            <div className={'rstate st-' + d.status}>{STATUS_SHORT[d.status]}</div>
          </div>
        );
      })}
      <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
        <button className="btn" type="button" disabled={busy} onClick={onSeed}>再生成一批示例数据</button>
      </div>
    </>
  );
}

function HabitsView({ stats, onSeed, busy }: { stats: WateringStats; onSeed: () => void; busy: boolean }) {
  return (
    <>
      <div className="grid2">
        <div className="card">
          <div className="v">{stats.wateringCount}</div>
          <div className="thin">浇水次数</div>
        </div>
        <div className="card">
          <div className="v">{formatStat(stats.averageIntervalDays, { unit: ' 天' })}</div>
          <div className="thin">平均间隔</div>
        </div>
        <div className="card">
          <div className="v">{formatStat(stats.averageAmountMl, { unit: ' ml' })}</div>
          <div className="thin">平均水量（{stats.amountSampleCount} 次手填）</div>
        </div>
        <div className="card">
          <div className="v">{formatStat(stats.intervalTrendDays, { unit: ' 天' })}</div>
          <div className="thin">间隔趋势</div>
        </div>
        <div className="card">
          <div className="v">{stats.delayCount}</div>
          <div className="thin">延期</div>
        </div>
        <div className="card">
          <div className="v">{stats.judgedNoNeedCount}</div>
          <div className="thin">我判断不用浇</div>
        </div>
        <div className="card">
          <div className="v">{stats.adherenceRate === undefined ? '样本不足' : Math.round(stats.adherenceRate * 100) + '%'}</div>
          <div className="thin">服从率</div>
        </div>
        <div className="card">
          <div className="v">{stats.estimatedAmountCount}</div>
          <div className="thin">估算水量条数</div>
        </div>
      </div>
      <div className="seg" />
      <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
        <div className="thin">口径：{stats.basis}</div>
        <div className="thin" style={{ marginTop: 8 }}>
          统计只计已补全的记录。待补全的条目不参与，否则会低估你的实际浇水频率。
        </div>
        <button className="btn" type="button" style={{ marginTop: 12 }} disabled={busy} onClick={onSeed}>
          再生成一批示例数据
        </button>
      </div>
    </>
  );
}

export { DEMO_SPECS };

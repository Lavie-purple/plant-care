import { useCallback, useEffect, useState } from 'react';
import { EXPOSURE_DESC, EXPOSURE_LABEL, PLACEMENTS } from '../domain/types.js';
import type { CareRule, DecisionLog, Plant, PlantEvent, WateringMethod, WateringRecord } from '../domain/types.js';
import type { WeatherInput } from '../domain/types.js';
import type { EngineOutput } from '../engine/recommendation.js';
import { computeStats, formatStat, type Range, type WateringStats } from '../app/stats.js';
import { describeSource, isNavigable } from './sourceLabel.js';
import { metaFor } from '../app/eventDraft.js';
import { EventSheet } from './EventSheet.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface PlantDetailProps {
  service: PlantCareService;
  plantId: string;
  onBack: () => void;
}

type Tab = 'overview' | 'records' | 'photos' | 'stats';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'records', label: '记录' },
  { key: 'photos', label: '照片' },
  { key: 'stats', label: '统计' },
];

/** D-06 W 方案：三档快选。点档即提交，不需要二次确认。 */
const QUICK_METHODS: WateringMethod[] = ['浇透', '喷雾', '浸盆'];

export function PlantDetail({ service, plantId, onBack }: PlantDetailProps) {
  const [plant, setPlant] = useState<Plant | null>(null);
  const [rule, setRule] = useState<CareRule | undefined>();
  const [history, setHistory] = useState<WateringRecord[]>([]);
  const [events, setEvents] = useState<PlantEvent[]>([]);
  const [decisions, setDecisions] = useState<DecisionLog[]>([]);
  const [rec, setRec] = useState<EngineOutput | null>(null);
  const [weather, setWeather] = useState<WeatherInput | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<Range>(30);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | 'edit' | 'delete'>(null);
  const [sheet, setSheet] = useState<null | { type: 'PHOTO' | 'OTHER' }>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const p = await service.getPlant(plantId);
      if (!p) {
        setError('这株植物不存在或已被删除');
        return;
      }
      setPlant(p);
      setRule(await service.careRule(plantId));
      setHistory(await service.wateringHistory(plantId));
      setEvents(await service.events(plantId));
      setDecisions(await service.decisions(plantId));
      const w = await service.loadWeather();
      setWeather(w);
      setRec(await service.recommend(plantId, w));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [service, plantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** W 方案：选档即提交，只记时间与方式 */
  async function quickWater(method: WateringMethod) {
    setBusy(true);
    setSaved(null);
    try {
      await service.recordWatering(plantId, { method, entrySource: 'single' });
      setSaved(`已记录：${method}，时间取当前`);
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
        <button className="btn" type="button" onClick={onBack}>← 返回</button>
        <div className="card" style={{ padding: 20, marginTop: 16, borderColor: 'var(--ln2)' }}>
          <div className="t-heading">出错了</div>
          <div className="t-meta" style={{ marginTop: 8 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!plant) return <div className="t-meta" style={{ padding: 24 }}>正在读取…</div>;

  const stats = computeStats({ history, decisions, today: service.now(), range });
  const timeline = events.filter((e) =>
    ['PHOTO', 'NEW_LEAF', 'YELLOW_LEAF', 'FLOWERING', 'FRUITING', 'REPOTTING', 'PRUNING', 'PEST', 'DISEASE'].includes(e.type),
  );

  return (
    <>
    <div className="detail">
      {sheet && (
        <EventSheet
          service={service}
          plantId={plant.id}
          plantName={plant.name}
          {...(sheet.type === 'PHOTO' ? { initialType: 'PHOTO' as const } : {})}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            setSaved('已记录');
            await reload();
          }}
        />
      )}
      <header className="detail-top">
        <button className="btn" type="button" onClick={onBack}>← 返回</button>
        <span className="t-title">{plant.name}</span>
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button className="btn" type="button" onClick={() => setMode('edit')}>编辑</button>
          <button className="btn" type="button" onClick={() => setMode('delete')}>删除</button>
        </div>
      </header>

      {/* T 方案：状态条常驻，滚到哪都在 */}
      {rec && (
        <div className="sticky-status">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-label" style={{ fontWeight: 600 }}>{rec.recommendation.suggestedAction}</div>
            <div className="t-meta">
              信心 {Math.round(rec.recommendation.confidence * 100)}%
              {rec.daysSince !== undefined ? `　·　距上次 ${rec.daysSince} 天` : '　·　尚无记录'}
            </div>
          </div>
        </div>
      )}

      <div className="acts2">
        <button
          className="btn"
          type="button"
          onClick={() => setSheet({ type: 'PHOTO' })}
        >
          拍一张
        </button>
        <button className="btn" type="button" onClick={() => setSheet({ type: 'OTHER' })}>
          记一笔
        </button>
      </div>

      {/* D-06 W 方案：点档即提交 */}
      <section className="quick-water">
        <div className="t-meta" style={{ marginBottom: 8 }}>记一次浇水</div>
        <div className="quick-row">
          {QUICK_METHODS.map((m) => (
            <button
              key={m}
              className="btn quick-btn"
              type="button"
              disabled={busy}
              onClick={() => void quickWater(m)}
            >
              {m}
            </button>
          ))}
        </div>
        {saved && <div className="t-meta saved">{saved}</div>}
      </section>

      <nav className="detail-tabs" aria-label="详情分区">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.key === tab ? 'dt-btn dt-on' : 'dt-btn'}
            aria-current={t.key === tab ? 'page' : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {mode === 'edit' && (
        <EditPanel
          plant={plant}
          onCancel={() => setMode(null)}
          onSave={async (patch) => {
            await service.updatePlant(plant.id, patch as never);
            setMode(null);
            await reload();
          }}
        />
      )}
      {mode === 'delete' && (
        <DeletePanel
          plant={plant}
          counts={{ watering: history.length, events: events.length, decisions: decisions.length }}
          onCancel={() => setMode(null)}
          onConfirm={async () => {
            await service.deletePlant(plant.id);
            onBack();
          }}
        />
      )}
      {mode === null && tab === 'overview' && (
        <Overview plant={plant} rule={rule} rec={rec} weather={weather} history={history} />
      )}
      {mode === null && tab === 'records' && <Records history={history} events={events} />}
      {mode === null && tab === 'photos' && <Photos timeline={timeline} />}
      {mode === null && tab === 'stats' && <Stats stats={stats} range={range} onRange={setRange} />}

      <style>{`
        .detail { display: flex; flex-direction: column; }
        .detail-top {
          position: sticky; top: 0; z-index: var(--z-sticky);
          display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
          padding: var(--sp-3) var(--sp-4); background: var(--sf); border-bottom: 1px solid var(--ln);
        }
        .sticky-status {
          position: sticky; top: 57px; z-index: var(--z-sticky);
          padding: var(--sp-3) var(--sp-4); background: var(--acc-soft); border-bottom: 1px solid var(--ln);
        }
        .acts2 { display: flex; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--ln); }
        .acts2 .btn { flex: 1; }
        .quick-water { padding: var(--sp-4); border-bottom: 1px solid var(--ln); }
        .quick-row { display: flex; gap: var(--sp-2); }
        .quick-btn { flex: 1 1 0; min-width: 0; padding: 14px 0; font-size: var(--fs-heading); font-weight: 600; }
        .saved { margin-top: 8px; color: var(--acc); }
        .detail-tabs { display: flex; border-bottom: 1px solid var(--ln); background: var(--sf); position: sticky; top: 121px; z-index: var(--z-sticky); }
        .dt-btn { flex: 1 1 0; min-width: 0; padding: 10px 0; font-size: var(--fs-label); background: none; border: none; color: var(--t3); border-right: 1px dashed var(--ln); }
        .dt-btn:last-child { border-right: none; }
        .dt-on { color: var(--t1); font-weight: 600; box-shadow: inset 0 -2px 0 var(--acc); }
        .panel { padding: var(--sp-4); }
        .kv { display: flex; padding: 7px 0; border-bottom: 1px solid var(--ln); font-size: var(--fs-label); }
        .kv .k { flex: 0 0 84px; color: var(--t3); }
        .kv .v { flex: 1; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
        .stat { border: 1px solid var(--ln); border-radius: var(--r-ctl); padding: var(--sp-3); }
        .stat .v { font-size: 20px; font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      `}</style>
    </div>
    </>
  );
}

function Overview({
  plant,
  rule,
  rec,
  weather,
  history,
}: {
  plant: Plant;
  rule: CareRule | undefined;
  rec: EngineOutput | null;
  weather: WeatherInput | null;
  history: WateringRecord[];
}) {
  const srcCtx = { plant, history, ...(weather?.available ? { weather: weather.snapshot } : {}) };
  return (
    <div className="panel">
      <div className="t-meta" style={{ marginBottom: 10 }}>档案</div>
      <div className="kv"><span className="k">品种</span><span className="v">{plant.species ?? '未填'}</span></div>
      <div className="kv"><span className="k">科</span><span className="v">{plant.family ?? '未填'}</span></div>
      <div className="kv"><span className="k">位置</span><span className="v">
            {plant.placement}　{EXPOSURE_LABEL[plant.exposure]}
            <span className="t-meta">（{EXPOSURE_DESC[plant.exposure]}）</span>
          </span></div>
      <div className="kv"><span className="k">盆口径</span><span className="v">{plant.potDiameterCm ? `${plant.potDiameterCm} cm` : '未填'}</span></div>
      <div className="kv">
        <span className="k">浇水周期</span>
        <span className="v">
          {rule ? `${rule.recommendedIntervalMin} 到 ${rule.recommendedIntervalMax} 天` : '未设定'}
          {rule?.userOverride ? '（你设的，系统未改）' : ''}
        </span>
      </div>
      <div className="kv"><span className="k">标签</span><span className="v">{plant.tags.length ? plant.tags.join('、') : '无'}</span></div>

      {rec && rec.recommendation.reasons.length > 0 && (
        <>
          <div className="t-meta" style={{ margin: '16px 0 8px' }}>今天的依据</div>
          {rec.recommendation.reasons.map((r) => (
            <div key={r.sourceId + r.text} style={{ padding: '6px 0' }}>
              <div className="t-secondary">{r.text}</div>
              <div className="t-meta">
                来源：{describeSource(r, srcCtx)}
                {isNavigable(r) ? ' · 可点开核对' : ''}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Records({ history, events }: { history: WateringRecord[]; events: PlantEvent[] }) {
  return (
    <div className="panel">
      <div className="t-meta" style={{ marginBottom: 8 }}>浇水记录 · {history.length} 条</div>
      {history.length === 0 && <div className="t-secondary">还没有浇水记录</div>}
      {history.map((h) => (
        <div key={h.id} className="kv">
          <span className="k mono">{h.date.slice(5)}</span>
          <span className="v">
            {h.method}　{h.amountMl ? `${h.amountMl}ml` : '水量未记'}
            {h.amountSource === 'user_provided_baseline' ? '（估算）' : ''}
            {h.completionState === 'pending' ? '　·　待补全' : ''}
          </span>
        </div>
      ))}

      <div className="t-meta" style={{ margin: '20px 0 8px' }}>全部事件 · {events.length} 条</div>
      {events.length === 0 && <div className="t-secondary">还没有事件</div>}
      {events.map((e) => (
        <div key={e.id} className="kv">
          <span className="k mono">{e.date.slice(5)}</span>
          <span className="v">
            {/* 用中文标签，不把枚举值甩给用户 */}
            {metaFor(e.type).label}
            {e.title ? `　${e.title}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function Photos({ timeline }: { timeline: PlantEvent[] }) {
  return (
    <div className="panel">
      <div className="t-meta" style={{ marginBottom: 8 }}>成长时间线 · {timeline.length} 条</div>
      {timeline.length === 0 && (
        <div className="t-secondary">
          还没有照片。随手拍一张就会形成一条记录，不需要固定周期。
        </div>
      )}
      {timeline.map((e) => (
        <div key={e.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--ln)' }}>
          <div className="t-meta mono">{e.date}</div>
          {e.images.length > 0 && (
            <div className="ph-grid">
              {e.images.map((img) => (
                <div key={img} className="imgbox" style={{ height: 88 }}>照片</div>
              ))}
            </div>
          )}
          {e.title && <div className="t-label" style={{ marginTop: 6 }}>{e.title}</div>}
          {e.description && <div className="t-meta" style={{ marginTop: 2 }}>{e.description}</div>}
        </div>
      ))}
      <style>{`
        .ph-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-1); margin-top: 6px; }
      `}</style>
    </div>
  );
}

function Stats({
  stats,
  range,
  onRange,
}: {
  stats: WateringStats;
  range: Range;
  onRange: (r: Range) => void;
}) {
  const RANGES: Range[] = [7, 30, 90];
  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={r === range ? 'chip chip-on' : 'chip'}
            onClick={() => onRange(r)}
          >
            近 {r} 天
          </button>
        ))}
      </div>

      <div className="grid2">
        <div className="stat">
          <div className="v">{stats.wateringCount}</div>
          <div className="t-meta">浇水次数</div>
        </div>
        <div className="stat">
          <div className="v">{formatStat(stats.averageIntervalDays, { unit: ' 天' })}</div>
          <div className="t-meta">平均间隔</div>
        </div>
        <div className="stat">
          <div className="v">{formatStat(stats.averageAmountMl, { unit: 'ml' })}</div>
          <div className="t-meta">平均水量{stats.amountSampleCount > 0 ? `（${stats.amountSampleCount} 次手填）` : ''}</div>
        </div>
        <div className="stat">
          <div className="v">{formatStat(stats.intervalTrendDays, { unit: ' 天' })}</div>
          <div className="t-meta">间隔趋势</div>
        </div>
        <div className="stat">
          <div className="v">{stats.delayCount}</div>
          <div className="t-meta">延期</div>
        </div>
        <div className="stat">
          <div className="v">{stats.skipCount}</div>
          <div className="t-meta">跳过</div>
        </div>
      </div>

      {stats.estimatedAmountCount > 0 && (
        <div className="t-meta" style={{ marginTop: 12 }}>
          另有 {stats.estimatedAmountCount} 条为估算水量（按 18cm 盆 500ml 推算），未计入平均水量
        </div>
      )}
      <div className="t-meta" style={{ marginTop: 8 }}>口径：{stats.basis}</div>
    </div>
  );
}

/**
 * 编辑植物档案。
 *
 * 只提交改动的字段，不传的保持原样 —— 免得打开编辑把没填的清空。
 */
function EditPanel({
  plant,
  onSave,
  onCancel,
}: {
  plant: Plant;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: plant.name,
    species: plant.species ?? '',
    family: plant.family ?? '',
    placement: plant.placement,
    exposure: plant.exposure,
    potDiameterCm: plant.potDiameterCm ? String(plant.potDiameterCm) : '',
    notes: plant.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!form.name.trim()) {
      setErr('名字不能为空');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        name: form.name.trim(),
        ...(form.species.trim() ? { species: form.species.trim() } : {}),
        ...(form.family.trim() ? { family: form.family.trim() } : {}),
        placement: form.placement,
        exposure: form.exposure,
        ...(form.potDiameterCm.trim() ? { potDiameterCm: Number(form.potDiameterCm) } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="t-heading" style={{ marginBottom: 12 }}>编辑档案</div>
      <div className="ap-grid">
        <Field2 label="名字" required>
          <input className="ap-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field2>
        <Field2 label="品种">
          <input className="ap-input" value={form.species} onChange={(e) => setForm({ ...form, species: e.target.value })} />
        </Field2>
        <Field2 label="科">
          <input className="ap-input" value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })} />
        </Field2>
        <Field2 label="盆口径" unit="cm">
          <input className="ap-input num" value={form.potDiameterCm}
            onChange={(e) => setForm({ ...form, potDiameterCm: e.target.value })} />
        </Field2>
        <Field2 label="位置">
          <select className="ap-input" value={form.placement} onChange={(e) => setForm({ ...form, placement: e.target.value as Plant['placement'] })}>
            {PLACEMENTS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field2>
        <Field2 label="暴露度">
          <select className="ap-input" value={form.exposure} onChange={(e) => setForm({ ...form, exposure: e.target.value as Plant['exposure'] })}>
            <option value="indoor">室内</option>
            <option value="indoor_window">室内靠窗</option>
            <option value="semi_outdoor">半户外</option>
            <option value="outdoor">露天</option>
          </select>
        </Field2>
        <Field2 label="备注">
          <input className="ap-input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field2>
      </div>
      {err && <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 8 }} role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 16 }}>
        <button className="btn" type="button" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn btn-primary" type="button" style={{ flex: 1 }} onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/**
 * 删除确认。
 * 必须说清会连带删掉什么，否则用户不敢点，也容易误点。
 */
function DeletePanel({
  plant,
  counts,
  onConfirm,
  onCancel,
}: {
  plant: Plant;
  counts: { watering: number; events: number; decisions: number };
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = confirmText.trim() === plant.name;

  return (
    <div className="panel">
      <div className="t-heading" style={{ marginBottom: 8 }}>删除这盆植物</div>
      <div className="t-secondary">
        「{plant.name}」的以下数据会一起被删除，且无法撤销：
      </div>
      <ul style={{ padding: '8px 0 8px 18px', margin: 0 }}>
        <li className="t-s">{counts.watering} 条浇水记录</li>
        <li className="t-s">{counts.events} 条事件与照片引用</li>
        <li className="t-s">{counts.decisions} 条决定日志</li>
        <li className="t-s">它的养护规则</li>
      </ul>
      <div className="t-s" style={{ marginTop: 8 }}>
        输入 <b style={{ color: 'var(--t1)' }}>{plant.name}</b> 以确认：
      </div>
      <input className="ap-input" style={{ marginTop: 6 }} value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)} aria-label="输入植物名以确认删除" />
      {err && <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 8 }} role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 16 }}>
        <button className="btn" type="button" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn" type="button" style={{ flex: 1 }} disabled={!ready || busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void onConfirm().catch((e) => {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            });
          }}>
          {busy ? '删除中…' : '确认删除'}
        </button>
      </div>
    </div>
  );
}

function Field2({ label, children, unit, required }: { label: string; children: React.ReactNode; unit?: string; required?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label className="t-label" style={{ display: 'block', marginBottom: 5, color: 'var(--t2)' }}>
        {label}
        {required ? <span style={{ color: 'var(--t3)' }}>　必填</span> : null}
        {unit ? <span className="t-meta" style={{ marginLeft: 6 }}>单位 {unit}</span> : null}
      </label>
      {children}
    </div>
  );
}

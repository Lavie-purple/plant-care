import { useCallback, useEffect, useMemo, useState } from 'react';
import { EXPOSURE_LABEL, PLACEMENTS, type Action, type Plant } from '../domain/types.js';
import type { WeatherInput } from '../domain/types.js';
import type { EngineOutput } from '../engine/recommendation.js';
import {
  ACTION_ORDER,
  ATTENTION_ACTIONS,
  EMPTY_FILTERS,
  EXPOSURE_FILTERS,
  activeFilterCount,
  applyFilters,
  clearAll,
  toggleInArray,
  type FilterablePlant,
  type FilterState,
} from '../app/filters.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface PlantsProps {
  service: PlantCareService;
  onOpenPlant: (plantId: string) => void;
  onAddPlant: () => void;
  /** 父层在数据可能变化时递增（添加完成、详情返回等），本页据此重取列表。
   *  不传则只在挂载时取一次。 */
  refreshKey?: number;
}

type View = 'card' | 'wall' | 'list';

const VIEW_LABEL: Record<View, string> = { card: '卡片', wall: '照片墙', list: '列表' };

const ACTION_LABEL: Record<Action, string> = {
  WATER_NOW: '今天浇水',
  CHECK: '先看盆土',
  DELAY: '建议延后',
  NO_ACTION: '无需处理',
};

const ACTION_SHORT: Record<Action, string> = {
  WATER_NOW: '浇水',
  CHECK: '检查',
  DELAY: '延后',
  NO_ACTION: '—',
};

export function Plants({ service, onOpenPlant, onAddPlant, refreshKey = 0 }: PlantsProps) {
  const [items, setItems] = useState<FilterablePlant[]>([]);
  const [weather, setWeather] = useState<WeatherInput | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<View>('card');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<'delete' | 'move' | null>(null);

  const load = useCallback(async () => {
    // 两个阶段，故意不把天气放在植物前面：
    // 之前先等 loadWeather()，天气请求挂住（网络差时重试最长约 20 秒）
    // 会把整个列表卡在初始空态——界面上显示「还没有植物」，数据其实都在。
    // 现在植物列表先渲染（判定列先显示 —），天气回来后再补判定。
    setError(null);
    let plants: Plant[];
    const base: FilterablePlant[] = [];
    try {
      plants = await service.listPlants();
      for (const plant of plants) {
        const history = await service.wateringHistory(plant.id);
        const rule = await service.careRule(plant.id);
        base.push({
          plant,
          action: undefined,
          daysSince: undefined,
          hasCareRule: Boolean(rule),
          maxInterval: rule?.recommendedIntervalMax,
          wateringCount: history.filter((x) => x.completionState === 'complete').length,
          pendingCount: history.filter((x) => x.completionState === 'pending').length,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setItems(base);
    // 阶段二：天气与判定。天气失败不报错（loadWeather 自带降级），
    // 也不清空已渲染的列表。
    try {
      const w = await service.loadWeather();
      setWeather(w);
      const out: FilterablePlant[] = [];
      for (const plant of plants) {
        const rec: EngineOutput = await service.recommend(plant.id, w);
        const prev = base.find((x) => x.plant.id === plant.id);
        out.push({
          ...(prev ?? { plant, hasCareRule: false, maxInterval: undefined, wateringCount: 0, pendingCount: 0 }),
          action: rec.recommendation.action,
          daysSince: rec.daysSince,
        });
      }
      setItems(out);
    } catch (e) {
      // 判定拿不到时保留列表本体，只是没有建议列。
      console.warn('判定刷新失败', e);
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const filtered = useMemo(() => {
    const r = applyFilters(items, filters);
    return [...r].sort((a, b) => {
      // 有建议的排前面，再按建议顺序，再按名称
      const ao = a.action ? ACTION_ORDER[a.action] : 9;
      const bo = b.action ? ACTION_ORDER[b.action] : 9;
      if (ao !== bo) return ao - bo;
      return a.plant.name.localeCompare(b.plant.name, 'zh-CN');
    });
  }, [items, filters]);

  const count = activeFilterCount(filters);

  function toggleSel(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
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

  return (
    <div className="plants">
      <header className="p-top">
        <span className="t-title">我的植物</span>
        <div className="p-top-right">
          <span className="t-meta num">
            {count > 0 ? `筛选出 ${filtered.length} / ${items.length} 盆` : `${items.length} 盆`}
          </span>
          {/* 全局唯一的新建入口。放在顶栏而不是内容流末尾，
              否则列表模式下它会挤在表格和筛选之间，位置很怪。 */}
          <button className="btn btn-primary" type="button" onClick={onAddPlant}>＋ 添加</button>
        </div>
      </header>

      <div className="p-search">
        <input
          className="p-input"
          type="search"
          value={filters.search}
          placeholder="搜索名称、品种、科、属、标签"
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          aria-label="搜索植物"
        />
      </div>

      {/* 4 个高频 chip 常驻，其余收进抽屉 */}
      <div className="p-chips">
        <button
          type="button"
          className={filters.actions.length === ATTENTION_ACTIONS.length ? 'chip chip-on' : 'chip'}
          onClick={() =>
            setFilters((f) => ({
              ...f,
              actions: f.actions.length === ATTENTION_ACTIONS.length ? [] : [...ATTENTION_ACTIONS],
            }))
          }
        >
          今天要处理
        </button>
        {EXPOSURE_FILTERS.slice(0, 2).map((e) => (
          <button
            key={e.key}
            type="button"
            className={filters.exposures.includes(e.key) ? 'chip chip-on' : 'chip'}
            onClick={() => setFilters((f) => ({ ...f, exposures: toggleInArray(f.exposures, e.key) }))}
          >
            {e.label}
          </button>
        ))}
        <button
          type="button"
          className={filters.record === 'has_pending' ? 'chip chip-on' : 'chip'}
          onClick={() => setFilters((f) => ({ ...f, record: f.record === 'has_pending' ? null : 'has_pending' }))}
        >
          待补全
        </button>
        <button type="button" className="chip" onClick={() => setShowMore(true)}>
          ＋更多{count > 0 ? `（${count}）` : ''}
        </button>
        {count > 0 && (
          <button type="button" className="chip" onClick={() => setFilters(clearAll())}>
            清除
          </button>
        )}
      </div>

      <div className="p-views" role="tablist" aria-label="浏览模式">
        {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={v === view}
            className={v === view ? 'pv-on' : ''}
            onClick={() => setView(v)}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {view === 'list' && (
        <div className="p-bulk">
          <label className="p-check">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === filtered.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((x) => x.plant.id)) : new Set())}
            />
            <span className="t-label">全选当前 {filtered.length} 盆</span>
          </label>
          {selected.size > 0 && (
            <div className="p-bulk-actions" role="toolbar" aria-label="批量操作">
              <span className="t-meta">已选 {selected.size} 盆</span>
              <button className="btn" type="button" onClick={() => setBatch('move')}>改位置</button>
              <button className="btn" type="button" onClick={() => setBatch('delete')}>删除所选</button>
              <button className="btn" type="button" onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
          )}
        </div>
      )}

      {view === 'card' && (
        <div className="p-grid p-grid-2">
          {filtered.map((it) => (
            <PlantCard key={it.plant.id} it={it} onOpen={onOpenPlant} />
          ))}
        </div>
      )}

      {view === 'wall' && (
        <div className="p-grid p-grid-4">
          {filtered.map((it) => (
            <PlantCard key={it.plant.id} it={it} onOpen={onOpenPlant} wall />
          ))}
        </div>
      )}

      {view === 'list' && (
        <div className="p-table-wrap">
          <table className="p-table">
            <thead>
              <tr>
                <th scope="col" className="w-check" />
                <th scope="col">名称</th>
                <th scope="col">品种</th>
                <th scope="col">位置</th>
                <th scope="col" className="w-num">距上次</th>
                <th scope="col">今日</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.plant.id}>
                  <td className="w-check">
                    <input
                      type="checkbox"
                      checked={selected.has(it.plant.id)}
                      onChange={() => toggleSel(it.plant.id)}
                      aria-label={`选择 ${it.plant.name}`}
                    />
                  </td>
                  <td>
                    <button type="button" className="p-link" onClick={() => onOpenPlant(it.plant.id)}>
                      {it.plant.name}
                    </button>
                  </td>
                  <td className="t-secondary">{it.plant.species ?? '未填'}</td>
                  <td className="t-secondary">
                    {it.plant.placement}　{EXPOSURE_LABEL[it.plant.exposure]}
                  </td>
                  <td className="num t-secondary">{it.daysSince === undefined ? '尚无记录' : `${it.daysSince} 天`}</td>
                  <td>
                    <span className={it.action ? `badge badge-${it.action.toLowerCase()}` : 't-meta'}>
                      {it.action ? ACTION_SHORT[it.action] : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="p-empty">
          <div className="t-secondary">
            {items.length === 0 ? '还没有植物。点右上角「＋ 添加」建第一盆。' : '没有符合筛选条件的植物。'}
          </div>
        </div>
      )}

      {batch === 'delete' && selected.size > 0 && (
        <BatchDeletePanel
          service={service}
          plants={items.filter((x) => selected.has(x.plant.id)).map((x) => x.plant)}
          onDone={async () => {
            setBatch(null);
            setSelected(new Set());
            await load();
          }}
        />
      )}
      {batch === 'move' && selected.size > 0 && (
        <BatchMovePanel
          service={service}
          plants={items.filter((x) => selected.has(x.plant.id)).map((x) => x.plant)}
          onDone={async () => {
            setBatch(null);
            setSelected(new Set());
            await load();
          }}
          onCancel={() => setBatch(null)}
        />
      )}

      {showMore && (
        <MoreFilters
          f={filters}
          onChange={setFilters}
          onClose={() => setShowMore(false)}
        />
      )}

      <style>{`
        .plants { display: flex; flex-direction: column; }
        .p-top { position: sticky; top: 0; z-index: var(--z-sticky); display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); background: var(--sf); border-bottom: 1px solid var(--ln); }
        .p-top-right { display: flex; align-items: center; gap: 10px; }
        .p-search { padding: var(--sp-3) var(--sp-4) var(--sp-2); }
        .p-input { width: 100%; border: 1px solid var(--ln2); border-radius: var(--r-ctl); background: var(--sf); color: var(--t1); padding: 8px 10px; font-size: var(--fs-label); font-family: inherit; }
        .p-input::placeholder { color: var(--t3); }
        .p-chips { display: flex; gap: 6px; overflow-x: auto; padding: 0 var(--sp-4) var(--sp-3); }
        .p-views { display: flex; border: 1px solid var(--ln2); border-radius: var(--r-ctl); margin: 0 var(--sp-4) var(--sp-3); overflow: hidden; }
        .p-views button { flex: 1 1 0; min-width: 0; padding: 7px 0; font-size: var(--fs-label); background: var(--sf); border: none; border-right: 1px solid var(--ln); color: var(--t2); }
        .p-views button:last-child { border-right: none; }
        .pv-on { background: var(--acc) !important; color: var(--acc-fg) !important; font-weight: 600; }
        .p-bulk { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-4) var(--sp-2); }
        .p-bulk-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .p-bulk-actions .btn { padding: 4px 10px; font-size: var(--fs-meta); }
        .p-check { display: flex; align-items: center; gap: 6px; }
        .p-grid { display: grid; gap: var(--sp-3); padding: 0 var(--sp-4) var(--sp-4); }
        /* 列数按容器实际宽度自动算，不写死断点。
           卡片视图每格不窄于 200px（太窄看不清植物状态），
           照片墙每格不窄于 96px（够认出一张照片）。
           这样 5K 屏自然是 7 列，1440 是 5 列，手机是 2 列。 */
        /* min() 下限让窄屏能退回小卡片。
           写死 200px 的话，390 宽的手机只排得下 1 列，反而不如两列紧凑。 */
        .p-grid-2 { grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr)); }
        .p-grid-4 { grid-template-columns: repeat(auto-fill, minmax(min(84px, 100%), 1fr)); gap: var(--sp-1); }
        .pcard { border: 1px solid var(--ln); background: var(--sf); border-radius: var(--r-ctl); overflow: hidden; text-align: left; padding: 0; color: var(--t1); width: 100%; }
        .pcard-due { border: 2px solid var(--t1); }
        .pcard-check { border: 1px dashed var(--ln2); }
        .pcard-rest { opacity: 0.5; }
        .pcard .ph { aspect-ratio: 4 / 3; background: var(--s2); border-bottom: 1px solid var(--ln); display: flex; align-items: center; justify-content: center; font-size: 9px; color: var(--t3); }
        /* 照片墙用正方形比例。写死像素高度会在宽屏下把格子拉变形。 */
        .p-grid-4 .pcard .ph { aspect-ratio: 1 / 1; }
        .pcard .body { padding: 7px 8px 9px; }
        .p-grid-4 .pcard .body { padding: 4px; }
        .p-table-wrap { overflow-x: auto; padding: 0 var(--sp-4) var(--sp-4); }
        .p-table { width: 100%; border-collapse: collapse; font-size: var(--fs-label); }
        .p-table th { text-align: left; font-weight: 400; color: var(--t3); font-size: var(--fs-meta); padding: 6px 8px; border-bottom: 1px solid var(--ln); white-space: nowrap; }
        .p-table td { padding: 8px; border-bottom: 1px solid var(--ln); white-space: nowrap; }
        .w-check { width: 28px; }
        .w-num { text-align: right; }
        .p-link { background: none; border: none; padding: 0; color: var(--t1); font-weight: 600; font-size: var(--fs-label); text-align: left; }
        .p-link:hover { text-decoration: underline; }
        .badge { font-size: var(--fs-meta); border: 1px solid var(--ln2); border-radius: var(--r-chip); padding: 1px 8px; white-space: nowrap; }
        .badge-water_now { border-color: var(--t1); color: var(--t1); font-weight: 600; }
        .p-empty { padding: var(--sp-5) var(--sp-4); text-align: center; }
        .add-btn { padding: 5px 12px; }
        .sheet-mask { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-sheet); }
        .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: var(--z-modal); background: var(--sf); border-top: 1px solid var(--ln2); max-height: 76dvh; overflow-y: auto; padding: var(--sp-4); }
        .sheet h3 { font-size: var(--fs-title); margin-bottom: var(--sp-3); }
        .sheet h4 { font-size: var(--fs-label); color: var(--t2); margin: var(--sp-4) 0 var(--sp-2); }
        .sheet .row { display: flex; gap: 6px; flex-wrap: wrap; }
      `}</style>
    </div>
  );
}

function PlantCard({
  it,
  onOpen,
  wall,
}: {
  it: FilterablePlant;
  onOpen: (id: string) => void;
  wall?: boolean;
}) {
  const cls = it.action
    ? it.action === 'WATER_NOW'
      ? 'pcard pcard-due'
      : 'pcard pcard-check'
    : 'pcard pcard-rest';
  return (
    <button type="button" className={cls} onClick={() => onOpen(it.plant.id)}>
      <div className="ph">主图</div>
      <div className="body">
        <div className="t-label" style={{ fontWeight: 600 }}>{it.plant.name}</div>
        {!wall && (
          <>
            <div className="t-meta" style={{ marginTop: 2 }}>
              {it.plant.species ?? '未填品种'}　{it.plant.placement}
            </div>
            <div className="t-meta num" style={{ marginTop: 4 }}>
              {it.daysSince === undefined ? '尚无记录' : `${it.daysSince} 天`}
              {it.action ? `　${ACTION_SHORT[it.action]}` : ''}
            </div>
          </>
        )}
      </div>
    </button>
  );
}

function MoreFilters({
  f,
  onChange,
  onClose,
}: {
  f: FilterState;
  onChange: (f: FilterState) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="sheet-mask" onClick={onClose} role="presentation" />
      <div className="sheet" role="dialog" aria-label="更多筛选">
        <h3>筛选</h3>

        <h4>今日建议</h4>
        <div className="row">
          {(Object.keys(ACTION_LABEL) as Action[]).map((a) => (
            <button
              key={a}
              type="button"
              className={f.actions.includes(a) ? 'chip chip-on' : 'chip'}
              onClick={() => onChange({ ...f, actions: toggleInArray(f.actions, a) })}
            >
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>

        <h4>暴露度</h4>
        <div className="row">
          {EXPOSURE_FILTERS.map((e) => (
            <button
              key={e.key}
              type="button"
              className={f.exposures.includes(e.key) ? 'chip chip-on' : 'chip'}
              onClick={() => onChange({ ...f, exposures: toggleInArray(f.exposures, e.key) })}
            >
              {e.label}
            </button>
          ))}
        </div>

        <h4>位置</h4>
        <div className="row">
          {['客厅', '阳台', '卧室', '书房', '厨房', '卫生间', '玄关', '庭院', '办公室', '其他'].map((p) => (
            <button
              key={p}
              type="button"
              className={f.placements.includes(p as never) ? 'chip chip-on' : 'chip'}
              onClick={() => onChange({ ...f, placements: toggleInArray(f.placements, p as never) })}
            >
              {p}
            </button>
          ))}
        </div>

        <h4>记录状态</h4>
        <div className="row">
          {([
            ['has_record', '有浇水记录'],
            ['never_watered', '从未浇水'],
            ['has_pending', '有待补全'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={f.record === k ? 'chip chip-on' : 'chip'}
              onClick={() => onChange({ ...f, record: f.record === k ? null : k })}
            >
              {label}
            </button>
          ))}
        </div>

        <h4>养护规则</h4>
        <div className="row">
          {([
            ['has_rule', '已设周期'],
            ['no_rule', '未设周期'],
            ['overdue', '已超期'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={f.rule === k ? 'chip chip-on' : 'chip'}
              onClick={() => onChange({ ...f, rule: f.rule === k ? null : k })}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onChange(clearAll())}>
            清除全部
          </button>
          <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 批量删除：逐盆确认，不提供「一键全删」。
 * 单盆删除用「输入名字」当闸门；批量要是省掉它，一次滑手
 * 就比误删一盆贵得多。每删完一盆立即落库，中途反悔的代价只有没删的那些。
 */
function BatchDeletePanel({
  service,
  plants,
  onDone,
}: {
  service: PlantCareService;
  plants: Plant[];
  /** 所有出口都走这里：面板结束时父层刷新列表并清空选择 */
  onDone: () => Promise<void> | void;
}) {
  const [queue, setQueue] = useState<Plant[]>(plants);
  const [counts, setCounts] = useState<{ watering: number; events: number; decisions: number } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = queue[0];
  const doneCount = plants.length - queue.length;

  useEffect(() => {
    setCounts(null);
    setConfirmText('');
    setErr(null);
    if (!current) return;
    let alive = true;
    void (async () => {
      try {
        const [history, events, decisions] = await Promise.all([
          service.wateringHistory(current.id),
          service.events(current.id),
          service.decisions(current.id),
        ]);
        if (alive) setCounts({ watering: history.length, events: events.length, decisions: decisions.length });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [current, service]);

  function finish() {
    void onDone();
  }

  /** 确认删除当前盆，或跳过它。两者都推进队列；队列空了面板结束 */
  async function advance(deleteIt: boolean) {
    if (!current) return;
    if (deleteIt) {
      setBusy(true);
      setErr(null);
      try {
        await service.deletePlant(current.id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const rest = queue.slice(1);
    setQueue(rest);
    if (rest.length === 0) finish();
  }

  if (!current) return null;

  return (
    <>
      <div className="sheet-mask" onClick={finish} role="presentation" />
      <div className="sheet" role="dialog" aria-label="批量删除">
        <h3>
          批量删除（第 {doneCount + 1} / {plants.length} 盆）
        </h3>
        <div className="t-secondary">
          「{current.name}」的以下数据会一起被删除，且无法撤销：
        </div>
        <ul style={{ padding: '8px 0 8px 18px', margin: 0 }}>
          <li className="t-s">{counts ? `${counts.watering} 条浇水记录` : '…'}</li>
          <li className="t-s">{counts ? `${counts.events} 条事件与照片引用` : '…'}</li>
          <li className="t-s">{counts ? `${counts.decisions} 条决定日志` : '…'}</li>
          <li className="t-s">它的养护规则</li>
        </ul>
        <div className="t-s" style={{ marginTop: 8 }}>
          输入 <b style={{ color: 'var(--t1)' }}>{current.name}</b> 以确认删除这一盆：
        </div>
        <input
          className="ap-input"
          style={{ marginTop: 6 }}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          aria-label="输入植物名以确认删除"
        />
        {err && (
          <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 8 }} role="alert">
            {err}
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={finish}>
            结束（还剩 {queue.length - 1} 盆不删）
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void advance(false)}>
            跳过这盆
          </button>
          <button
            className="btn"
            type="button"
            disabled={confirmText.trim() !== current.name || busy}
            onClick={() => void advance(true)}
          >
            {busy ? '删除中…' : '确认删除这一盆'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 批量改位置。改位置不是破坏性操作，不用逐盆确认；
 * 但乐观锁冲突只该影响个别盆——逐盆记结果，最后给汇总。
 */
function BatchMovePanel({
  service,
  plants,
  onDone,
  onCancel,
}: {
  service: PlantCareService;
  plants: Plant[];
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [placement, setPlacement] = useState<Plant['placement']>(plants[0]?.placement ?? '客厅');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: number; failures: Array<{ name: string; reason: string }> } | null>(null);

  async function apply() {
    setBusy(true);
    setErr(null);
    let ok = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    for (const p of plants) {
      try {
        await service.updatePlant(p.id, { placement });
        ok += 1;
      } catch (e) {
        // 失败原因必须可诊断，不能吞成「失败 N 盆」
        failures.push({ name: p.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    setBusy(false);
    setResult({ ok, failures });
  }

  return (
    <>
      <div className="sheet-mask" onClick={onCancel} role="presentation" />
      <div className="sheet" role="dialog" aria-label="批量改位置">
        <h3>批量改位置（{plants.length} 盆）</h3>
        <div className="t-secondary">
          把这 {plants.length} 盆移到同一个位置：
          {plants.map((p) => p.name).join('、')}
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="t-label" style={{ display: 'block', marginBottom: 5, color: 'var(--t2)' }}>
            新位置
          </label>
          <select
            className="ap-input"
            value={placement}
            onChange={(e) => setPlacement(e.target.value as Plant['placement'])}
            aria-label="新位置"
          >
            {PLACEMENTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {result && (
          <div className="t-label" style={{ marginTop: 12 }} role="status">
            已移动 {result.ok} 盆
            {result.failures.length > 0 ? `，${result.failures.length} 盆失败：${result.failures.map((f) => `${f.name}（${f.reason}）`).join('；')}` : ''}。
          </div>
        )}
        {err && (
          <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 8 }} role="alert">
            {err}
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 16 }}>
          {result ? (
            <button className="btn btn-primary" type="button" style={{ flex: 1 }} onClick={() => void onDone()}>
              完成
            </button>
          ) : (
            <>
              <button className="btn" type="button" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button className="btn btn-primary" type="button" style={{ flex: 1 }} disabled={busy} onClick={() => void apply()}>
                {busy ? '移动中…' : '应用'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

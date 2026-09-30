import { useCallback, useEffect, useMemo, useState } from 'react';
import { EXPOSURE_LABEL, type Action, type Plant } from '../domain/types.js';
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

export function Plants({ service, onOpenPlant, onAddPlant }: PlantsProps) {
  const [items, setItems] = useState<FilterablePlant[]>([]);
  const [weather, setWeather] = useState<WeatherInput | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<View>('card');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const w = await service.loadWeather();
      setWeather(w);
      const plants = await service.listPlants();
      const out: FilterablePlant[] = [];
      for (const plant of plants) {
        const history = await service.wateringHistory(plant.id);
        const rule = await service.careRule(plant.id);
        const rec: EngineOutput = await service.recommend(plant.id, w);
        out.push({
          plant,
          action: rec.recommendation.action,
          daysSince: rec.daysSince,
          hasCareRule: Boolean(rule),
          maxInterval: rule?.recommendedIntervalMax,
          wateringCount: history.filter((x) => x.completionState === 'complete').length,
          pendingCount: history.filter((x) => x.completionState === 'pending').length,
        });
      }
      setItems(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

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
            <span className="t-meta">已选 {selected.size} 盆</span>
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
        .p-check { display: flex; align-items: center; gap: 6px; }
        .p-grid { display: grid; gap: var(--sp-3); padding: 0 var(--sp-4) var(--sp-4); }
        .p-grid-2 { grid-template-columns: 1fr 1fr; }
        .p-grid-4 { grid-template-columns: repeat(4, 1fr); gap: var(--sp-1); }
        .pcard { border: 1px solid var(--ln); background: var(--sf); border-radius: var(--r-ctl); overflow: hidden; text-align: left; padding: 0; color: var(--t1); width: 100%; }
        .pcard-due { border: 2px solid var(--t1); }
        .pcard-check { border: 1px dashed var(--ln2); }
        .pcard-rest { opacity: 0.5; }
        .pcard .ph { height: 96px; background: var(--s2); border-bottom: 1px solid var(--ln); display: flex; align-items: center; justify-content: center; font-size: 9px; color: var(--t3); }
        .p-grid-4 .pcard .ph { height: 62px; }
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

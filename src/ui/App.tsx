import { useState } from 'react';
import { Today } from './Today.js';
import { PlantDetail } from './PlantDetail.js';
import { Plants } from './Plants.js';
import { CompleteQueue } from './CompleteQueue.js';
import type { PlantCareService } from '../app/vertical-slice.js';

const PAGES = [
  { key: 'today', label: '今日' },
  { key: 'judge', label: '判定' },
  { key: 'plants', label: '植物' },
  { key: 'habits', label: '习惯' },
] as const;

type PageKey = (typeof PAGES)[number]['key'];

export function App({ service }: { service: PlantCareService }) {
  const [page, setPage] = useState<PageKey>('today');
  // 详情页是 Today 页的下钻，不占用主导航位
  const [detailId, setDetailId] = useState<string | null>(null);
  const [inQueue, setInQueue] = useState(false);

  return (
    <div className="app">
      <main className="app-main">
        {inQueue && <CompleteQueue service={service} onDone={() => { setInQueue(false); }} />}
        {!inQueue && detailId && (
          <PlantDetail service={service} plantId={detailId} onBack={() => setDetailId(null)} />
        )}
        {!inQueue && !detailId && page === 'today' && (
          <Today service={service} onOpenPlant={(id) => setDetailId(id)} onOpenQueue={() => setInQueue(true)} />
        )}
        {!detailId && page === 'plants' && <Plants service={service} onOpenPlant={(id) => setDetailId(id)} />}
        {!detailId && page !== 'today' && page !== 'plants' && (
          <div style={{ padding: 24 }}>
            <div className="t-title">{PAGES.find((p) => p.key === page)?.label}</div>
            <div className="t-secondary" style={{ marginTop: 8 }}>
              这一页还没做。当前已完成：今日养护、我的植物、植物详情。
            </div>
          </div>
        )}
      </main>

      <nav className="app-nav" aria-label="主导航">
        {PAGES.map((p) => (
          <button
            key={p.key}
            type="button"
            className={p.key === page ? 'nav-btn nav-on' : 'nav-btn'}
            aria-current={p.key === page ? 'page' : undefined}
            onClick={() => setPage(p.key)}
          >
            {p.label}
          </button>
        ))}
      </nav>

      <style>{`
        .app { display: flex; flex-direction: column; min-height: 100dvh; }
        .app-main { flex: 1; }
        .app-nav {
          position: sticky; bottom: 0; z-index: var(--z-sticky);
          display: flex; background: var(--sf); border-top: 1px solid var(--ln);
        }
        .nav-btn {
          flex: 1 1 0; min-width: 0; padding: 12px 0; white-space: nowrap; font-size: var(--fs-label);
          background: none; border: none; color: var(--t3);
          transition: color var(--d-1) var(--e);
        }
        .nav-btn:hover { color: var(--t2); }
        .nav-on { color: var(--t1); font-weight: 600; box-shadow: inset 0 2px 0 var(--acc); }
      `}</style>
    </div>
  );
}

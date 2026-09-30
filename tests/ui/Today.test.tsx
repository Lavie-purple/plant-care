/**
 * Today 页面组件测试。
 *
 * 界面层的验证不靠「看起来对」，而是断言用户实际能看到的文本与可操作元素。
 * 这里用 vitest + jsdom + Testing Library。
 *
 * 注意：核心逻辑（分组、建议判定）已在 batches.test.ts 与 engine.test.ts 中验证，
 * 组件测试只关心「界面有没有把核心逻辑的结果正确呈现出来」。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { Today } from '../../src/ui/Today.js';
import { Repository } from '../../src/storage/repository.js';
import { setDatabaseName } from '../../src/storage/indexeddb.js';
import { PlantCareService, fixedClock } from '../../src/app/vertical-slice.js';
import { MockWeatherProvider, SCENARIOS } from '../../src/weather/mock.js';

let seq = 0;
const openRepos: Repository[] = [];

afterEach(() => {
  // 必须 cleanup，否则上一个用例的 DOM 残留，页面会出现两个同名元素
  cleanup();
  while (openRepos.length) openRepos.pop()?.close();
  vi.restoreAllMocks();
});

async function setup(scenario = SCENARIOS.mild, failWeather = false) {
  seq += 1;
  setDatabaseName(`ui-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(scenario);
  if (failWeather) weather.setFailure('模拟断网');
  const svc = new PlantCareService(repo, weather, fixedClock('2026-09-30T14:32:00+08:00'));
  return { repo, svc };
}

async function seedOverdue(svc: PlantCareService, name: string, daysAgo: number, interval: [number, number]) {
  const plant = await svc.addPlant({ name, placement: '客厅', exposure: 'indoor_window', potDiameterCm: 18 });
  await svc.setCareRule(plant.id, interval[0], interval[1]);
  const base = new Date('2026-09-30T14:32:00+08:00');
  base.setDate(base.getDate() - daysAgo);
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  await svc.recordWatering(plant.id, { date: `${base.getFullYear()}-${m}-${d}`, time: '14:20' });
  return plant;
}

describe('Today 页面：把 N 次决策压成批次', () => {
  test('首屏第一句就是今天要处理几盆', async () => {
    const { svc } = await setup();
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);

    await waitFor(() => {
      expect(screen.getByText(/今天 1 盆要处理/)).toBeTruthy();
    });
  });

  test('超期植物落在「今天浇水」批次里', async () => {
    const { svc } = await setup(SCENARIOS.hotDry);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);

    const heading = await screen.findByRole('heading', { name: '今天浇水' });
    expect(heading).toBeTruthy();
    expect(screen.getByText('龟背竹 A')).toBeTruthy();
  });

  test('无需处理的植物不显示浇水按钮', async () => {
    const { svc } = await setup();
    // 1 天前浇过，周期 7-10 → NO_ACTION
    await seedOverdue(svc, '龟背竹 A', 1, [7, 10]);

    render(<Today service={svc} />);

    await screen.findByRole('heading', { name: '无需处理' });
    const section = screen.getByRole('region', { name: '无需处理' });
    expect(within(section).queryByRole('button', { name: '浇水' })).toBeNull();
  });

  test('批次的共同依据只显示一次', async () => {
    const { svc } = await setup(SCENARIOS.hotDry);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);
    await seedOverdue(svc, '龟背竹 B', 12, [7, 10]);

    render(<Today service={svc} />);

    await screen.findByRole('heading', { name: '今天浇水' });
    // 两盆共享同一次天气快照，批头应有一条共同依据
    const section = screen.getByRole('region', { name: '今天浇水' });
    expect(within(section).getAllByText(/共同依据/).length).toBe(1);
  });

  test('点「为什么」展开依据，每条都带来源', async () => {
    const { svc } = await setup(SCENARIOS.hotDry);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);

    const user = userEvent.setup();
    const whyBtn = await screen.findByRole('button', { name: '为什么' });
    expect(whyBtn.getAttribute('aria-expanded')).toBe('false');
    await user.click(whyBtn);

    await waitFor(() => {
      expect(whyBtn.getAttribute('aria-expanded')).toBe('true');
    });
    // 一条依据一个来源，可能有多条，用 getAllByText
    const sources = screen.getAllByText(/来源：/);
    expect(sources.length).toBeGreaterThan(0);
    // 依据必须可追溯到具体实体，这是 D-13 铁律的界面体现
    for (const s of sources) {
      expect(s.textContent).toMatch(/来源：\S+/);
    }
  });

  test('批量浇水产生多条独立记录，而不是一条批次记录', async () => {
    const { svc, repo } = await setup(SCENARIOS.hotDry);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);
    await seedOverdue(svc, '龟背竹 B', 12, [7, 10]);

    render(<Today service={svc} />);

    const user = userEvent.setup();
    const batchBtn = await screen.findByRole('button', { name: /2 盆都浇完了/ });
    await user.click(batchBtn);

    await waitFor(async () => {
      const plants = await repo.allPlants();
      let total = 0;
      for (const p of plants) total += (await repo.wateringHistory(p.id)).length;
      // 每盆原本 1 条，批量后各 +1
      expect(total).toBe(4);
    });
  });

  test('批量入口的记录进补录队列', async () => {
    const { svc, repo } = await setup(SCENARIOS.hotDry);
    const plant = await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /1 盆都浇完了/ }));

    await waitFor(async () => {
      const history = await repo.wateringHistory(plant.id);
      const latest = history[0];
      expect(latest?.completionState).toBe('pending');
      expect(latest?.entrySource).toBe('bulk');
    });
  });
});

describe('诚实性：不可用的东西必须显示为不可用', () => {
  test('天气不可用时页面顶部明确告知', async () => {
    const { svc } = await setup(SCENARIOS.mild, true);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);

    await waitFor(
      () => {
        expect(screen.getAllByText(/天气数据暂不可用/).length).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
  });

  test('天气不可用时仍然给出建议（核心功能不依赖天气服务）', async () => {
    const { svc } = await setup(SCENARIOS.mild, true);
    await seedOverdue(svc, '龟背竹 A', 11, [7, 10]);

    render(<Today service={svc} />);

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '今天浇水' })).toBeTruthy();
      },
      { timeout: 5000 },
    );

  test('没有浇水记录时显示「尚无记录」而不是 0 天', async () => {
    const { svc } = await setup();
    const plant = await svc.addPlant({ name: '新买的龟背竹', placement: '客厅', exposure: 'indoor_window' });
    await svc.setCareRule(plant.id, 7, 10);

    render(<Today service={svc} />);

    await waitFor(() => {
      expect(screen.getAllByText(/尚无记录/).length).toBeGreaterThan(0);
    });
  });

  test('没有植物时不显示空白批次', async () => {
    const { svc } = await setup();
    render(<Today service={svc} />);

    await waitFor(() => {
      expect(screen.getByText(/还没有植物/)).toBeTruthy();
    });
  });
});

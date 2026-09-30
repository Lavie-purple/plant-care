/**
 * 植物详情页组件测试（T 方案 + D-06 W 方案）。
 */

import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { PlantDetail } from '../../src/ui/PlantDetail.js';
import { Repository } from '../../src/storage/repository.js';
import { setDatabaseName } from '../../src/storage/indexeddb.js';
import { PlantCareService, fixedClock } from '../../src/app/vertical-slice.js';
import { MockWeatherProvider, SCENARIOS } from '../../src/weather/mock.js';

let seq = 0;
const openRepos: Repository[] = [];

afterEach(() => {
  cleanup();
  while (openRepos.length) openRepos.pop()?.close();
});

async function setup() {
  seq += 1;
  setDatabaseName(`detail-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(SCENARIOS.hotDry);
  const svc = new PlantCareService(repo, weather, fixedClock('2026-09-30T14:32:00+08:00'));
  const plant = await svc.addPlant({
    name: '龟背竹 A',
    species: '龟背竹',
    family: '天南星科',
    placement: '客厅',
    exposure: 'indoor_window',
    potDiameterCm: 18,
    tags: ['客厅绿植'],
  });
  await svc.setCareRule(plant.id, 7, 10);
  return { svc, repo, plant };
}

function renderDetail(svc: PlantCareService, plantId: string) {
  return render(<PlantDetail service={svc} plantId={plantId} onBack={() => {}} />);
}

describe('T 方案：常驻状态条', () => {
  test('顶部常驻今日建议，不随滚动消失', async () => {
    const { svc, plant } = await setup();
    await svc.recordWatering(plant.id, { date: '2026-09-19', time: '14:20' });
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getByText(/建议今天浇水|建议检查盆土|暂缓浇水/)).toBeTruthy();
    });
  });

  test('显示距上次天数', async () => {
    const { svc, plant } = await setup();
    await svc.recordWatering(plant.id, { date: '2026-09-19', time: '14:20' });
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getByText(/距上次 11 天/)).toBeTruthy();
    });
  });

  test('无记录时明说「尚无记录」而不是 0 天', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getByText(/尚无记录/)).toBeTruthy();
    });
  });
});

describe('D-06 W 方案：三档快选，点档即提交', () => {
  test('三个浇水方式都在', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '浇透' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '喷雾' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '浸盆' })).toBeTruthy();
    });
  });

  test('点「喷雾」立即落记录，不需二次确认', async () => {
    const { svc, repo, plant } = await setup();
    renderDetail(svc, plant.id);

    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: '喷雾' });
    await user.click(btn);

    await waitFor(async () => {
      const history = await repo.wateringHistory(plant.id);
      expect(history.length).toBe(1);
      expect(history[0]?.method).toBe('喷雾');
    });
  });

  test('单株入口的记录直接补全，不进补录队列', async () => {
    const { svc, repo, plant } = await setup();
    renderDetail(svc, plant.id);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '浇透' }));

    await waitFor(async () => {
      const history = await repo.wateringHistory(plant.id);
      expect(history[0]?.completionState).toBe('complete');
      expect(history[0]?.entrySource).toBe('single');
    });
  });

  test('操作后给出回执', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '浸盆' }));

    await waitFor(() => {
      expect(screen.getByText(/已记录：浸盆/)).toBeTruthy();
    });
  });

  test('未填水量时按 18cm 盆估算并标注', async () => {
    const { svc, repo, plant } = await setup();
    renderDetail(svc, plant.id);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '浇透' }));

    await waitFor(async () => {
      const history = await repo.wateringHistory(plant.id);
      expect(history[0]?.amountMl).toBe(500);
      expect(history[0]?.amountSource).toBe('user_provided_baseline');
    });
  });
});

describe('概览 tab：档案字段完整', () => {
  test('展示品种、科、位置、周期', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getByText('龟背竹')).toBeTruthy();
      expect(screen.getByText('天南星科')).toBeTruthy();
    });
    expect(screen.getByText(/7 到 10 天/)).toBeTruthy();
    expect(screen.getByText(/你设的，系统未改/)).toBeTruthy();
  });

  test('今天的依据带人话来源', async () => {
    const { svc, plant } = await setup();
    await svc.recordWatering(plant.id, { date: '2026-09-19', time: '14:20' });
    renderDetail(svc, plant.id);

    await waitFor(() => {
      expect(screen.getAllByText(/来源：/).length).toBeGreaterThan(0);
    });
    // 不能出现内部主键
    expect(screen.queryByText(/来源：\w+-\d/)).toBeNull();
  });
});

describe('记录 tab：历史与事件分开列', () => {
  test('浇水记录与全部事件各自成段', async () => {
    const { svc, repo, plant } = await setup();
    await svc.recordWatering(plant.id, { date: '2026-09-19', time: '14:20' });
    await repo.put('plantEvents' as never, {
      id: 'e1',
      plantId: plant.id,
      type: 'NEW_LEAF',
      date: '2026-09-18',
      title: '新叶展开',
      images: [],
      metadata: {},
      createdAt: '',
      version: 1,
    } as never);

    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '记录' }));

    await waitFor(() => {
      expect(screen.getByText(/浇水记录 · 1 条/)).toBeTruthy();
      expect(screen.getByText(/全部事件 · 1 条/)).toBeTruthy();
    });
  });

  test('空状态明说而不是空白', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '记录' }));

    await waitFor(() => {
      expect(screen.getByText('还没有浇水记录')).toBeTruthy();
    });
  });
});

describe('照片 tab：成长时间线是视图（D-08）', () => {
  test('NOTE 不出现在成长时间线', async () => {
    const { svc, repo, plant } = await setup();
    for (const [id, type] of [['e1', 'PHOTO'], ['e2', 'NOTE'], ['e3', 'NEW_LEAF']]) {
      await repo.put('plantEvents' as never, {
        id,
        plantId: plant.id,
        type,
        date: '2026-09-18',
        title: type,
        images: [],
        metadata: {},
        createdAt: '',
        version: 1,
      } as never);
    }

    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '照片' }));

    await waitFor(() => {
      expect(screen.getByText(/成长时间线 · 2 条/)).toBeTruthy();
      expect(screen.queryByText('NOTE')).toBeNull();
    });
  });

  test('空时间线给出引导而不是空白', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '照片' }));

    await waitFor(() => {
      expect(screen.getByText(/随手拍一张就会形成一条记录/)).toBeTruthy();
    });
  });
});

describe('统计 tab：口径可见', () => {
  test('样本不足时显示「样本不足」而不是 0', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '统计' }));

    await waitFor(() => {
      const panel = screen.getByText('平均间隔').closest('.stat');
      expect(within(panel as HTMLElement).getByText('样本不足')).toBeTruthy();
    });
  });

  test('显示口径说明', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '统计' }));

    await waitFor(() => {
      expect(screen.getByText(/口径：/)).toBeTruthy();
    });
  });

  test('可切换区间', async () => {
    const { svc, plant } = await setup();
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '统计' }));

    const btn7 = await screen.findByRole('button', { name: '近 7 天' });
    expect(btn7.getAttribute('class')).not.toContain('chip-on');
    await user.click(btn7);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '近 7 天' }).getAttribute('class')).toContain('chip-on');
    });
  });

  test('估算水量单独说明，不混进平均值', async () => {
    const { svc, plant } = await setup();
    await svc.recordWatering(plant.id, { date: '2026-09-19', time: '14:20' });
    renderDetail(svc, plant.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '统计' }));

    await waitFor(() => {
      expect(screen.getByText(/按 18cm 盆 500ml 推算/)).toBeTruthy();
    });
  });
});

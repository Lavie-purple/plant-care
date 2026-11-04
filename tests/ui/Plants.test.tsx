/**
 * 我的植物页组件测试（Q 方案：网格 + 表格双组件）。
 */

import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { Plants } from '../../src/ui/Plants.js';
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
  setDatabaseName(`plants-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(SCENARIOS.hotDry);
  const svc = new PlantCareService(repo, weather, fixedClock('2026-09-30T14:32:00+08:00'));
  return { svc, repo };
}

async function seed(svc: PlantCareService) {
  // 超期该浇的
  const a = await svc.addPlant({ name: '龟背竹 A', species: '龟背竹', family: '天南星科', placement: '客厅', exposure: 'indoor_window', potDiameterCm: 18 });
  await svc.setCareRule(a.id, 7, 10);
  await svc.recordWatering(a.id, { date: '2026-09-19', time: '14:20' });

  // 刚浇过
  const b = await svc.addPlant({ name: '薄荷', species: '薄荷', placement: '阳台', exposure: 'outdoor' });
  await svc.setCareRule(b.id, 3, 5);
  await svc.recordWatering(b.id, { date: '2026-09-29', time: '09:00' });

  // 无记录
  const c = await svc.addPlant({ name: '白掌', species: '白掌', placement: '卧室', exposure: 'indoor' });
  return { a, b, c };
}

function renderPlants(svc: PlantCareService) {
  return render(<Plants service={svc} onOpenPlant={() => {}} />);
}

describe('Q 方案：浏览与管理分离', () => {
  test('三种模式可切换', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '卡片' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: '照片墙' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: '列表' })).toBeTruthy();
    });
    expect(screen.getByRole('tab', { name: '卡片' }).getAttribute('aria-selected')).toBe('true');
  });

  test('切到列表模式出现批量工具条，网格模式没有', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    expect(screen.queryByText(/全选当前/)).toBeNull();

    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await waitFor(() => {
      expect(screen.getByText(/全选当前/)).toBeTruthy();
    });
  });

  test('列表模式是一张表，网格模式不是', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    expect(screen.queryByRole('table')).toBeNull();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeTruthy();
    });
  });
});

describe('排序：最该处理的在前', () => {
  test('超期的排第一', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));

    await waitFor(() => {
      const firstRow = screen.getAllByRole('row')[1];
      expect(within(firstRow as HTMLElement).getByText('龟背竹 A')).toBeTruthy();
    });
  });
});

describe('搜索', () => {
  test('按名称过滤', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    const input = await screen.findByLabelText('搜索植物');
    await user.type(input, '薄荷');

    await waitFor(() => {
      expect(screen.getByText('薄荷')).toBeTruthy();
      expect(screen.queryByText('白掌')).toBeNull();
    });
  });

  test('按品种过滤', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('搜索植物'), '天南星');

    await waitFor(() => {
      expect(screen.getByText('龟背竹 A')).toBeTruthy();
      expect(screen.queryByText('薄荷')).toBeNull();
    });
  });

  test('无结果时明说而不是空白', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('搜索植物'), '不存在的植物');

    await waitFor(() => {
      expect(screen.getByText('没有符合筛选条件的植物。')).toBeTruthy();
    });
  });
});

describe('高频 chip：今天要处理', () => {
  test('点一下只剩需要动手的盆', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '今天要处理' }));

    const user2 = userEvent.setup();
    await user2.click(await screen.findByRole('tab', { name: '列表' }));
    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      expect(rows.length).toBeLessThanOrEqual(3);
    });
  });

  test('筛选后显示「筛选出 N / M 盆」', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '今天要处理' }));

    await waitFor(() => {
      expect(screen.getByText(/筛选出 \d+ \/ 3 盆/)).toBeTruthy();
    });
  });
});

describe('更多筛选抽屉', () => {
  test('可打开并包含全部维度', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /＋更多/ }));

    await waitFor(() => {
      const sheet = screen.getByRole('dialog', { name: '更多筛选' });
      expect(within(sheet).getByText('今日建议')).toBeTruthy();
      expect(within(sheet).getByText('暴露度')).toBeTruthy();
      expect(within(sheet).getByText('位置')).toBeTruthy();
      expect(within(sheet).getByText('记录状态')).toBeTruthy();
      expect(within(sheet).getByText('养护规则')).toBeTruthy();
    });
  });

  test('按位置筛选生效', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /＋更多/ }));
    const sheet = await screen.findByRole('dialog', { name: '更多筛选' });
    await user.click(within(sheet).getByRole('button', { name: '阳台' }));
    await user.click(within(sheet).getByRole('button', { name: '完成' }));

    await waitFor(() => {
      expect(screen.getByText('薄荷')).toBeTruthy();
      expect(screen.queryByText('白掌')).toBeNull();
    });
  });

  test('清除全部恢复', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('搜索植物'), '薄荷');
    await user.click(await screen.findByRole('button', { name: '清除' }));

    await waitFor(() => {
      expect(screen.getByText('龟背竹 A')).toBeTruthy();
      expect(screen.getByText('白掌')).toBeTruthy();
    });
  });
});

describe('批量选择只在列表模式出现', () => {
  test('勾选后显示已选数量', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));

    const cb = await screen.findByLabelText('选择 龟背竹 A');
    await user.click(cb);
    await waitFor(() => {
      expect(screen.getByText('已选 1 盆')).toBeTruthy();
    });
  });
});

describe('D-06 补录队列：待补全可被筛出', () => {
  test('批量产生的记录能被「待补全」筛出', async () => {
    const { svc, repo } = await setup();
    const a = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
    await svc.recordWatering(a.id, { entrySource: 'bulk' });

    const pending = await repo.allPendingRecords();
    expect(pending.length).toBe(1);
    expect(pending[0]?.entrySource).toBe('bulk');

    render(<Plants service={svc} onOpenPlant={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '待补全' }));

    await waitFor(() => {
      expect(screen.getByText(/筛选出 1 \/ 1 盆/)).toBeTruthy();
    });
  });
});

describe('批量工具条：选中后要有真动作', () => {
  test('勾选后出现删除/改位置/取消选择三个动作', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await user.click(await screen.findByLabelText('选择 龟背竹 A'));

    const toolbar = await screen.findByRole('toolbar', { name: '批量操作' });
    expect(within(toolbar).getByRole('button', { name: '删除所选' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '改位置' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '取消选择' })).toBeTruthy();
  });

  test('取消选择清空计数且动作消失', async () => {
    const { svc } = await setup();
    await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await user.click(await screen.findByLabelText('选择 龟背竹 A'));
    await user.click(screen.getByRole('button', { name: '取消选择' }));

    await waitFor(() => {
      expect(screen.queryByText(/已选/)).toBeNull();
      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });

  test('批量删除逐盆确认：错名不解锁，对名删第一盆后进到第二盆', async () => {
    const { svc, repo } = await setup();
    const { b, c } = await seed(svc); // 薄荷、白掌
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await user.click(await screen.findByLabelText('选择 薄荷'));
    await user.click(await screen.findByLabelText('选择 白掌'));
    await user.click(screen.getByRole('button', { name: '删除所选' }));

    const dialog = screen.getByRole('dialog', { name: '批量删除' });
    // 第一盆是谁由排序决定，从面板文字里取，不猜顺序
    const text = dialog.textContent ?? '';
    const m = text.match(/「(.+?)」的以下数据/);
    expect(m).toBeTruthy();
    const first = m![1];
    const input = within(dialog).getByLabelText('输入植物名以确认删除') as HTMLInputElement;
    const confirm = within(dialog).getByRole('button', { name: '确认删除这一盆' }) as HTMLButtonElement;

    // 错名不解锁
    await user.type(input, first.slice(0, -1));
    expect(confirm.disabled).toBe(true);

    // 对名删第一盆，立即落库
    await user.clear(input);
    await user.type(input, first);
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);

    await waitFor(() => {
      const remaining = screen.getByRole('dialog', { name: '批量删除' }).textContent ?? '';
      expect(remaining).toContain('第 2 / 2 盆');
    });
    const gone = await svc.getPlant(first === '薄荷' ? b.id : c.id);
    expect(gone).toBeUndefined();

    // 第二盆同样逐盆确认
    const dialog2 = screen.getByRole('dialog', { name: '批量删除' });
    const text2 = dialog2.textContent ?? '';
    const second = text2.match(/「(.+?)」的以下数据/)![1];
    const input2 = within(dialog2).getByLabelText('输入植物名以确认删除') as HTMLInputElement;
    await user.type(input2, second);
    await user.click(within(dialog2).getByRole('button', { name: '确认删除这一盆' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '批量删除' })).toBeNull();
    });
    expect(await svc.getPlant(first === '薄荷' ? c.id : b.id)).toBeUndefined();
    expect(await svc.listPlants()).toHaveLength(1);
  });

  test('批量删除可以跳过某盆', async () => {
    const { svc } = await setup();
    const { a, b } = await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await user.click(await screen.findByLabelText('选择 龟背竹 A'));
    await user.click(await screen.findByLabelText('选择 薄荷'));
    await user.click(screen.getByRole('button', { name: '删除所选' }));

    // 跳过第一盆（不管它是谁）
    const dialog = screen.getByRole('dialog', { name: '批量删除' });
    const first = (dialog.textContent ?? '').match(/「(.+?)」的以下数据/)![1];
    await user.click(within(dialog).getByRole('button', { name: '跳过这盆' }));

    // 第二盆确认删除
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '批量删除' }).textContent).toContain('第 2 / 2 盆');
    });
    const dialog2 = screen.getByRole('dialog', { name: '批量删除' });
    const second = (dialog2.textContent ?? '').match(/「(.+?)」的以下数据/)![1];
    await user.type(within(dialog2).getByLabelText('输入植物名以确认删除'), second);
    await user.click(within(dialog2).getByRole('button', { name: '确认删除这一盆' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '批量删除' })).toBeNull();
    });
    // 跳过的活着，确认的死掉
    const skipped = first === '龟背竹 A' ? a : b;
    const deleted = first === '龟背竹 A' ? b : a;
    expect(await svc.getPlant(skipped.id)).toBeTruthy();
    expect(await svc.getPlant(deleted.id)).toBeUndefined();
  });

  test('批量改位置：应用后全部更新并给汇总', async () => {
    const { svc } = await setup();
    const { a, b } = await seed(svc);
    renderPlants(svc);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '列表' }));
    await user.click(await screen.findByLabelText('选择 龟背竹 A'));
    await user.click(await screen.findByLabelText('选择 薄荷'));
    await user.click(screen.getByRole('button', { name: '改位置' }));

    const dialog = screen.getByRole('dialog', { name: '批量改位置' });
    await user.selectOptions(within(dialog).getByLabelText('新位置'), '书房');
    await user.click(within(dialog).getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('status').textContent).toContain('已移动 2 盆');
    });
    await user.click(within(dialog).getByRole('button', { name: '完成' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '批量改位置' })).toBeNull();
    });
    const pa = await svc.getPlant(a.id);
    const pb = await svc.getPlant(b.id);
    expect(pa?.placement).toBe('书房');
    expect(pb?.placement).toBe('书房');
    // 改位置不动版本以外的档案字段：名字还在
    expect(pa?.name).toBe('龟背竹 A');
  });

  test('添加完成后 refreshKey 变化会重取列表（修列表不刷新）', async () => {
    const { svc } = await setup();
    const { render } = await import('@testing-library/react');
    const { a } = await seed(svc);
    const ui = render(<Plants service={svc} onOpenPlant={() => {}} onAddPlant={() => {}} refreshKey={0} />);

    // 添加一盆（模拟添加表单在植物页上方完成）
    await svc.addPlant({ name: '后来添加', placement: '客厅', exposure: 'indoor' });

    // 不重挂载，只递增 refreshKey —— 列表必须出现新植物
    ui.rerender(<Plants service={svc} onOpenPlant={() => {}} onAddPlant={() => {}} refreshKey={1} />);

    await waitFor(() => {
      expect(screen.getByText('后来添加')).toBeTruthy();
      expect(screen.getByText('龟背竹 A')).toBeTruthy();
    });
    void a;
  });
});

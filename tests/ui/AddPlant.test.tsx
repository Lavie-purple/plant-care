/**
 * 添加植物表单测试。
 *
 * 这条路径是应用能不能真正用起来的关键——没有它，用户加不了任何植物。
 */

import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { AddPlant } from '../../src/ui/AddPlant.js';
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
  setDatabaseName(`addplant-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(SCENARIOS.mild);
  const svc = new PlantCareService(repo, weather, fixedClock('2026-09-30T14:32:00+08:00'));
  return { svc, repo };
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
  await user.type(screen.getByPlaceholderText('龟背竹'), '龟背竹');
  await user.type(screen.getByPlaceholderText('天南星科'), '天南星科');
}

function renderForm(svc: PlantCareService, onDone = () => {}) {
  return render(<AddPlant service={svc} onDone={onDone} onCancel={() => {}} />);
}

describe('新建植物：基本路径', () => {
  test('只填名字就能建（其他都可以后补）', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const plants = await repo.allPlants();
      expect(plants.length).toBe(1);
      expect(plants[0]?.name).toBe('龟背竹 A');
    });
  });

  test('默认位置与暴露度有合理值', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '薄荷');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      expect(p?.placement).toBe('客厅');
      expect(p?.exposure).toBe('indoor_window');
    });
  });

  test('填了周期就建立规则并锁死 userOverride', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.type(screen.getByLabelText('周期下限'), '7');
    await user.type(screen.getByLabelText('周期上限'), '10');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      const rule = await repo.getCareRuleByPlant(p!.id);
      expect(rule?.recommendedIntervalMin).toBe(7);
      expect(rule?.recommendedIntervalMax).toBe(10);
      expect(rule?.userOverride).toBe(true);
    });
  });

  test('选了位置与暴露度会被记录', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '薄荷');
    await user.click(screen.getByRole('button', { name: '阳台' }));
    await user.click(screen.getByRole('button', { name: /露天/ }));
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      expect(p?.placement).toBe('阳台');
      expect(p?.exposure).toBe('outdoor');
    });
  });

  test('来源走事件留痕，不塞进 Plant 字段', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.type(screen.getByPlaceholderText('X 花园，180 元'), 'X 花园');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      const events = await repo.plantEvents(p!.id);
      expect(events.some((e) => e.description?.includes('X 花园'))).toBe(true);
    });
  });
});

describe('校验必须在提交前拦住', () => {
  test('空名字不能提交', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect((await repo.allPlants()).length).toBe(0, '校验没过不得写库');
  });

  test('周期只填一半被拦', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.type(screen.getByLabelText('周期下限'), '7');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect((await repo.allPlants()).length).toBe(0);
  });

  test('上限小于下限被拦', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.type(screen.getByLabelText('周期下限'), '10');
    await user.type(screen.getByLabelText('周期上限'), '7');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect((await repo.allPlants()).length).toBe(0);
  });

  test('盆口径填非数字被拦', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.type(screen.getByPlaceholderText('18'), '十八');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect((await repo.allPlants()).length).toBe(0);
  });
});

describe('周期可以完全留空', () => {
  test('不确定周期时不建规则，引擎降级为按历史推断', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      const rule = await repo.getCareRuleByPlant(p!.id);
      expect(rule).toBeUndefined();
    });
  });

  test('仍能给出建议，不会因为没有规则就崩', async () => {
    const { svc, repo } = await setup();
    renderForm(svc);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('龟背竹 A'), '龟背竹 A');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(async () => {
      const p = (await repo.allPlants())[0];
      const rec = await svc.recommend(p!.id, await svc.loadWeather());
      expect(['CHECK', 'WATER_NOW', 'DELAY', 'NO_ACTION']).toContain(rec.recommendation.action);
    });
  });
});

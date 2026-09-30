/**
 * 记事件面板测试。
 *
 * 重点验证「每种事件只问它需要的」——表单按类型变形，
 * 不能变成一张所有类型通用的大表单。
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { EventSheet } from '../../src/ui/EventSheet.js';
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
  setDatabaseName(`evsheet-${seq}`);
  const repo = new Repository();
  await repo.open();
  openRepos.push(repo);
  const weather = new MockWeatherProvider(SCENARIOS.mild);
  const svc = new PlantCareService(repo, weather, fixedClock('2026-09-30T14:32:00+08:00'));
  const plant = await svc.addPlant({ name: '龟背竹 A', placement: '客厅', exposure: 'indoor_window' });
  return { svc, repo, plant };
}

async function openSheet(svc: PlantCareService, plantId: string, name: string, initialType?: 'PHOTO') {
  const onSaved = vi.fn();
  render(
    <EventSheet
      service={svc}
      plantId={plantId}
      plantName={name}
      {...(initialType ? { initialType } : {})}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  return onSaved;
}

describe('类型选择驱动表单变形', () => {
  test('14 种类型都在（浇水除外，它有专用入口）', async () => {
    const { svc, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    for (const label of ['照片', '新叶', '施肥', '修剪', '换盆', '开花', '结果', '黄叶', '掉叶', '虫害', '病害', '备注', '自定义']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.queryByRole('radio', { name: /浇水/ })).toBeNull();
  });

  test('换盆不显示「详细情况」，换病虫害才显示', async () => {
    const { svc, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);

    await userEvent.setup().click(screen.getByRole('radio', { name: /换盆/ }));
    expect(screen.queryByLabelText('详细情况')).toBeNull();

    await userEvent.setup().click(screen.getByRole('radio', { name: /病害/ }));
    expect(screen.getByLabelText('详细情况')).toBeTruthy();
  });

  test('切换类型会换掉标题占位提示', async () => {
    const { svc, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /换盆/ }));
    expect(screen.getByLabelText('事件说明')).toHaveProperty('placeholder', expect.stringContaining('24cm') as unknown as string);
  });
});

describe('提交：校验在保存前生效', () => {
  test('什么都不填被拒，不产生空事件', async () => {
    const { svc, repo, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect((await repo.plantEvents(plant.id)).length).toBe(0);
  });

  test('换盆写一句话就能存', async () => {
    const { svc, repo, plant } = await setup();
    const onSaved = await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /换盆/ }));
    await user.type(screen.getByLabelText('事件说明'), '换到 24cm 陶盆');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    const events = await repo.plantEvents(plant.id);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe('REPOTTING');
    expect(events[0]?.title).toBe('换到 24cm 陶盆');
  });

  test('病虫害必须写详细情况', async () => {
    const { svc, repo, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /虫害/ }));
    await user.type(screen.getByLabelText('事件说明'), '叶背有小黑点');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect((await repo.plantEvents(plant.id)).length).toBe(0, '缺必填项时不得落库');

    await user.type(screen.getByLabelText('详细情况'), '像是蚜虫');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await repo.plantEvents(plant.id)).length).toBe(1);
    });
  });

  test('日期可回填过去', async () => {
    const { svc, repo, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /施肥/ }));
    await user.type(screen.getByLabelText('事件说明'), '缓释肥 5 粒');
    await user.type(screen.getByLabelText('事件日期'), '2026-09-20');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const ev = (await repo.plantEvents(plant.id))[0];
      expect(ev?.date).toBe('2026-09-20');
      expect(ev?.type).toBe('FERTILIZING');
    });
  });
});

describe('事件立刻出现在成长时间线里（D-08）', () => {
  test('新叶事件写入后出现在时间线', async () => {
    const { svc, repo, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /新叶/ }));
    await user.type(screen.getByLabelText('事件说明'), '展开第二片');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const timeline = await repo.growthTimeline(plant.id);
      expect(timeline.length).toBe(1);
      expect(timeline[0]?.type).toBe('NEW_LEAF');
    });
  });

  test('施肥不进入成长时间线，但在全部事件里', async () => {
    const { svc, repo, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /施肥/ }));
    await user.type(screen.getByLabelText('事件说明'), '缓释肥');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await repo.plantEvents(plant.id)).length).toBe(1);
      expect((await repo.growthTimeline(plant.id)).length).toBe(0);
    });
  });
});

/**
 * 界面不得显示枚举值。
 * 之前记录 tab 直接显示 `DISEASE 根部发黑`，浏览器实测才发现。
 */
describe('事件类型在界面上必须是人话', () => {
  test('打开面板时界面上不出现裸枚举值', async () => {
    const { svc, plant } = await setup();
    await openSheet(svc, plant.id, plant.name);
    const body = document.body.textContent ?? '';
    // 14 种类型的按钮都用中文标签
    for (const raw of ['DISEASE', 'REPOTTING', 'NEW_LEAF', 'PEST', 'FERTILIZING', 'PHOTO']) {
      expect(body).not.toContain(raw);
    }
    expect(body).toContain('病害');
    expect(body).toContain('换盆');
  });

  test('每个类型的 label 都是中文且非空', async () => {
    const { EVENT_META } = await import('../../src/app/eventDraft.js');
    for (const m of EVENT_META) {
      expect(m.label).not.toBe(m.type);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
});

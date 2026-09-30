/**
 * 事件记录表单测试。
 *
 * 重点验证「每种事件只问它需要的」——这是本模块存在的理由。
 * 如果有一天所有事件都变成一张大表单，这些测试应该变红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_EVENT_DRAFT,
  EVENT_META,
  metaFor,
  metaMatchesSchema,
  summarizeEvent,
  validateEvent,
  type EventDraft,
} from '../src/app/eventDraft.js';
import { PLANT_EVENT_TYPES } from '../src/domain/types.js';

function d(over: Partial<EventDraft> = {}): EventDraft {
  // 默认 NOTE 而不是 PHOTO：NOTE 只要求有文字，
  // 不会让日期、长度这类测试因为「照片必须有图」而连锁失败。
  return { ...EMPTY_EVENT_DRAFT, type: 'NOTE', date: '2026-09-30', ...over };
}

describe('类型元数据与 schema 不漂移', () => {
  test('必填字段定义与界面要求一致', () => {
    const r = metaMatchesSchema();
    assert.equal(r.ok, true, `元数据与 schema 漂移：${r.problems.join('；')}`);
  });

  test('WATERING 不在事件列表里（浇水有三档快选，入口不能分裂）', () => {
    assert.equal(
      EVENT_META.some((m) => m.type === 'WATERING'),
      false,
      '浇水已有专用入口，再放一个会造成两个入口做同一件事',
    );
  });

  test('其余 14 种类型都在列表里', () => {
    const covered = new Set(EVENT_META.map((m) => m.type));
    for (const t of PLANT_EVENT_TYPES) {
      if (t === 'WATERING') continue;
      assert.ok(covered.has(t), `${t} 缺少界面入口`);
    }
  });
});

describe('每种事件只问它需要的', () => {
  test('照片：有图即可，标题是可选补充', () => {
    assert.equal(validateEvent(d({ type: 'PHOTO', title: '长高了', imageIds: ['i1'] })).ok, true, '有标题当然通过');
    // 拍一张但没写标题，同样该通过——随手拍是最常见的情况
    assert.equal(validateEvent(d({ title: '', imageIds: ['img-1'] })).ok, true);
    // 什么都没拍也没写，才该拒绝
    const nothing = validateEvent(d({ type: 'PHOTO', title: '', imageIds: [] }));
    assert.equal(nothing.ok, false);
    assert.equal(nothing.empty, true);
  });

  test('施肥：标题可空，写了就能存', () => {
    assert.equal(validateEvent(d({ type: 'FERTILIZING', title: '缓释肥 5 粒' })).ok, true);
  });

  test('施肥：什么都不写则拒绝，不产生空事件', () => {
    const r = validateEvent(d({ type: 'FERTILIZING', title: '', description: '', imageIds: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.empty, true);
  });

  test('病虫害：标题与描述都要', () => {
    assert.equal(validateEvent(d({ type: 'PEST', title: '', description: '看到虫子' })).errors.title !== undefined, true);
    assert.equal(validateEvent(d({ type: 'PEST', title: '叶背有黑点', description: '' })).errors.description !== undefined, true);
    assert.equal(validateEvent(d({ type: 'PEST', title: '叶背有黑点', description: '蚜虫' })).ok, true);
  });

  test('有照片就够，不需要文字', () => {
    const r = validateEvent(d({ type: 'PHOTO', title: '', description: '', imageIds: ['img-1'] }));
    assert.equal(r.ok, true, '拍了一张照片就是一条有效记录');
  });

  test('非照片类型：备注单独写也算有内容', () => {
    assert.equal(validateEvent(d({ type: 'NOTE', title: '', notes: '随手记一句' })).ok, true);
  });
});

describe('日期', () => {
  test('留空表示今天，合法', () => {
    assert.equal(validateEvent(d({ title: 'x', date: '' })).ok, true);
  });

  test('格式错误被拦', () => {
    assert.equal(validateEvent(d({ title: 'x', date: '2026/09/30' })).ok, false);
  });

  test('将来日期被拦', () => {
    const future = new Date(Date.now() + 86_400_000 * 10).toISOString().slice(0, 10);
    assert.equal(validateEvent(d({ title: 'x', date: future })).ok, false);
  });

  test('过去的日期合法（补记前几天的）', () => {
    assert.equal(validateEvent(d({ title: 'x', date: '2026-09-20' })).ok, true);
  });
});

describe('长度限制', () => {
  test('标题超长被拦', () => {
    assert.equal(validateEvent(d({ title: '长'.repeat(61) })).ok, false);
  });
});

describe('摘要', () => {
  test('有标题时「类型 + 标题」', () => {
    const s = summarizeEvent(d({ type: 'REPOTTING', title: '换到 24cm 陶盆' }));
    assert.equal(s, '换盆　换到 24cm 陶盆');
  });

  test('只有照片时给出张数', () => {
    const s = summarizeEvent(d({ type: 'PHOTO', title: '', imageIds: ['a', 'b'] }));
    assert.match(s, /2 张照片/);
  });

  test('什么都没有时只显示类型', () => {
    assert.equal(summarizeEvent(d({ type: 'REPOTTING', title: '', imageIds: [] })), '换盆');
  });
});

describe('未知类型要有兜底', () => {
  test('不在元数据表里的类型不会崩', () => {
    const m = metaFor('CUSTOM' as never);
    assert.ok(m.label.length > 0);
  });
});

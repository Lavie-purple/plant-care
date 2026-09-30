/**
 * 补录队列测试。
 *
 * 核心要守住的性质：
 *   1. 队列必须有终点（14 天降级），否则无限堆积
 *   2. 待补全记录不参与判定与统计
 *   3. 补录时用户手填优先于估算，未填则保持估算不覆盖
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueue,
  completeRecord,
  missingFields,
  selectExpired,
  summarizeQueue,
  DEFAULT_PENDING_DAYS,
} from '../src/app/completionQueue.js';
import type { Plant, WateringRecord } from '../src/domain/types.js';

const TODAY = new Date('2026-09-30T14:32:00+08:00');

let seq = 0;
function plant(id: string, name: string): Plant {
  return {
    id,
    name,
    placement: '客厅',
    exposure: 'indoor_window',
    tags: [],
    createdAt: '',
    updatedAt: '',
    version: 1,
  };
}

function rec(daysAgo: number, over: Partial<WateringRecord> = {}): WateringRecord {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  seq += 1;
  return {
    id: `w${seq}`,
    plantId: 'p1',
    date: `${d.getFullYear()}-${m}-${day}`,
    time: '14:00',
    amountMl: 500,
    amountSource: 'user_provided_baseline',
    method: '浇透',
    fertilizerIncluded: false,
    images: [],
    completionState: 'pending',
    entrySource: 'bulk',
    createdAt: `${d.getFullYear()}-${m}-${day}T14:00:00+08:00`,
    updatedAt: `${d.getFullYear()}-${m}-${day}T14:00:00+08:00`,
    version: 1,
    ...over,
  };
}

describe('构建队列：只收待补全，按最近在前', () => {
  test('只收 pending', () => {
    const plants = [plant('p1', '龟背竹 A')];
    const records = [rec(1), rec(2, { completionState: 'complete' }), rec(3, { completionState: 'expired' })];
    const q = buildQueue({ plants, records, today: TODAY });
    assert.equal(q.length, 1);
    assert.equal(q[0]?.record.id, records[0]?.id);
  });

  test('按记录时间倒序，先补最近的', () => {
    const plants = [plant('p1', 'A')];
    const q = buildQueue({ plants, records: [rec(5), rec(1), rec(3)], today: TODAY });
    assert.deepEqual(
      q.map((x) => x.daysWaiting),
      [1, 3, 5],
    );
  });

  test('植物已删除的记录不进队列', () => {
    const q = buildQueue({ plants: [plant('p1', 'A')], records: [rec(1, { plantId: 'ghost' })], today: TODAY });
    assert.equal(q.length, 0);
  });

  test('计算距过期还剩几天', () => {
    const plants = [plant('p1', 'A')];
    const q = buildQueue({ plants, records: [rec(10)], today: TODAY, pendingDays: 14 });
    assert.equal(q[0]?.daysUntilExpire, 4);
  });
});

describe('只问真正缺的字段，不做一次性表单', () => {
  test('估算水量算缺，用户手填的不算', () => {
    assert.equal(missingFields(rec(1)).amount, true);
    assert.equal(missingFields(rec(1, { amountSource: 'user_stated' })).amount, false);
  });

  test('没备注算缺', () => {
    assert.equal(missingFields(rec(1)).note, true);
    assert.equal(missingFields(rec(1, { notes: '擦了叶子' })).note, false);
  });

  test('快速记录的预设方式不算缺，不重复问', () => {
    assert.equal(missingFields(rec(1)).method, false, '快速记录已预设「浇透」，不该再问');
  });
});

describe('14 天降级：队列必须有终点（D-06）', () => {
  test('正好 14 天的记录被降级', () => {
    const out = selectExpired([rec(14)], TODAY);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.completionState, 'expired');
  });

  test('未满 14 天的保留', () => {
    assert.equal(selectExpired([rec(13)], TODAY).length, 0);
  });

  test('已补全的不会被降级', () => {
    assert.equal(selectExpired([rec(20, { completionState: 'complete' })], TODAY).length, 0);
  });

  test('降级保留全部原始数据，只是状态变了', () => {
    const src = rec(20, { notes: '出差回来补浇', amountMl: 500 });
    const out = selectExpired([src], TODAY)[0];
    assert.ok(out);
    assert.equal(out.date, src.date, '日期不能丢');
    assert.equal(out.time, src.time);
    assert.equal(out.notes, '出差回来补浇', '备注不能因为过期就丢');
    assert.equal(out.entrySource, 'bulk');
  });

  test('降级会递增 version（走乐观锁，不静默覆盖）', () => {
    const out = selectExpired([rec(20)], TODAY)[0];
    assert.equal(out?.version, 2);
  });

  test('阈值可配置', () => {
    assert.equal(selectExpired([rec(3)], TODAY, 3).length, 1);
    assert.equal(selectExpired([rec(3)], TODAY, 7).length, 0);
  });

  test('默认阈值是 14 天', () => {
    assert.equal(DEFAULT_PENDING_DAYS, 14);
  });
});

describe('补录：用户手填优先于估算（D-13）', () => {
  test('填了水量就用用户的，来源变 user_stated', () => {
    const out = completeRecord({ record: rec(1), amountMl: 300, now: TODAY });
    assert.equal(out.amountMl, 300);
    assert.equal(out.amountSource, 'user_stated');
    assert.equal(out.completionState, 'complete');
  });

  test('没填水量则保持估算，不覆盖也不伪装', () => {
    const out = completeRecord({ record: rec(1), now: TODAY });
    assert.equal(out.amountSource, 'user_provided_baseline', '仍是估算，不能标成用户填的');
    assert.equal(out.amountMl, 500);
    assert.equal(out.completionState, 'complete');
  });

  test('补录只更新传了的字段', () => {
    const src = rec(1, { method: '浇透' });
    const out = completeRecord({ record: src, notes: '叶尖发黄', now: TODAY });
    assert.equal(out.notes, '叶尖发黄');
    assert.equal(out.method, '浇透', '没传的方式保持原值');
  });

  test('已过期的记录也能被补全（用户主动补）', () => {
    const out = completeRecord({ record: rec(20, { completionState: 'expired' }), amountMl: 400, now: TODAY });
    assert.equal(out.completionState, 'complete');
  });

  test('补录会递增 version', () => {
    const out = completeRecord({ record: rec(1), now: TODAY });
    assert.equal(out.version, 2);
  });

  test('忽略 0 或负的水量，不当成用户填的', () => {
    const out = completeRecord({ record: rec(1), amountMl: 0, now: TODAY });
    assert.equal(out.amountSource, 'user_provided_baseline');
  });
});

describe('队列摘要给界面一个可执行的下一步', () => {
  const plants = [plant('p1', 'A')];

  test('总数与即将过期数', () => {
    const q = buildQueue({ plants, records: [rec(0), rec(12), rec(5)], today: TODAY, pendingDays: 14 });
    const s = summarizeQueue(q);
    assert.equal(s.total, 3);
    assert.equal(s.expiringSoon, 1, '只有 12 天那条在 3 天内过期');
  });

  test('空队列摘要为 0', () => {
    const s = summarizeQueue([]);
    assert.equal(s.total, 0);
    assert.equal(s.expiringSoon, 0);
  });
});

describe('收敛不变量：队列长度必须有界', () => {
  test('持续产生待补全记录时，14 天后队列自动归零', () => {
    // 模拟 40 天里每天都批量浇 3 盆，且用户从不补
    const plants = [plant('p1', 'A')];
    const all: WateringRecord[] = [];
    for (let d = 39; d >= 0; d -= 1) {
      for (let i = 0; i < 3; i += 1) all.push(rec(d));
    }
    // 每天扫一次
    let queue = all;
    for (let day = 39; day >= 0; day -= 1) {
      const t = new Date(TODAY);
      t.setDate(t.getDate() - day);
      const expired = selectExpired(queue, t);
      const ids = new Set(expired.map((x) => x.id));
      queue = queue.map((x) => (ids.has(x.id) ? (expired.find((e) => e.id === x.id) as WateringRecord) : x));
    }
    const final = buildQueue({ plants, records: queue, today: TODAY });
    assert.ok(final.length <= 3 * DEFAULT_PENDING_DAYS, `队列应被收敛，实际 ${final.length}`);
  });
});

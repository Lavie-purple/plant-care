/**
 * 规则冲突测试。
 *
 * 守住三条不变量：
 *   1. 同一个冲突只问一次
 *   2. 用户拒绝后，只要算法结果没变就不再问
 *   3. 只有用户点了「改」，CareRule 才会被写
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideConflict,
  describeConflict,
  markPrompted,
  resolveConflict,
  shouldPrompt,
} from '../src/app/ruleConflict.js';
import type { CareRule, PendingRuleConflict } from '../src/domain/types.js';

const NOW = new Date('2026-09-30T14:32:00+08:00');
const LATER = new Date('2026-09-30T15:00:00+08:00');

function rule(over: Partial<CareRule> = {}): CareRule {
  return {
    id: 'rule-1',
    plantId: 'p1',
    recommendedIntervalMin: 10,
    recommendedIntervalMax: 14,
    minimumInterval: 7,
    maximumInterval: 19,
    source: 'user',
    userOverride: true,
    updatedAt: '2026-09-01T10:00:00+08:00',
    version: 1,
    ...over,
  };
}

function input(computedMin = 7, computedMax = 8): Parameters<typeof decideConflict>[1] {
  return {
    plantId: 'p1',
    ruleId: 'rule-1',
    computed: { min: computedMin, max: computedMax },
    user: { min: 10, max: 14 },
    reason: '未来几天高温，蒸腾量上升',
    now: NOW,
  };
}

describe('要不要新建冲突', () => {
  test('算出不同的周期 → 建', () => {
    const r = decideConflict([], input());
    assert.equal(r.action, 'create');
  });

  test('算出的和用户设的一样 → 不建', () => {
    const r = decideConflict([], input(10, 14));
    assert.equal(r.action, 'none');
    assert.equal(r.action === 'none' ? r.reason : '', 'same');
  });

  test('已有一条待处理的 → 不重复建', () => {
    const first = decideConflict([], input());
    assert.equal(first.action, 'create');
    if (first.action !== 'create') return;
    const r = decideConflict([first.conflict], input());
    assert.equal(r.action, 'none');
    assert.equal(r.action === 'none' ? r.reason : '', 'already-pending');
  });

  test('算出的周期变了 → 允许新建新的一条', () => {
    const first = decideConflict([], input(7, 8));
    if (first.action !== 'create') return;
    const resolved = resolveConflict(first.conflict, 'keep-user', rule(), NOW).conflict;
    const r = decideConflict([resolved], input(6, 7));
    assert.equal(r.action, 'create', '算法结果变了就该再问一次');
  });

  test('不同植物互不影响', () => {
    const a = decideConflict([], input());
    if (a.action !== 'create') return;
    const r = decideConflict([a.conflict], { ...input(), plantId: 'p2' });
    assert.equal(r.action, 'create');
  });
});

describe('W3 铁律：同一冲突只弹一次', () => {
  test('连续触发 10 次，弹窗展示次数必须等于 1', () => {
    const created = decideConflict([], input());
    assert.equal(created.action, 'create');
    if (created.action !== 'create') return;

    let current: PendingRuleConflict = created.conflict;
    let promptCount = 0;

    // 模拟引擎连续 10 轮算出同样的冲突
    for (let i = 0; i < 10; i += 1) {
      const r = decideConflict([current], input());
      if (r.action === 'none') {
        if (shouldPrompt(current)) promptCount += 1;
        continue;
      }
      current = r.conflict;
    }

    // 展示过一次后就不再展示
    const prompted = markPrompted(current, NOW);
    let shown = 0;
    let c: PendingRuleConflict = prompted;
    for (let i = 0; i < 10; i += 1) {
      const r = decideConflict([c], input());
      if (r.action === 'create') c = r.conflict;
      if (shouldPrompt(c)) shown += 1;
    }
    assert.equal(shown, 0, '已经问过的冲突不得重复弹窗');
    void promptCount;
  });

  test('markPrompted 幂等，重复调用不会改版本', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const once = markPrompted(created.conflict, NOW);
    const twice = markPrompted(once, LATER);
    assert.equal(once.version, created.conflict.version + 1);
    assert.equal(twice.version, once.version, '已标记过就不该再改');
    assert.equal(twice.promptedAt, once.promptedAt);
  });

  test('已解决的冲突不再弹窗', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const resolved = resolveConflict(created.conflict, 'keep-user', rule(), NOW).conflict;
    assert.equal(shouldPrompt(resolved), false);
  });
});

describe('D-13 铁律：系统绝不擅自改规则', () => {
  test('keep-user 时 updatedRule 为 null，CareRule 一个字节都不动', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const before = JSON.stringify(rule());
    const r = resolveConflict(created.conflict, 'keep-user', rule(), NOW);
    assert.equal(r.updatedRule, null, '保持用户设定时不得产生任何规则写入');
    assert.equal(JSON.stringify(rule()), before);
  });

  test('take-computed 才写规则，且 userOverride 保持为 true', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const r = resolveConflict(created.conflict, 'take-computed', rule(), NOW);
    assert.ok(r.updatedRule);
    assert.equal(r.updatedRule?.recommendedIntervalMin, 7);
    assert.equal(r.updatedRule?.recommendedIntervalMax, 8);
    assert.equal(r.updatedRule?.userOverride, true, '改过之后仍是用户决定，不是系统接管');
  });

  test('改周期时硬上下限跟着调整，否则判定会自相矛盾', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const r = resolveConflict(created.conflict, 'take-computed', rule(), NOW);
    const u = r.updatedRule!;
    // 周期 7-8，硬上限不能还是原来的 19，否则「超上限该浇」会永远不触发
    assert.ok(u.maximumInterval > 8, `硬上限 ${u.maximumInterval} 必须大于周期上限 8`);
    assert.ok(u.minimumInterval < 7, `硬下限 ${u.minimumInterval} 必须小于周期下限 7`);
  });

  test('取新值时源记为 user 而不是 system', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const r = resolveConflict(created.conflict, 'take-computed', rule(), NOW);
    assert.equal(r.updatedRule?.source, 'user');
  });

  test('解决时版本号递增，走乐观锁', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const r = resolveConflict(created.conflict, 'take-computed', rule(), NOW);
    assert.equal(r.conflict.version, created.conflict.version + 1);
    assert.ok(r.updatedRule);
    assert.equal(r.updatedRule.version, rule().version + 1);
    assert.ok(r.conflict.resolvedAt);
  });
});

describe('用户拒绝后不再打扰', () => {
  test('同一个值被拒后不再建新冲突', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const resolved = resolveConflict(created.conflict, 'keep-user', rule(), NOW).conflict;
    const r = decideConflict([resolved], input());
    assert.equal(r.action, 'none');
    assert.equal(r.action === 'none' ? r.reason : '', 'user-declined');
  });

});

describe('文案', () => {
  test('给出两个具体数字而不是模糊描述', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    const d = describeConflict(created.conflict);
    assert.equal(d.userText, '10 到 14 天');
    assert.equal(d.computedText, '7 到 8 天');
    assert.ok(d.headline.length > 0);
  });

  test('理由被带进冲突记录', () => {
    const created = decideConflict([], input());
    if (created.action !== 'create') return;
    assert.match(created.conflict.reason, /高温/);
  });
});

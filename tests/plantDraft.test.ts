/**
 * 新建植物表单测试。
 *
 * 校验必须在提交前拦住错误，且不能默默接受「只填了周期一半」这种笔误。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateDraft, EMPTY_DRAFT, type PlantDraft } from '../src/app/plantDraft.js';

function d(over: Partial<PlantDraft> = {}): PlantDraft {
  return { ...EMPTY_DRAFT, name: '龟背竹 A', ...over };
}

describe('必填项', () => {
  test('名字必填', () => {
    const r = validateDraft(d({ name: '' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.name);
  });

  test('只有空白也算没填', () => {
    assert.equal(validateDraft(d({ name: '   ' })).ok, false);
  });

  test('名字超长被拦', () => {
    const r = validateDraft(d({ name: '龟'.repeat(41) }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.name);
  });

  test('名字去空白后有效', () => {
    assert.equal(validateDraft(d({ name: ' 龟背竹 A ' })).ok, true);
  });
});

describe('数字字段', () => {
  test('盆口径留空是允许的（不知道就留空，不编）', () => {
    const r = validateDraft(d({ potDiameterCm: '' }));
    assert.equal(r.ok, true);
    assert.equal(r.parsed?.potDiameterCm, undefined);
  });

  test('盆口径填非数字被拦', () => {
    const r = validateDraft(d({ potDiameterCm: '十八' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.potDiameterCm);
  });

  test('盆口径 0 与超范围被拦', () => {
    assert.equal(validateDraft(d({ potDiameterCm: '0' })).ok, false);
    assert.equal(validateDraft(d({ potDiameterCm: '500' })).ok, false);
  });

  test('合法盆口径转成数字', () => {
    const r = validateDraft(d({ potDiameterCm: '18' }));
    assert.equal(r.ok, true);
    assert.equal(r.parsed?.potDiameterCm, 18);
  });

  test('小数口径允许', () => {
    assert.equal(validateDraft(d({ potDiameterCm: '18.5' })).parsed?.potDiameterCm, 18.5);
  });
});

describe('周期：一半必然是笔误', () => {
  test('两个都留空是允许的', () => {
    const r = validateDraft(d({ intervalMin: '', intervalMax: '' }));
    assert.equal(r.ok, true, '没设周期时引擎会按历史推断，这是合法状态');
    assert.equal(r.parsed?.intervalMin, undefined);
  });

  test('只填下限被拦', () => {
    const r = validateDraft(d({ intervalMin: '7', intervalMax: '' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.intervalMax || r.errors.intervalMin);
  });

  test('只填上限被拦', () => {
    const r = validateDraft(d({ intervalMin: '', intervalMax: '10' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.intervalMax || r.errors.intervalMin);
  });

  test('上限小于下限被拦', () => {
    const r = validateDraft(d({ intervalMin: '10', intervalMax: '7' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.intervalMax);
  });

  test('下限小于 1 天被拦', () => {
    assert.equal(validateDraft(d({ intervalMin: '0', intervalMax: '7' })).ok, false);
  });

  test('上限超过一年被拦', () => {
    const r = validateDraft(d({ intervalMin: '7', intervalMax: '400' }));
    assert.equal(r.ok, false);
  });

  test('合法周期转成数字', () => {
    const r = validateDraft(d({ intervalMin: '7', intervalMax: '10' }));
    assert.equal(r.parsed?.intervalMin, 7);
    assert.equal(r.parsed?.intervalMax, 10);
  });

  test('下限等于上限是允许的（固定周期也是真实需求）', () => {
    const r = validateDraft(d({ intervalMin: '7', intervalMax: '7' }));
    assert.equal(r.ok, true);
  });
});

describe('购买日期', () => {
  test('留空允许', () => {
    assert.equal(validateDraft(d({ purchaseDate: '' })).ok, true);
  });

  test('格式错误被拦', () => {
    assert.equal(validateDraft(d({ purchaseDate: '2025/03/02' })).ok, false);
  });

  test('将来日期被拦', () => {
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
    const r = validateDraft(d({ purchaseDate: future }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.purchaseDate);
  });

  test('过去的日期通过', () => {
    assert.equal(validateDraft(d({ purchaseDate: '2025-03-02' })).ok, true);
  });
});

describe('一次只报所有问题，不逐个挤牙膏', () => {
  test('多个错误同时报出', () => {
    const r = validateDraft(d({ name: '', potDiameterCm: 'x', intervalMin: '10', intervalMax: '2' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.name);
    assert.ok(r.errors.potDiameterCm);
    assert.ok(r.errors.intervalMax);
  });
});

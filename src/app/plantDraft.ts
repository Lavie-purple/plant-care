/**
 * 新建植物的表单校验。
 *
 * 单独成模块是因为校验规则必须可测，而且要在提交前拦住错误，
 * 不能等写库失败才发现。
 */

import type { Exposure, LightProfile, Placement } from '../domain/types.js';
import { PLACEMENTS } from '../domain/types.js';

export interface PlantDraft {
  name: string;
  species: string;
  family: string;
  source: string;
  purchaseDate: string;
  placement: Placement;
  exposure: Exposure;
  potDiameterCm: string;
  lightProfile: LightProfile | '';
  /** 周期下限与上限，留空表示不设周期（引擎会降级为按历史推断） */
  intervalMin: string;
  intervalMax: string;
  notes: string;
}

export const EMPTY_DRAFT: PlantDraft = {
  name: '',
  species: '',
  family: '',
  source: '',
  purchaseDate: '',
  placement: '客厅',
  exposure: 'indoor_window',
  potDiameterCm: '',
  lightProfile: '',
  intervalMin: '',
  intervalMax: '',
  notes: '',
};

export type FieldErrors = Partial<Record<keyof PlantDraft, string>>;

export interface ValidationResult {
  ok: boolean;
  errors: FieldErrors;
  /** 归一化后的值，可直接入库。数字字段在这里完成字符串到数字的转换。 */
  parsed?: {
    potDiameterCm?: number;
    intervalMin?: number;
    intervalMax?: number;
  };
}

const POSITIVE = /^\d+(\.\d+)?$/;

export function validateDraft(d: PlantDraft): ValidationResult {
  const errors: FieldErrors = {};

  if (!d.name.trim()) {
    errors.name = '给这盆植物起个名字，同品种可以分 A / B / C';
  } else if (d.name.trim().length > 40) {
    errors.name = '名字太长了，40 字以内';
  }

  if (d.potDiameterCm !== '') {
    if (!POSITIVE.test(d.potDiameterCm)) {
      errors.potDiameterCm = '盆口径要是数字，单位 cm';
    } else {
      const v = Number(d.potDiameterCm);
      if (v <= 0 || v > 200) errors.potDiameterCm = '盆口径看起来不对，1 到 200 cm 之间';
    }
  }

  const hasMin = d.intervalMin.trim() !== '';
  const hasMax = d.intervalMax.trim() !== '';

  if (hasMin !== hasMax) {
    // 只填一个必然是笔误。宁可要求填两个，也不要留一个无效周期
    const msg = '周期要同时填下限和上限';
    if (hasMin) errors.intervalMin = msg;
    else errors.intervalMax = msg;
  } else if (hasMin && hasMax) {
    const min = Number(d.intervalMin);
    const max = Number(d.intervalMax);
    if (!POSITIVE.test(d.intervalMin) || !POSITIVE.test(d.intervalMax)) {
      errors.intervalMin = '周期要填数字，单位天';
      errors.intervalMax = errors.intervalMin;
    } else if (min < 1) {
      errors.intervalMin = '周期下限至少 1 天';
    } else if (max < min) {
      errors.intervalMax = '上限不能小于下限';
    } else if (max > 365) {
      errors.intervalMax = '上限超过一年了，确认一下是不是填错';
    }
  }

  if (d.purchaseDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(d.purchaseDate)) {
    errors.purchaseDate = '日期格式不对';
  }

  if (d.purchaseDate !== '') {
    const t = Date.parse(d.purchaseDate);
    if (!Number.isNaN(t) && t > Date.now()) {
      errors.purchaseDate = '购买日期不能是将来';
    }
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors };

  const parsed: ValidationResult['parsed'] = {};
  if (d.potDiameterCm !== '') parsed.potDiameterCm = Number(d.potDiameterCm);
  if (hasMin && hasMax) {
    parsed.intervalMin = Number(d.intervalMin);
    parsed.intervalMax = Number(d.intervalMax);
  }

  return { ok, errors, ...(parsed ? { parsed } : {}) };
}

export function isValidPlacement(v: string): v is Placement {
  return (PLACEMENTS as readonly string[]).includes(v);
}

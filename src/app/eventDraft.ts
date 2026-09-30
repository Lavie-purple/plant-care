/**
 * 事件记录的表单校验与类型元数据。
 *
 * 核心原则：**每种事件只问它真正需要的信息**。
 * 一张「所有类型通用的大表单」会让记换盆的人也去填「用了什么肥」，
 * 那正是这个产品一直在避免的复杂度。
 *
 * D-08 已经要求 metadata 不可退化成无约束的 JSON 袋，
 * 必填字段由 EVENT_REQUIRED_FIELDS 定义，这里负责把它翻译成人话。
 */

import type { PlantEventType } from '../domain/types.js';
import { EVENT_REQUIRED_FIELDS, PLANT_EVENT_TYPES } from '../domain/types.js';

/** 界面上展示的事件类型。按「常记的排前面」排序，不按枚举顺序。 */
export interface EventTypeMeta {
  type: PlantEventType;
  label: string;
  /** 一句话说明这个事件要记什么，显示在类型按钮下方 */
  hint: string;
  /** 标题是否必填 */
  needsTitle: boolean;
  /** 描述是否必填 */
  needsDescription: boolean;
  /** 常用场景下建议的标题占位 */
  titlePlaceholder: string;
}

/**
 * 事件类型元数据。
 *
 * 只列 UI 要展示的，WATERING 刻意排除——浇水有专门的三档快选入口，
 * 在这里再放一个会造成入口分裂（AGENTS.md：入口超过 20 项就上分组，
 * 而且同功能不该有两个入口）。
 */
export const EVENT_META: EventTypeMeta[] = [
  { type: 'PHOTO', label: '照片', hint: '随手拍一张', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：长高了' },
  { type: 'NEW_LEAF', label: '新叶', hint: '长出新叶', needsTitle: true, needsDescription: false, titlePlaceholder: '比如：展开第二片' },
  { type: 'FERTILIZING', label: '施肥', hint: '用了什么肥', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：缓释肥 5 粒' },
  { type: 'PRUNING', label: '修剪', hint: '剪掉什么', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：剪了徒长的两根' },
  { type: 'REPOTTING', label: '换盆', hint: '换成什么盆', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：换到 24cm 陶盆' },
  { type: 'FLOWERING', label: '开花', hint: '开花了', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：今年第一次开' },
  { type: 'FRUITING', label: '结果', hint: '结果了', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：结了 3 个' },
  { type: 'YELLOW_LEAF', label: '黄叶', hint: '叶子发黄', needsTitle: true, needsDescription: false, titlePlaceholder: '比如：下位老叶 2 片' },
  { type: 'SHED_LEAF', label: '掉叶', hint: '掉了叶子', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：换了位置后掉叶' },
  { type: 'PEST', label: '虫害', hint: '发现虫子', needsTitle: true, needsDescription: true, titlePlaceholder: '比如：叶背有小黑点' },
  { type: 'DISEASE', label: '病害', hint: '生病了', needsTitle: true, needsDescription: true, titlePlaceholder: '比如：根部发黑' },
  { type: 'STATUS_CHANGE', label: '状态变化', hint: '整体状态变了', needsTitle: false, needsDescription: false, titlePlaceholder: '比如：搬到南窗' },
  { type: 'NOTE', label: '备注', hint: '只写一句话', needsTitle: false, needsDescription: false, titlePlaceholder: '随便写点' },
  { type: 'CUSTOM', label: '自定义', hint: '其他', needsTitle: false, needsDescription: false, titlePlaceholder: '发生了什么' },
];

const META_BY_TYPE = new Map(EVENT_META.map((m) => [m.type, m]));

export function metaFor(type: PlantEventType): EventTypeMeta {
  return (
    META_BY_TYPE.get(type) ?? {
      type,
      label: type,
      hint: '',
      needsTitle: true,
      needsDescription: false,
      titlePlaceholder: '',
    }
  );
}

/**
 * 校验元数据与 schema 的必填定义是否一致。
 * 两边漂移会导致「界面说必填、校验说不必填」这类难查的 bug。
 */
export function metaMatchesSchema(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const m of EVENT_META) {
    const req = EVENT_REQUIRED_FIELDS[m.type] ?? [];
    const reqTitle = req.includes('title');
    const reqDesc = req.includes('description');
    if (reqTitle !== m.needsTitle) {
      problems.push(`${m.type}：schema ${reqTitle ? '要求' : '不要求'} title，元数据却是 ${m.needsTitle}`);
    }
    if (reqDesc !== m.needsDescription) {
      problems.push(`${m.type}：schema ${reqDesc ? '要求' : '不要求'} description，元数据却是 ${m.needsDescription}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export interface EventDraft {
  type: PlantEventType;
  date: string;
  title: string;
  description: string;
  notes: string;
  /** 照片 id 列表，由上传流程填入 */
  imageIds: string[];
}

export const EMPTY_EVENT_DRAFT: EventDraft = {
  type: 'PHOTO',
  date: '',
  title: '',
  description: '',
  notes: '',
  imageIds: [],
};

export type EventFieldErrors = Partial<Record<keyof EventDraft, string>>;

export interface EventValidation {
  ok: boolean;
  errors: EventFieldErrors;
  /**
   * 是否至少有一条可存的信息。
   * 什么都不填却点了保存，会产生一条空事件，污染时间线。
   */
  empty: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEvent(d: EventDraft): EventValidation {
  const errors: EventFieldErrors = {};
  const meta = metaFor(d.type);

  if (meta.needsTitle && !d.title.trim()) {
    errors.title = `${meta.label}需要一句话说明`;
  }
  if (meta.needsDescription && !d.description.trim()) {
    errors.description = `${meta.label}需要写清楚发现的情况`;
  }

  if (d.date !== '' && !DATE_RE.test(d.date)) {
    errors.date = '日期格式不对';
  }
  if (d.date !== '') {
    const t = Date.parse(d.date);
    if (!Number.isNaN(t) && t > Date.now() + 86_400_000) {
      errors.date = '日期不能是将来';
    }
  }

  if (d.title.length > 60) {
    errors.title = '标题太长了，60 字以内';
  }

  // PHOTO 的有效内容就是照片，其余类型靠文字
  const empty =
    d.type === 'PHOTO'
      ? d.imageIds.length === 0
      : !d.title.trim() && !d.description.trim() && !d.notes.trim() && d.imageIds.length === 0;
  if (empty) {
    errors.title = '这条记录是空的';
  }

  return { ok: Object.keys(errors).length === 0, errors, empty };
}

/** 事件在时间线与记录页显示的一行摘要 */
export function summarizeEvent(d: EventDraft): string {
  const meta = metaFor(d.type);
  const head = d.title.trim() || d.description.trim() || (d.imageIds.length > 0 ? `${d.imageIds.length} 张照片` : '');
  return head ? `${meta.label}　${head}` : meta.label;
}

export { PLANT_EVENT_TYPES };

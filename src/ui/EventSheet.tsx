import { useState } from 'react';
import { browserCodec, objectUrlFor } from '../data/images.js';
import {
  EMPTY_EVENT_DRAFT,
  EVENT_META,
  metaFor,
  validateEvent,
  type EventDraft,
  type EventFieldErrors,
} from '../app/eventDraft.js';
import type { PlantEvent } from '../domain/types.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface EventSheetProps {
  service: PlantCareService;
  plantId: string;
  plantName: string;
  /** 打开时预设的类型。快速拍照传 PHOTO，记一笔不传 */
  initialType?: EventDraft['type'];
  onClose: () => void;
  onSaved: (e: PlantEvent) => void;
}

/**
 * 记事件面板。
 *
 * 设计原则：每种事件只显示它需要的字段。
 * 换盆的人不该被问「用了什么肥」，随手拍一张不该被要求写标题。
 */
export function EventSheet({ service, plantId, plantName, initialType, onClose, onSaved }: EventSheetProps) {
  const [draft, setDraft] = useState<EventDraft>({ ...EMPTY_EVENT_DRAFT, type: initialType ?? 'PHOTO' });
  const [errors, setErrors] = useState<EventFieldErrors>({});
  const [previews, setPreviews] = useState<{ id: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const meta = metaFor(draft.type);

  function set<K extends keyof EventDraft>(k: K, v: EventDraft[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setTopError(null);
    try {
      const rec = await service.dataTransfer().saveImage(file, browserCodec);
      const url = objectUrlFor(rec.id, rec.blob);
      setPreviews((p) => [...p, { id: rec.id, url }]);
      setDraft((d) => ({ ...d, imageIds: [...d.imageIds, rec.id] }));
    } catch (e) {
      setTopError('照片没能存进去：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(id: string) {
    setPreviews((p) => p.filter((x) => x.id !== id));
    setDraft((d) => ({ ...d, imageIds: d.imageIds.filter((x) => x !== id) }));
  }

  async function save() {
    const r = validateEvent(draft);
    setErrors(r.errors);
    if (!r.ok) return;
    setBusy(true);
    setTopError(null);
    try {
      const ev = await service.addEvent(plantId, {
        type: draft.type,
        ...(draft.date ? { date: draft.date } : {}),
        ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
        images: draft.imageIds,
      });
      onSaved(ev);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mask" role="presentation" onClick={busy ? undefined : onClose} />
      <div className="sheet" role="dialog" aria-label="记一笔">
        <div className="sh-top">
          <span className="t-heading">记一笔</span>
          <span className="t-meta">{plantName}</span>
        </div>

        <div className="types" role="radiogroup" aria-label="事件类型">
          {EVENT_META.map((m) => (
            <button
              key={m.type}
              type="button"
              role="radio"
              aria-checked={draft.type === m.type}
              className={draft.type === m.type ? 'ty ty-on' : 'ty'}
              onClick={() => set('type', m.type)}
            >
              <span className="ty-l">{m.label}</span>
              <span className="t-meta">{m.hint}</span>
            </button>
          ))}
        </div>

        <label className="t-label" style={{ display: 'block', margin: '16px 0 6px', color: 'var(--t2)' }}>
          什么时候<span className="t-meta" style={{ marginLeft: 6 }}>留空表示今天</span>
        </label>
        <input
          className="ap-input"
          type="date"
          value={draft.date}
          onChange={(e) => set('date', e.target.value)}
          aria-label="事件日期"
        />
        {errors.date && <div className="t-meta err" role="alert">{errors.date}</div>}

        <label className="t-label" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--t2)' }}>
          {meta.needsTitle || meta.needsDescription ? '说明' : '一句话'}
          {meta.needsTitle ? <span className="t-meta" style={{ marginLeft: 6 }}>必填</span> : null}
        </label>
        <input
          className="ap-input"
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder={meta.titlePlaceholder}
          aria-label="事件说明"
        />
        {errors.title && <div className="t-meta err" role="alert">{errors.title}</div>}

        {meta.needsDescription && (
          <>
            <label className="t-label" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--t2)' }}>
              详细情况<span className="t-meta" style={{ marginLeft: 6 }}>必填</span>
            </label>
            <textarea
              className="ap-input"
              style={{ minHeight: 72, resize: 'vertical' }}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="看到什么、怎么处理的"
              aria-label="详细情况"
            />
            {errors.description && <div className="t-meta err" role="alert">{errors.description}</div>}
          </>
        )}

        <label className="t-label" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--t2)' }}>
          照片<span className="t-meta" style={{ marginLeft: 6 }}>可选，自动压缩</span>
        </label>
        <div className="shots">
          {previews.map((p) => (
            <div key={p.id} className="shot">
              <img src={p.url} alt="" />
              <button className="shot-x" type="button" onClick={() => removePhoto(p.id)} aria-label="移除这张照片">
                ✕
              </button>
            </div>
          ))}
          <label className="shot shot-add">
            <input type="file" accept="image/*" onChange={(e) => void onPickPhoto(e.target.files?.[0])} />
            <span>{uploading ? '…' : '＋'}</span>
          </label>
        </div>

        <label className="t-label" style={{ display: 'block', margin: '14px 0 6px', color: 'var(--t2)' }}>
          备注<span className="t-meta" style={{ marginLeft: 6 }}>可选</span>
        </label>
        <input
          className="ap-input"
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="其他想留一句的"
          aria-label="备注"
        />

        {topError && <div className="t-meta err" role="alert" style={{ marginTop: 12 }}>{topError}</div>}

        <div className="acts">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="button" disabled={busy || uploading} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        <style>{`
          .mask { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-sheet); }
          .sheet {
            position: fixed; left: 50%; transform: translateX(-50%);
            bottom: 0; z-index: var(--z-modal);
            width: min(560px, 100vw); max-height: 86dvh; overflow-y: auto;
            background: var(--sf); border: 1px solid var(--ln2);
            border-radius: var(--r-ctl) var(--r-ctl) 0 0;
            padding: var(--sp-4); box-shadow: var(--shadow-pop);
          }
          .sh-top { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--sp-3); }
          .types { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
          .ty { text-align: left; padding: 7px 9px; border: 1px solid var(--ln2); border-radius: var(--r-ctl); background: var(--sf); color: var(--t1); }
          .ty-on { border: 2px solid var(--t1); padding: 6px 8px; }
          .ty-l { display: block; font-size: var(--fs-label); font-weight: 600; margin-bottom: 2px; }
          .shots { display: flex; gap: 6px; flex-wrap: wrap; }
          .shot { position: relative; width: 64px; height: 64px; border: 1px solid var(--ln); border-radius: var(--r-ctl); overflow: hidden; }
          .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .shot-x { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 3px; border: none; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; line-height: 1; cursor: pointer; }
          .shot-add { display: flex; align-items: center; justify-content: center; border-style: dashed; color: var(--t3); cursor: pointer; font-size: 18px; }
          .shot-add input { display: none; }
          .t-meta.err { color: var(--acc); margin-top: 5px; }
          .acts { display: flex; gap: var(--sp-2); margin-top: var(--sp-5); }
          .acts .btn { flex: 1; text-align: center; }
        `}</style>
      </div>
    </>
  );
}

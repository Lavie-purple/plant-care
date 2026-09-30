import { useState } from 'react';
import { LIGHT_PROFILES, PLACEMENTS, type Exposure, type LightProfile, type Plant } from '../domain/types.js';
import { EMPTY_DRAFT, validateDraft, type FieldErrors, type PlantDraft } from '../app/plantDraft.js';
import { browserCodec, objectUrlFor } from '../data/images.js';
import type { PlantCareService } from '../app/vertical-slice.js';

export interface AddPlantProps {
  service: PlantCareService;
  onDone: (plant: Plant) => void;
  onCancel: () => void;
}

const EXPOSURES: { key: Exposure; label: string; hint: string }[] = [
  { key: 'indoor', label: '室内', hint: '不直接受雨影响' },
  { key: 'indoor_window', label: '室内靠窗', hint: '可能接到少量飘雨' },
  { key: 'semi_outdoor', label: '半户外', hint: '下雨会被淋到' },
  { key: 'outdoor', label: '露天', hint: '完全暴露在户外' },
];

export function AddPlant({ service, onDone, onCancel }: AddPlantProps) {
  const [draft, setDraft] = useState<PlantDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [photo, setPhoto] = useState<{ id: string; preview: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  function set<K extends keyof PlantDraft>(k: K, v: PlantDraft[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  }

  /**
   * 选图后立刻压缩并存库，不等到提交。
   * 万一用户填完表不想提交，照片也不会白传。
   */
  async function onPickPhoto(file: File | undefined) {
    if (!file) return;
    setSavingPhoto(true);
    setTopError(null);
    try {
      const rec = await service.dataTransfer().saveImage(file, browserCodec);
      setPhoto({ id: rec.id, preview: objectUrlFor(rec.id, rec.blob), name: file.name });
    } catch (e) {
      setTopError('照片没能存进去：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingPhoto(false);
    }
  }

  async function submit() {
    const r = validateDraft(draft);
    setErrors(r.errors);
    if (!r.ok) return;

    setBusy(true);
    setTopError(null);
    try {
      const plant = await service.addPlant({
        name: draft.name.trim(),
        placement: draft.placement,
        exposure: draft.exposure,
        ...(draft.species.trim() ? { species: draft.species.trim() } : {}),
        ...(draft.family.trim() ? { family: draft.family.trim() } : {}),
        ...(r.parsed?.potDiameterCm !== undefined ? { potDiameterCm: r.parsed.potDiameterCm } : {}),
        ...(draft.lightProfile ? { lightProfile: draft.lightProfile as LightProfile } : {}),
      });

      if (draft.source.trim()) {
        // 来源与备注走植物事件留痕，避免在 Plant 上加只写一次的字段
        await service.addNote(plant.id, `来源：${draft.source.trim()}`);
      }

      if (r.parsed?.intervalMin !== undefined && r.parsed.intervalMax !== undefined) {
        await service.setCareRule(plant.id, r.parsed.intervalMin, r.parsed.intervalMax);
      }

      if (photo) {
        await service.attachPhoto(plant.id, photo.id, '建档时的第一张照片');
      }

      onDone(plant);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ap">
      <header className="ap-top">
        <button className="btn" type="button" onClick={onCancel}>取消</button>
        <span className="t-title">添加植物</span>
        <span />
      </header>

      <div className="ap-body">
        {topError && <div className="ap-err">{topError}</div>}

        <Field label="名字" required error={errors.name}>
          <input className="ap-input" value={draft.name} onChange={(e) => set('name', e.target.value)}
            placeholder="龟背竹 A" />
        </Field>

        <div className="ap-2col">
          <Field label="品种" error={errors.species}>
            <input className="ap-input" value={draft.species} onChange={(e) => set('species', e.target.value)}
              placeholder="龟背竹" />
          </Field>
          <Field label="科" error={errors.family}>
            <input className="ap-input" value={draft.family} onChange={(e) => set('family', e.target.value)}
              placeholder="天南星科" />
          </Field>
        </div>

        <Field label="摆在哪" required>
          <div className="ap-chips">
            {PLACEMENTS.map((p) => (
              <button key={p} type="button" className={draft.placement === p ? 'chip chip-on' : 'chip'}
                onClick={() => set('placement', p)}>
                {p}
              </button>
            ))}
          </div>
        </Field>

        <Field label="暴露度" required>
          <div className="ap-expo">
            {EXPOSURES.map((e) => (
              <button key={e.key} type="button" onClick={() => set('exposure', e.key)}
                className={draft.exposure === e.key ? 'expo expo-on' : 'expo'}>
                <span className="expo-l">{e.label}</span>
                <span className="t-meta">{e.hint}</span>
              </button>
            ))}
          </div>
        </Field>

        <div className="ap-2col">
          <Field label="盆口径" unit="cm" error={errors.potDiameterCm}>
            <input className="ap-input num" inputMode="decimal" value={draft.potDiameterCm}
              onChange={(e) => set('potDiameterCm', e.target.value)} placeholder="18" />
          </Field>
          <Field label="购买日期" error={errors.purchaseDate}>
            <input className="ap-input" type="date" value={draft.purchaseDate}
              onChange={(e) => set('purchaseDate', e.target.value)} />
          </Field>
        </div>

        <Field label="浇水周期" unit="天" error={errors.intervalMin ?? errors.intervalMax}
          hint="先不确定可以留空，系统会用它自己的历史推断。">
          <div className="ap-cycle">
            <input className="ap-input num" inputMode="numeric" value={draft.intervalMin}
              onChange={(e) => set('intervalMin', e.target.value)} placeholder="7" aria-label="周期下限" />
            <span className="t-meta">到</span>
            <input className="ap-input num" inputMode="numeric" value={draft.intervalMax}
              onChange={(e) => set('intervalMax', e.target.value)} placeholder="10" aria-label="周期上限" />
          </div>
        </Field>

        <Field label="光照">
          <div className="ap-chips">
            <button type="button" className={draft.lightProfile === '' ? 'chip chip-on' : 'chip'}
              onClick={() => set('lightProfile', '')}>不确定</button>
            {LIGHT_PROFILES.map((l) => (
              <button key={l} type="button" className={draft.lightProfile === l ? 'chip chip-on' : 'chip'}
                onClick={() => set('lightProfile', l)}>{l}</button>
            ))}
          </div>
        </Field>

        <Field label="来源 / 店铺">
          <input className="ap-input" value={draft.source} onChange={(e) => set('source', e.target.value)}
            placeholder="X 花园，180 元" />
        </Field>

        <Field label="照片" hint="可选。会压缩到长边 1600，重复的图不会存两份。">
          {photo ? (
            <div className="ap-photo">
              <img src={photo.preview} alt="已选择的照片" />
              <button className="btn" type="button" onClick={() => setPhoto(null)}>换一张</button>
            </div>
          ) : (
            <label className="ap-drop">
              <input type="file" accept="image/*" onChange={(e) => void onPickPhoto(e.target.files?.[0])} />
              <span className="t-label">{savingPhoto ? '正在处理…' : '选择照片'}</span>
            </label>
          )}
        </Field>
      </div>

      <div className="ap-actions">
        <button className="btn btn-primary btn-block" type="button" disabled={busy || savingPhoto}
          onClick={() => void submit()}>
          {busy ? '保存中…' : '添加'}
        </button>
      </div>

      <style>{`
        /* 100% 在这里无效：.app-main 没有显式高度。用 100dvh 直接锚定视口，
           避免百分比高度链断裂后 sticky 底栏失效、内容溢出。 */
        .ap { display: flex; flex-direction: column; min-height: 100dvh; }
        .ap-top { position: sticky; top: 0; z-index: var(--z-sticky); display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); background: var(--sf); border-bottom: 1px solid var(--ln); }
        .ap-body { flex: 1; padding: var(--sp-4); }
        .ap-err { margin-bottom: var(--sp-4); padding: 10px 12px; border: 1px solid var(--ln2); border-radius: var(--r-ctl); font-size: var(--fs-label); color: var(--t2); }
        .ap-2col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
        .ap-chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .ap-expo { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .expo { text-align: left; padding: 8px 10px; border: 1px solid var(--ln2); border-radius: var(--r-ctl); background: var(--sf); color: var(--t1); }
        .expo-on { border: 2px solid var(--t1); padding: 7px 9px; }
        .expo-l { display: block; font-size: var(--fs-label); font-weight: 600; margin-bottom: 2px; }
        .ap-cycle { display: flex; align-items: center; gap: var(--sp-2); }
        .ap-cycle .ap-input { width: 84px; }
        .ap-photo { display: flex; gap: var(--sp-3); align-items: center; }
        .ap-photo img { width: 96px; height: 96px; object-fit: cover; border-radius: var(--r-ctl); border: 1px solid var(--ln); }
        .ap-drop { display: block; padding: 20px; border: 1px dashed var(--ln2); border-radius: var(--r-ctl); text-align: center; cursor: pointer; }
        .ap-drop input { display: none; }
        .ap-actions { position: sticky; bottom: var(--nav-h); padding: var(--sp-3) var(--sp-4); background: var(--sf); border-top: 1px solid var(--ln); z-index: 1; }
      `}</style>
    </div>
  );
}

function Field({
  label,
  children,
  error,
  hint,
  unit,
  required,
}: {
  label: string;
  children: React.ReactNode;
  error?: string | undefined;
  hint?: string;
  unit?: string;
  required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 'var(--sp-4)' }}>
      <label className="t-label" style={{ display: 'block', marginBottom: 6, color: 'var(--t2)' }}>
        {label}
        {required && <span style={{ color: 'var(--t3)' }}>　必填</span>}
        {unit && <span className="t-meta" style={{ marginLeft: 6 }}>单位 {unit}</span>}
      </label>
      {children}
      {hint && !error && <div className="t-meta" style={{ marginTop: 5 }}>{hint}</div>}
      {error && (
        <div className="t-meta" style={{ marginTop: 5, color: 'var(--acc)' }} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}


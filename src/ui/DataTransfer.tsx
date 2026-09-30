import { useState } from 'react';
import { DataTransferService, describeImportPreview, type ImageIntegrity } from '../data/DataTransferService.js';
import { describeProblem, type ImportMode, type ImportValidation } from '../data/exportBundle.js';
import { supportsDirectoryPicker } from '../data/exportFiles.js';
import type { ImageRecord } from '../domain/types.js';

export interface DataTransferProps {
  transfer: DataTransferService;
}

type Stage = 'idle' | 'preview' | 'done';

export function DataTransfer({ transfer }: DataTransferProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [integrity, setIntegrity] = useState<ImageIntegrity | null>(null);
  const [importedImages, setImportedImages] = useState<ImageRecord[]>([]);
  const [imageCount, setImageCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  async function doExport() {
    setBusy(true);
    setError(null);
    setExportNote(null);
    try {
      const target = await transfer.exportNow();
      setExportNote(describeExport(target));
    } catch (e) {
      if (isAbort(e)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRead() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await transfer.readImport();
      setValidation(r.validation);
      setIntegrity(r.integrity);
      setImportedImages(r.__images);
      setImageCount(r.imageCount);
      setStage('preview');
    } catch (e) {
      if (isAbort(e)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doImport(mode: ImportMode) {
    if (!validation?.bundle) return;
    setBusy(true);
    setError(null);
    try {
      const r = await transfer.commitImport(validation.bundle, importedImages, mode);
      const added = Object.entries(r.added)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => n + ' 条 ' + (LABEL[k] ?? k))
        .join('，');
      const skippedNote = r.skipped > 0 ? '，' + r.skipped + ' 条因 id 相同被跳过（未覆盖你的数据）' : '';
      const imgNote = r.imageCount > 0 ? '，' + r.imageCount + ' 张照片' : '';
      setMessage(
        (mode === 'replace' ? '已完全替换。' : '已合并。') + added + imgNote + skippedNote,
      );
      setStage('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---------- 预览：写入前必须让人看一眼 ----------
  if (stage === 'preview' && validation) {
    const blocked = !validation.ok || (integrity !== null && !integrity.ok);
    return (
      <div className="dt">
        <header className="dt-top">
          <button className="btn" type="button" onClick={() => { setStage('idle'); setValidation(null); }}>
            ← 返回
          </button>
          <span className="t-title">导入预览</span>
          <span />
        </header>

        <div className="dt-body">
          {!validation.ok ? (
            <>
              <div className="dt-danger">这份数据无法导入，已拒绝写入。</div>
              <div className="t-meta" style={{ marginTop: 6 }}>
                下面是全部问题（{validation.problems.length} 条）。为避免产生半截数据，本次导入整体中止。
              </div>
              <ul className="dt-problems">
                {validation.problems.slice(0, 20).map((p, i) => (
                  <li key={i} className="t-secondary">{describeProblem(p)}</li>
                ))}
                {validation.problems.length > 20 && (
                  <li className="t-meta">还有 {validation.problems.length - 20} 条</li>
                )}
              </ul>
            </>
          ) : (
            <>
              <div className="t-secondary">这份备份包含：</div>
              <div className="t-title" style={{ marginTop: 6, fontSize: 17 }}>
                {describeImportPreview(validation.summary, imageCount)}
              </div>
              <div className="t-meta" style={{ marginTop: 8 }}>
                导出于 {validation.bundle?.exportedAt.slice(0, 16).replace('T', ' ')}　·　数据版本{' '}
                {validation.bundle?.schemaVersion}
              </div>

              {integrity && (
                <div className={'t-meta ' + (integrity.ok ? 'dt-ok' : 'dt-danger')}>
                  {integrity.ok
                    ? '图片完整：被引用的 ' + integrity.referenced + ' 张全部找到了'
                    : '有 ' + integrity.missing.length +
                      ' 张照片找不到，导入会被拒绝。否则你只会看到一片碎图，而且不知道丢了什么。'}
                </div>
              )}

              <div className="dt-choices">
                <div className="dt-choice">
                  <div className="t-h">合并</div>
                  <div className="t-meta">
                    保留你现在的数据，只加入备份里没有的。id 相同的记录会被跳过，
                    <b style={{ color: 'var(--t1)' }}>不会覆盖你改过的内容</b>。
                  </div>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busy || blocked}
                    onClick={() => void doImport('merge')}
                  >
                    合并导入
                  </button>
                </div>
                <div className="dt-choice danger">
                  <div className="t-h">完全替换</div>
                  <div className="t-meta">
                    先清空当前所有数据，再写入这份备份。
                    <b style={{ color: 'var(--acc)' }}>此操作不可撤销</b>。
                  </div>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || blocked}
                    onClick={() => void doImport('replace')}
                  >
                    清空并导入
                  </button>
                </div>
              </div>

              {blocked && (
                <div className="t-meta" style={{ marginTop: 10, color: 'var(--acc)' }}>
                  按钮已禁用。修好上面的问题或换一份完整的备份再来。
                </div>
              )}
            </>
          )}
        </div>

        {error && <div className="dt-err">{error}</div>}
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 22, textAlign: 'center' }}>
          <div className="t-title">导入完成</div>
          <div className="t-secondary" style={{ marginTop: 10 }}>{message}</div>
          <button
            className="btn btn-primary"
            type="button"
            style={{ marginTop: 18, width: '100%' }}
            onClick={() => { setStage('idle'); setMessage(null); }}
          >
            完成
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dt">
      <header className="dt-top">
        <span className="t-title">导出与导入</span>
      </header>

      <div className="dt-body">
        <div className="t-secondary">
          所有数据只存在这台设备的浏览器里，没有云端也没有自动备份。清一次浏览器缓存就会全部丢失。
        </div>

        <div className="dt-card">
          <div className="t-h">导出</div>
          <div className="t-meta" style={{ marginTop: 6 }}>
            {supportsDirectoryPicker()
              ? '选择一个文件夹，会写入 data.json（植物、记录、事件、决定日志）和 images/ 下的照片。'
              : '当前浏览器不支持选择目录（手机端都不支持），会打包成一个 ZIP 下载，解压后同样包含 data.json 和 images 文件夹。'}
          </div>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void doExport()}>
            {busy ? '处理中…' : '导出到文件夹'}
          </button>
          {exportNote && <div className="t-meta" style={{ color: 'var(--acc)', marginTop: 8 }}>{exportNote}</div>}
        </div>

        <div className="dt-card">
          <div className="t-h">导入</div>
          <div className="t-meta" style={{ marginTop: 6 }}>
            选择之前导出过的文件夹。导入前会先校验数据与照片完整性，并让你确认内容。
          </div>
          <button className="btn" type="button" disabled={busy} onClick={() => void doRead()}>
            选择备份文件夹
          </button>
        </div>

        <div className="dt-note">
          <div className="t-meta">导入采用「先校验、让你确认、再写入」的流程。</div>
          <div className="t-meta" style={{ marginTop: 4 }}>
            只要有一条记录不合法，或有一张照片找不到，整份数据都会被拒绝。
            不会出现导进去一半的情况，也不会出现一片碎图。
          </div>
        </div>
      </div>

      {error && <div className="dt-err">{error}</div>}

      <style>{`
        .dt { display: flex; flex-direction: column; }
        .dt-top { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--ln); }
        .dt-body { padding: var(--sp-5) var(--sp-4); }
        .dt-card { margin-top: var(--sp-4); padding: var(--sp-4); border: 1px solid var(--ln); border-radius: var(--r-ctl); }
        .dt-card .btn { margin-top: 12px; width: 100%; }
        .dt-choices { display: grid; gap: var(--sp-3); margin-top: var(--sp-5); }
        .dt-choice { padding: var(--sp-3); border: 1px solid var(--ln); border-radius: var(--r-ctl); }
        .dt-choice.danger { border-color: var(--ln2); }
        .dt-choice .btn { margin-top: 10px; width: 100%; }
        .dt-note { margin-top: var(--sp-5); padding-top: var(--sp-4); border-top: 1px solid var(--ln); }
        .dt-danger { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--acc); border-radius: var(--r-ctl); color: var(--acc); font-size: var(--fs-label); }
        .dt-ok { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--ln); border-radius: var(--r-ctl); color: var(--t2); }
        .dt-problems { margin-top: 10px; padding-left: 18px; }
        .dt-problems li { margin-bottom: 4px; }
        .dt-err { margin: 0 var(--sp-4) var(--sp-4); padding: 10px 12px; border: 1px solid var(--ln2); border-radius: var(--r-ctl); font-size: var(--fs-label); color: var(--t2); }
      `}</style>
    </div>
  );
}

const LABEL: Record<string, string> = {
  plants: '植物',
  careRules: '规则',
  wateringRecords: '浇水',
  plantEvents: '事件',
  decisionLogs: '决定',
  settings: '设置',
  pendingConflicts: '冲突',
};

/** 用户取消目录选择不是错误，不该弹错误提示 */
function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * 导出结果说明。
 *
 * 关键：图片没跟出去时必须说清楚。降级路径只下载了 JSON，
 * 不告诉用户的话他会以为备份是完整的。
 */
function describeExport(t: {
  usedDirectory: boolean;
  fileName?: string;
  imageCount: number;
  declaredImageCount: number;
}): string {
  if (!t.usedDirectory) {
    // 移动端全都不支持选目录，走的是 ZIP 打包路径，照片在里面
    if (t.imageCount < t.declaredImageCount) {
      return '已打包成 ' + t.fileName + '，但只有 ' + t.imageCount + ' / ' + t.declaredImageCount +
        ' 张照片进去了。解压后检查 images 文件夹。';
    }
    return '已打包成 ' + t.fileName + '，含 ' + t.imageCount + ' 张照片。在电脑上解压即可。';
  }
  if (t.declaredImageCount === 0) {
    return '已导出到 ' + t.fileName + '，暂无照片。';
  }
  if (t.imageCount < t.declaredImageCount) {
    return '已导出 ' + t.fileName + '，但只写出了 ' + t.imageCount + ' / ' + t.declaredImageCount +
      ' 张照片，其余失败。请检查磁盘空间或权限。';
  }
  return '已导出 ' + t.fileName + '，含 ' + t.imageCount + ' 张照片（在同目录 images/ 下）。';
}

import { useState } from 'react';
import { DataTransferService, describeImportPreview } from '../data/DataTransferService.js';
import { describeProblem, type ImportMode, type ImportValidation } from '../data/exportBundle.js';
import { supportsDirectoryPicker } from '../data/exportFiles.js';

export interface DataTransferProps {
  transfer: DataTransferService;
}

type Stage = 'idle' | 'preview' | 'done';

export function DataTransfer({ transfer }: DataTransferProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  async function doExport() {
    setBusy(true);
    setError(null);
    setExportNote(null);
    try {
      const target = await transfer.exportNow();
      setExportNote(
        target.usedDirectory
          ? `已导出到 ${target.fileName}，图片在同目录的 images/ 下。`
          : `当前浏览器不支持选择目录，已改为下载 ${target.fileName}。`,
      );
    } catch (e) {
      // 用户取消目录选择不算错误，区别对待
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function doRead() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const v = await transfer.readImport();
      setValidation(v);
      setStage('preview');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function doImport(mode: ImportMode) {
    if (!validation?.bundle) return;
    setBusy(true);
    setError(null);
    try {
      const r = await transfer.commitImport(validation.bundle, mode);
      const added = Object.entries(r.added)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} 条${k}`)
        .join('，');
      setMessage(
        mode === 'replace'
          ? `已完全替换。${added}${r.skipped > 0 ? `，跳过 ${r.skipped} 条` : ''}`
          : `已合并。${added}${r.skipped > 0 ? `，${r.skipped} 条因 id 相同被跳过（未覆盖你的数据）` : ''}`,
      );
      setStage('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---------- 预览阶段：必须在写入前让人看一眼 ----------
  if (stage === 'preview' && validation) {
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
              <div className="dt-danger">
                这份数据无法导入，已拒绝写入。
              </div>
              <div className="t-meta" style={{ marginTop: 6 }}>
                下面是全部问题（{validation.problems.length} 条）。为避免产生半截数据，本次导入整体中止。
              </div>
              <ul className="dt-problems">
                {validation.problems.slice(0, 20).map((p, i) => (
                  <li key={i} className="t-secondary">{describeProblem(p)}</li>
                ))}
                {validation.problems.length > 20 && (
                  <li className="t-meta">…还有 {validation.problems.length - 20} 条</li>
                )}
              </ul>
            </>
          ) : (
            <>
              <div className="t-secondary">这份备份包含：</div>
              <div className="t-title" style={{ marginTop: 6, fontSize: 17 }}>
                {describeImportPreview(validation.summary)}
              </div>
              <div className="t-meta" style={{ marginTop: 8 }}>
                导出于 {validation.bundle?.exportedAt.slice(0, 16).replace('T', ' ')}　·　数据版本{' '}
                {validation.bundle?.schemaVersion}
              </div>

              <div className="dt-choices">
                <div className="dt-choice">
                  <div className="t-h">合并</div>
                  <div className="t-meta">
                    保留你现在的数据，只加入备份里没有的。id 相同的记录会被跳过，
                    <b style={{ color: 'var(--t1)' }}>不会覆盖你改过的内容</b>。
                  </div>
                  <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void doImport('merge')}>
                    合并导入
                  </button>
                </div>
                <div className="dt-choice danger">
                  <div className="t-h">完全替换</div>
                  <div className="t-meta">
                    先清空当前所有数据，再写入这份备份。<b style={{ color: 'var(--acc)' }}>此操作不可撤销</b>。
                  </div>
                  <button className="btn" type="button" disabled={busy} onClick={() => void doImport('replace')}>
                    清空并导入
                  </button>
                </div>
              </div>
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
          <button className="btn btn-primary" type="button" style={{ marginTop: 18, width: '100%' }}
            onClick={() => { setStage('idle'); setMessage(null); }}>
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
          所有数据只存在这台设备的浏览器里，没有云端也没有自动备份。
          清一次浏览器缓存就会全部丢失。
        </div>

        <div className="dt-card">
          <div className="t-h">导出</div>
          <div className="t-meta" style={{ marginTop: 6 }}>
            {supportsDirectoryPicker()
              ? '选择一个文件夹，会写入 data.json（植物、记录、事件、决定日志）。'
              : '当前浏览器不支持选择目录，将改为下载一个 JSON 文件。'}
          </div>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void doExport()}>
            {busy ? '处理中…' : '导出到文件夹'}
          </button>
          {exportNote && <div className="t-meta" style={{ color: 'var(--acc)' }}>{exportNote}</div>}
        </div>

        <div className="dt-card">
          <div className="t-h">导入</div>
          <div className="t-meta" style={{ marginTop: 6 }}>
            选择之前导出过的文件夹，导入前会先校验并让你确认内容。
          </div>
          <button className="btn" type="button" disabled={busy} onClick={() => void doRead()}>
            选择备份文件夹
          </button>
        </div>

        <div className="dt-note">
          <div className="t-meta">导入采用「先校验、让你确认、再写入」的流程。</div>
          <div className="t-meta" style={{ marginTop: 4 }}>
            只要有一条记录不合法，整份数据都会被拒绝，不会出现导进去一半的情况。
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
        .dt-danger { padding: 10px 12px; border: 1px solid var(--acc); border-radius: var(--r-ctl); color: var(--acc); font-weight: 600; }
        .dt-problems { margin-top: 10px; padding-left: 18px; }
        .dt-problems li { margin-bottom: 4px; }
        .dt-err { margin: 0 var(--sp-4) var(--sp-4); padding: 10px 12px; border: 1px solid var(--ln2); border-radius: var(--r-ctl); font-size: var(--fs-label); color: var(--t2); }
      `}</style>
    </div>
  );
}

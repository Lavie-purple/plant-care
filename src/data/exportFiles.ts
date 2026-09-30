/**
 * 导出导入的文件读写层（D-18）。
 *
 * 用户浏览器是 Chrome / Edge，都完整支持 File System Access API（D-18）。
 * 但仍保留降级路径：Safari / Firefox 不支持该 API，检测到时降级为
 * 单个 JSON 下载，并在界面上明确说明「已改为下载文件，图片不在其中」。
 *
 * 降级不是「假装成功」。图片导不出去这件事必须让用户知道，
 * 否则他会以为备份是完整的。
 */

import type { ExportBundle } from './exportBundle.js';
import type { ImageRecord } from '../domain/types.js';
import { createZip, type ZipEntry } from './zip.js';

export const DATA_FILE = 'data.json';
export const IMAGE_DIR = 'images';

/** 内部用：把图片挂在 bundle 上一起传递，避免额外的返回值通道 */
type BundleWithImages = ExportBundle & { __images?: ImageRecord[] };

type PickerWindow = Window & {
  showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export interface ExportTarget {
  /** true = 用户选了目录，数据写成 data.json + images/ */
  usedDirectory: boolean;
  /** 降级下载时为文件名 */
  fileName?: string;
  /** 实际写出的图片数。0 表示图片没有跟出去，界面必须说明 */
  imageCount: number;
  /** 清单里声明的图片数，用于对比实际写出数 */
  declaredImageCount: number;
}

export async function exportToDirectory(
  bundle: ExportBundle,
  images: ImageRecord[],
): Promise<ExportTarget> {
  const declared = bundle.images.length;

  if (!supportsDirectoryPicker()) {
    // 降级：选目录在移动端全部不可用（iOS Safari、Android Chrome 都没有）。
    // 打包成 ZIP 下载：data.json + images/ 一起进去，用户在电脑上解压即可。
    // 早先这里只下载 JSON，照片全丢——等于手机上拍的照片拿不出来。
    const fileName = suggestedName(bundle) + '.zip';
    const packed = await packZip(bundle, images);
    return {
      usedDirectory: false,
      fileName,
      imageCount: packed,
      declaredImageCount: declared,
    };
  }

  const dir = await (window as unknown as PickerWindow).showDirectoryPicker({ mode: 'readwrite' });

  const name = await uniqueFileName(dir, suggestedName(bundle));
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(bundle, null, 2));
  await w.close();

  // D-18：图片必须真的跟出去。只导出引用等于假装备份过。
  const written = await writeImages(dir, images);

  return { usedDirectory: true, fileName: name, imageCount: written, declaredImageCount: declared };
}

/**
 * 打包成 ZIP 下载。这是移动端唯一能带照片出去的路径。
 * 返回实际写入的图片数。
 */
async function packZip(bundle: ExportBundle, images: ImageRecord[]): Promise<number> {
  const entries: ZipEntry[] = [
    { name: DATA_FILE, data: new TextEncoder().encode(JSON.stringify(bundle, null, 2)) },
  ];
  for (const rec of images) {
    try {
      entries.push({ name: IMAGE_DIR + '/' + rec.fileName, data: new Uint8Array(await rec.blob.arrayBuffer()) });
    } catch {
      // 单张读不出就跳过，最后如实报告条数
    }
  }
  const blob = createZip(entries);
  triggerDownload(blob, suggestedName(bundle) + '.zip');
  return entries.length - 1;
}

/** 把图片写进 images/ 子目录，返回成功写出的条数 */
async function writeImages(dir: FileSystemDirectoryHandle, images: ImageRecord[]): Promise<number> {
  if (images.length === 0) return 0;
  const imgDir = await dir.getDirectoryHandle(IMAGE_DIR, { create: true });
  let ok = 0;
  for (const rec of images) {
    try {
      const fh = await imgDir.getFileHandle(rec.fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(rec.blob);
      await w.close();
      ok += 1;
    } catch {
      // 单张失败不中断整次导出，最后如实报告成功条数
    }
  }
  return ok;
}

export interface ImportPayload {
  bundle: ExportBundle;
  images: ImageRecord[];
}

/** 导入：选目录，同时读 data.json 与 images/ */
export async function importFromDirectory(): Promise<ImportPayload> {
  if (!supportsDirectoryPicker()) {
    const raw = (await importFromFileInput()) as BundleWithImages;
    return { bundle: raw, images: raw.__images ?? [] };
  }
  const dir = await (window as unknown as PickerWindow).showDirectoryPicker({ mode: 'read' });
  const fh = await dir.getFileHandle(DATA_FILE);
  const file = await fh.getFile();
  const bundle = (await parseJson(await file.text())) as BundleWithImages;
  const images = await readImages(dir, bundle);
  return { bundle, images };
}

/** 读回 images/ 目录里的图片，按清单顺序 */
async function readImages(
  dir: FileSystemDirectoryHandle,
  bundle: ExportBundle,
): Promise<ImageRecord[]> {
  const entries = bundle.images ?? [];
  if (entries.length === 0) return [];
  let imgDir: FileSystemDirectoryHandle;
  try {
    imgDir = await dir.getDirectoryHandle(IMAGE_DIR);
  } catch {
    return [];
  }
  const out: ImageRecord[] = [];
  for (const entry of entries) {
    try {
      const fh = await imgDir.getFileHandle(entry.fileName);
      const file = await fh.getFile();
      out.push({ ...entry, blob: file, version: 1 });
    } catch {
      // 缺图会在引用完整性检查里被报出来，不在这里静默跳过
    }
  }
  return out;
}

/** 降级路径：普通文件选择 */
export function pickDataFile(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) resolve(f);
      else reject(new Error('未选择文件'));
    };
    input.click();
  });
}

async function importFromFileInput(): Promise<unknown> {
  const file = await pickDataFile();
  return parseJson(await file.text());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    // 把原始错误带出去，便于诊断
    throw new Error('文件不是合法 JSON：' + (e instanceof Error ? e.message : String(e)));
  }
}

function suggestedName(bundle: ExportBundle): string {
  return 'plant-data-' + bundle.exportedAt.slice(0, 10);
}

/** 目录里已有同名文件时加时间戳，绝不静默覆盖用户的旧备份 */
async function uniqueFileName(dir: FileSystemDirectoryHandle, base: string): Promise<string> {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  try {
    await dir.getFileHandle(base + '.json');
    return base + '-' + stamp + '.json';
  } catch {
    return base + '.json';
  }
}

/** 触发浏览器下载。用完延迟释放，立即 revoke 会让部分浏览器中断下载 */
function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 仅导出 JSON，不含图片。供「我确定不要照片」的场景使用 */
export function downloadAsFile(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  triggerDownload(blob, suggestedName(bundle) + '.json');
}

const PREVIEW_LABEL: Record<string, string> = {
  plants: '盆植物',
  careRules: '养护规则',
  wateringRecords: '浇水记录',
  plantEvents: '事件',
  weatherSnapshots: '天气快照',
  recommendations: '建议',
  pendingConflicts: '规则冲突',
  decisionLogs: '决定日志',
  settings: '设置',
};

/** 预检文案。让用户在真正写入前看到「将导入什么」。 */
export function describeImportPreview(summary: Record<string, number>, images: number): string {
  const parts = Object.entries(summary)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => n + ' ' + (PREVIEW_LABEL[k] ?? k));
  if (images > 0) parts.push(images + ' 张照片');
  return parts.join('，');
}

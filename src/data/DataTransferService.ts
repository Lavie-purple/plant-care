import type { Repository } from '../storage/repository.js';
import { STORES } from '../storage/indexeddb.js';
import type { ImageRecord, ImageManifestEntry, Settings } from '../domain/types.js';
import { applyImport, buildBundle, validateBundle, type ExportBundle, type ImportMode, type ImportValidation } from './exportBundle.js';
import { checkImageReferences, collectReferencedImageIds, fileNameFor, hashBlob, type ImageCodec } from './images.js';
import { compressImage } from './images.js';
import { describeImportPreview, exportToDirectory, importFromDirectory, supportsDirectoryPicker, type ExportTarget, type ImportPayload } from './exportFiles.js';

/** 引用完整性检查结果，供界面在写入前展示 */
export interface ImageIntegrity {
  ok: boolean;
  referenced: number;
  available: number;
  missing: string[];
}

/**
 * 数据搬运服务。
 *
 * 两条硬保证：
 *   1. 结构校验不通过绝不落库。
 *   2. 图片引用不完整也不落库。导进来一堆指向不存在图片的记录，
 *      用户看到的是一片碎图，而且他根本不知道丢了什么。
 */
export class DataTransferService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: { now: () => Date },
  ) {}

  async collect(): Promise<ExportBundle> {
    const [
      plants, careRules, wateringRecords, plantEvents, weatherSnapshots,
      recommendations, pendingConflicts, decisionLogs, settings, images,
    ] = await Promise.all([
      this.repo.getAll(STORES.plants),
      this.repo.getAll(STORES.careRules),
      this.repo.getAll(STORES.wateringRecords),
      this.repo.getAll(STORES.plantEvents),
      this.repo.getAll(STORES.weatherSnapshots),
      this.repo.getAll(STORES.recommendations),
      this.repo.getAll(STORES.pendingConflicts),
      this.repo.getAll(STORES.decisionLogs),
      this.repo.getAll<Settings>(STORES.settings),
      this.repo.allImages(),
    ]);

    return buildBundle({
      plants: plants as never,
      careRules: careRules as never,
      wateringRecords: wateringRecords as never,
      plantEvents: plantEvents as never,
      weatherSnapshots: weatherSnapshots as never,
      recommendations: recommendations as never,
      pendingConflicts: pendingConflicts as never,
      decisionLogs: decisionLogs as never,
      settings: settings as never,
      images: (images as unknown as ImageRecord[]).map(toManifest),
      now: this.clock.now(),
    });
  }

  async exportNow(): Promise<ExportTarget> {
    const images = await this.repo.allImages();
    return exportToDirectory(await this.collect(), images);
  }

  /**
   * 存一张图片：压缩 → 算哈希 → 去重 → 落库。
   * 同内容重复上传直接返回已有记录，不占两份空间。
   */
  async saveImage(file: Blob, codec: ImageCodec): Promise<ImageRecord> {
    const compressed = await compressImage(file, codec);
    const hash = await hashBlob(compressed.blob);
    const mimeType = compressed.mimeType;
    return this.repo.putImage({
      hash,
      blob: compressed.blob,
      fileName: fileNameFor('img-' + hash, mimeType),
      mimeType,
      bytes: compressed.bytes,
      width: compressed.width,
      height: compressed.height,
      originalBytes: compressed.originalBytes,
      createdAt: this.clock.now().toISOString(),
    });
  }

  /**
   * 导入分两步：先读并校验（readImport），用户确认后再写（commitImport）。
   * 绝不「读进来直接写」，中间必须有人看一眼的机会。
   */
  async readImport(): Promise<{
    validation: ImportValidation;
    integrity: ImageIntegrity;
    imageCount: number;
    /** 图片本体，commitImport 时要一起写回 */
    __images: ImageRecord[];
  }> {
    const payload: ImportPayload = await importFromDirectory();
    const validation = validateBundle(payload.bundle);
    const integrity = checkIntegrity(payload.bundle, payload.images);
    return {
      validation,
      integrity,
      imageCount: payload.images.length,
      __images: payload.images,
    };
  }

  /**
   * 写入已通过校验的数据。
   * 校验与图片完整性都会再查一次作为防御，不信任调用方的判断。
   */
  async commitImport(
    bundle: ExportBundle,
    images: ImageRecord[],
    mode: ImportMode,
  ): Promise<{ skipped: number; added: Record<string, number>; imageCount: number }> {
    const re = validateBundle(bundle);
    if (!re.ok || !re.bundle) {
      throw new Error('导入数据未通过校验，已拒绝写入');
    }
    const integrity = checkIntegrity(re.bundle, images);
    if (!integrity.ok) {
      throw new Error(
        '备份里有 ' + integrity.missing.length + ' 张照片找不到，为避免产生碎图已拒绝导入',
      );
    }

    const existing = (await this.collect()).data;
    const result = applyImport(re.bundle, existing, mode);

    if (mode === 'replace') {
      await this.repo.clear();
    }
    await this.writeAll(result.bundle, images);
    return { skipped: result.skipped.length, added: result.added, imageCount: images.length };
  }

  private async writeAll(bundle: ExportBundle, images: ImageRecord[]): Promise<void> {
    const d = bundle.data;
    for (const p of d.plants) await this.repo.put(STORES.plants, p);
    for (const r of d.careRules) await this.repo.put(STORES.careRules, r);
    for (const w of d.wateringRecords) await this.repo.put(STORES.wateringRecords, w);
    for (const e of d.plantEvents) await this.repo.put(STORES.plantEvents, e);
    for (const c of d.pendingConflicts) await this.repo.put(STORES.pendingConflicts, c);
    for (const s of d.settings) await this.repo.saveSettings(s);
    for (const log of d.decisionLogs) await this.repo.recordDecision(log);
    // 天气快照与建议是派生数据，重算即可，不导入

    for (const img of images) {
      await this.repo.putImage({
        hash: img.hash,
        blob: img.blob,
        fileName: img.fileName,
        mimeType: img.mimeType,
        bytes: img.bytes,
        width: img.width,
        height: img.height,
        originalBytes: img.originalBytes,
        createdAt: img.createdAt,
      });
    }
  }

  supportsPicker(): boolean {
    return supportsDirectoryPicker();
  }
}

function checkIntegrity(bundle: ExportBundle, available: ImageRecord[]): ImageIntegrity {
  const referenced = collectReferencedImageIds(bundle.data);
  const r = checkImageReferences(referenced, available.map((i) => i.id));
  return { ok: r.ok, referenced: r.referenced, available: available.length, missing: r.missing };
}

/** ImageRecord 去掉 blob，产出写进 data.json 的清单条目 */
function toManifest(r: ImageRecord): ImageManifestEntry {
  const { blob: _blob, version: _version, ...manifest } = r;
  return manifest;
}

export { describeImportPreview };

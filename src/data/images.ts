/**
 * 图片压缩与去重。
 *
 * 压缩走浏览器 API（createImageBitmap + canvas），这部分注入以便测试；
 * 哈希与命名是纯逻辑，在 Node 里可完整验证。
 *
 * 设计约束：
 *   1. 同内容只存一份。用户连点两次同一张图，不该占两份空间。
 *   2. 小图不压缩。低于阈值的直接原样存，避免二次劣化。
 *   3. 压缩失败不丢原图。宁可存原图，也不因为压缩报错让用户白传一次。
 */

import { IMAGE_COMPRESSION, type ImageManifestEntry, type ImageRecord } from '../domain/types.js';

/** 浏览器端依赖，测试时注入假实现 */
export interface ImageCodec {
  /** 解码，返回可绘制对象与原始尺寸 */
  decode(blob: Blob): Promise<{ source: unknown; width: number; height: number }>;
  /** 编码回 Blob */
  encode(source: unknown, width: number, height: number, mime: string, quality: number): Promise<Blob>;
}

export interface CompressResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  /** 是否真的做了压缩。false = 原样保留 */
  compressed: boolean;
  /** 压缩失败时的原因。图片仍会被保留，只是没压 */
  warning?: string;
}

/** 等比缩放，算出目标尺寸。不会放大小图。 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** mimeType → 落盘扩展名 */
export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/heic':
      return 'heic';
    case 'image/avif':
      return 'avif';
    default:
      // 未知类型用 bin，导入时靠 data.json 里的 mimeType 还原，不靠扩展名猜
      return 'bin';
  }
}

export function fileNameFor(id: string, mimeType: string): string {
  return `${id}.${extensionFor(mimeType)}`;
}

/**
 * 内容哈希。用于去重：同内容不同文件名只存一份。
 * 用 SHA-256 的前 16 个 hex 字符，够短且碰撞概率可忽略。
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

export async function compressImage(blob: Blob, codec: ImageCodec): Promise<CompressResult> {
  const originalBytes = blob.size;

  // 小图不压
  if (originalBytes <= IMAGE_COMPRESSION.minBytesToCompress) {
    const dims = await safeDecode(codec, blob);
    return {
      blob,
      mimeType: blob.type || IMAGE_COMPRESSION.fallbackMime,
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      bytes: originalBytes,
      originalBytes,
      compressed: false,
    };
  }

  try {
    const { source, width, height } = await codec.decode(blob);
    const target = fitWithin(width, height, IMAGE_COMPRESSION.maxEdge);

    // 先试 WebP，不支持再回退 JPEG。
    //
    // 这里必须同时检查「抛异常」和「返回的实际 type」两件事。
    // Safari 的 canvas.toBlob('image/webp') 不会抛异常，它安静地返回一个
    // type 为 image/png 的 Blob。只靠 try/catch 的话回退逻辑在 Safari 上
    // 从来没生效过，结果是文件名写着 .webp、内容其实是 PNG，
    // 导出时的格式判断会跟着错。
    let out: Blob | undefined;
    let mime: string = IMAGE_COMPRESSION.preferredMime;
    try {
      out = await encodeChecked(codec, source, target.width, target.height, mime, IMAGE_COMPRESSION.quality);
    } catch {
      mime = IMAGE_COMPRESSION.fallbackMime;
      try {
        out = await encodeChecked(codec, source, target.width, target.height, mime, IMAGE_COMPRESSION.quality);
      } catch (e) {
        // 两种格式都拿不到。宁可保留未压缩的原图，也不能存下一个
        // 「标着 jpg、实际是 png」的假货——那会让导出时的格式判断一起错。
        return {
          blob,
          mimeType: blob.type || IMAGE_COMPRESSION.fallbackMime,
          width,
          height,
          bytes: originalBytes,
          originalBytes,
          compressed: false,
          warning: '压缩失败，已保留原图：' + (e instanceof Error ? e.message : String(e)),
        };
      }
    }

    // 压完反而更大（少见但可能），保留原图
    if (out.size >= originalBytes) {
      return {
        blob,
        mimeType: blob.type || mime,
        width,
        height,
        bytes: originalBytes,
        originalBytes,
        compressed: false,
        warning: '压缩后体积没有变小，已保留原图',
      };
    }

    return {
      blob: out,
      mimeType: mime,
      width: target.width,
      height: target.height,
      bytes: out.size,
      originalBytes,
      compressed: true,
    };
  } catch (e) {
    // 压缩失败不丢图。原样存，只是没压。
    return {
      blob,
      mimeType: blob.type || IMAGE_COMPRESSION.fallbackMime,
      width: 0,
      height: 0,
      bytes: originalBytes,
      originalBytes,
      compressed: false,
      warning: `压缩失败，已保留原图：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 编码并校验实际类型。
 *
 * 有些浏览器不抛异常，只是返回一个 type 不同的 Blob
 * （Safari 的 toBlob 对 webp 就是这样，实际给的是 png）。
 * 不校验的话会存下一个「后缀是 webp、内容是 png」的假货，
 * 导出时的格式判断跟着一起错。
 */
async function encodeChecked(
  codec: ImageCodec,
  source: unknown,
  width: number,
  height: number,
  mime: string,
  quality: number,
): Promise<Blob> {
  const out = await codec.encode(source, width, height, mime, quality);
  const actual = (out.type || '').toLowerCase();
  if (actual !== mime.toLowerCase()) {
    throw new Error('编码器不支持 ' + mime + '，实际返回 ' + (actual || '未知类型'));
  }
  return out;
}

async function safeDecode(codec: ImageCodec, blob: Blob): Promise<{ width: number; height: number } | undefined> {
  try {
    const d = await codec.decode(blob);
    return { width: d.width, height: d.height };
  } catch {
    return undefined;
  }
}

/** 浏览器真实实现。测试时替换为假实现。 */
export const browserCodec: ImageCodec = {
  async decode(blob) {
    const bmp = await createImageBitmap(blob);
    return { source: bmp, width: bmp.width, height: bmp.height };
  },
  async encode(source, width, height, mime, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 2d 上下文');
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw new Error(`浏览器不支持导出 ${mime}`);
    return blob;
  },
};

// ============================================================
// 导入导出
// ============================================================

/** data.json 里的图片清单 */
export function buildManifest(records: ImageRecord[]): ImageManifestEntry[] {
  return records.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mimeType,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    hash: r.hash,
    originalBytes: r.originalBytes,
    createdAt: r.createdAt,
  }));
}

/**
 * 收集所有被引用的图片 id。
 *
 * 任何记录里的 images 数组都算引用。检查引用完整性是导入的硬要求：
 * 导出一个指向不存在图片的库，用户看到的是一片碎图，而且他根本不知道丢了什么。
 */
export function collectReferencedImageIds(data: {
  plants: { coverImageId?: string }[];
  wateringRecords: { images: string[] }[];
  plantEvents: { images: string[] }[];
}): string[] {
  const ids = new Set<string>();
  for (const p of data.plants) if (p.coverImageId) ids.add(p.coverImageId);
  for (const w of data.wateringRecords) for (const i of w.images) ids.add(i);
  for (const e of data.plantEvents) for (const i of e.images) ids.add(i);
  return [...ids].sort();
}

export interface ImageReferenceCheck {
  ok: boolean;
  referenced: number;
  available: string[];
  missing: string[];
}

/**
 * 检查引用完整性。
 * 导入前必须通过，否则会产生悬空的图片引用。
 */
export function checkImageReferences(
  referencedIds: string[],
  availableIds: string[],
): ImageReferenceCheck {
  const have = new Set(availableIds);
  const missing = referencedIds.filter((id) => !have.has(id));
  return {
    ok: missing.length === 0,
    referenced: referencedIds.length,
    available: availableIds,
    missing,
  };
}

/** 对象 URL 缓存。同一张图重复渲染不重复创建 URL。 */
const urlCache = new Map<string, string>();

export function objectUrlFor(id: string, blob: Blob): string {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/** 释放全部 URL。退出应用或导入覆盖时调用，避免 Blob 泄漏。 */
export function releaseAllObjectUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

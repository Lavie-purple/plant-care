/**
 * 图片逻辑测试。
 *
 * 浏览器 API（createImageBitmap / canvas）通过注入假实现替换，
 * 被测的全是纯逻辑：等比缩放、扩展名映射、哈希去重、
 * 引用完整性检查、压缩降级行为。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManifest,
  checkImageReferences,
  collectReferencedImageIds,
  compressImage,
  extensionFor,
  fileNameFor,
  fitWithin,
  hashBlob,
  type ImageCodec,
} from '../src/data/images.js';
import { IMAGE_COMPRESSION, type ImageRecord } from '../src/domain/types.js';

function blobOf(bytes: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

/** 假编码器：不真的压缩，只是按比例返回更小的 Blob */
function fakeCodec(opts: { srcW: number; srcH: number; outRatio?: number; failWebp?: boolean; failAll?: boolean }): ImageCodec {
  return {
    async decode(b) {
      return { source: { blob: b }, width: opts.srcW, height: opts.srcH };
    },
    async encode(_s, _w, _h, mime) {
      if (opts.failAll) throw new Error('画布不可用');
      if (opts.failWebp && mime === 'image/webp') throw new Error('不支持 webp');
      const base = _w * _h;
      return new Blob([new Uint8Array(Math.max(1, Math.floor(base * (opts.outRatio ?? 0.01))))], { type: mime });
    },
  };
}

describe('等比缩放', () => {
  test('长边超限才缩', () => {
    assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
  });

  test('横图按长边缩', () => {
    const r = fitWithin(4000, 3000, 1600);
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1200);
  });

  test('竖图按长边缩', () => {
    const r = fitWithin(3000, 4000, 1600);
    assert.equal(r.width, 1200);
    assert.equal(r.height, 1600);
  });

  test('不放大', () => {
    assert.deepEqual(fitWithin(200, 100, 1600), { width: 200, height: 100 });
  });

  test('极端比例不产生 0 像素', () => {
    const r = fitWithin(10000, 10, 1600);
    assert.ok(r.width >= 1 && r.height >= 1);
  });
});

describe('扩展名映射', () => {
  test('常见类型', () => {
    assert.equal(extensionFor('image/webp'), 'webp');
    assert.equal(extensionFor('image/jpeg'), 'jpg');
    assert.equal(extensionFor('image/png'), 'png');
  });

  test('未知类型用 bin，不靠扩展名猜 mime', () => {
    assert.equal(extensionFor('application/octet-stream'), 'bin');
  });

  test('文件名由 id 与扩展名组成', () => {
    assert.equal(fileNameFor('img-abc', 'image/webp'), 'img-abc.webp');
  });
});

describe('Safari 的静默失效：请求 webp 却给 png', () => {
  // 复现真实行为：canvas.toBlob('image/webp') 在 Safari 上不抛异常，
  // 只是返回一个 type 为 image/png 的 Blob。早期实现只靠 try/catch，
  // 所以回退逻辑在 Safari 上从来没生效过。
  const lyingCodec: ImageCodec = {
    async decode(b) {
      return { source: { blob: b }, width: 2000, height: 2000 };
    },
    async encode(_s, _w, _h, _mime) {
      // 无论要什么，都给 PNG
      return new Blob([new Uint8Array(200)], { type: 'image/png' });
    },
  };

  test('WebP 谎报但 JPEG 诚实 → 回退到 JPEG', async () => {
    // 只对 webp 撒谎的编码器，模拟「部分支持」的浏览器
    const partial: ImageCodec = {
      async decode(b) {
        return { source: { blob: b }, width: 2000, height: 2000 };
      },
      async encode(_s, _w, _h, mime) {
        if (mime === 'image/webp') return new Blob([new Uint8Array(500)], { type: 'image/png' });
        return new Blob([new Uint8Array(200)], { type: mime });
      },
    };
    const r = await compressImage(blobOf(500 * 1024), partial);
    assert.equal(r.mimeType, 'image/jpeg', '必须回退到 JPEG，而不是相信谎报');
    assert.equal(fileNameFor('img-x', r.mimeType), 'img-x.jpg', '落盘扩展名必须与实际内容一致');
  });

  test('两种格式都谎报 → 保留原图，不存下类型不符的假货', async () => {
    const r = await compressImage(blobOf(500 * 1024), lyingCodec);
    assert.equal(r.compressed, false);
    assert.equal(r.blob.size, 500 * 1024, '原图必须完整保留');
    assert.match(r.warning ?? '', /压缩失败/);
  });

  test('正常返回正确类型时不做多余回退', async () => {
    const honest: ImageCodec = {
      async decode(b) {
        return { source: { blob: b }, width: 2000, height: 2000 };
      },
      async encode(_s, _w, _h, mime) {
        return new Blob([new Uint8Array(200)], { type: mime });
      },
    };
    const r = await compressImage(blobOf(500 * 1024), honest);
    assert.equal(r.mimeType, 'image/webp', '支持时应当用 WebP');
  });

  test('大小写不同的 mime 视为一致', async () => {
    const upper: ImageCodec = {
      async decode(b) {
        return { source: { blob: b }, width: 2000, height: 2000 };
      },
      async encode(_s, _w, _h, mime) {
        return new Blob([new Uint8Array(200)], { type: mime.toUpperCase() });
      },
    };
    const r = await compressImage(blobOf(500 * 1024), upper);
    assert.equal(r.compressed, true, 'IMAGE/WEBP 与 image/webp 是同一种，不该误判为不支持');
  });
});

describe('内容哈希：同内容只存一份', () => {
  test('同内容同哈希', async () => {
    const a = await hashBlob(blobOf(100, 'image/jpeg'));
    const b = await hashBlob(blobOf(100, 'image/jpeg'));
    assert.equal(a, b, '相同内容必须得到相同哈希，否则去重失效');
  });

  test('不同内容不同哈希', async () => {
    const a = await hashBlob(blobOf(100, 'image/jpeg'));
    const b = await hashBlob(blobOf(101, 'image/jpeg'));
    assert.notEqual(a, b);
  });

  test('哈希长度固定，不会随内容变化', async () => {
    const a = await hashBlob(blobOf(10));
    const b = await hashBlob(blobOf(100_000));
    assert.equal(a.length, b.length);
  });
});

describe('压缩：三种降级路径都不能丢图', () => {
  test('小图不压，避免二次劣化', async () => {
    const small = blobOf(1024);
    const r = await compressImage(small, fakeCodec({ srcW: 100, srcH: 100 }));
    assert.equal(r.compressed, false);
    assert.equal(r.blob.size, 1024, '原图必须原样保留');
    assert.equal(r.originalBytes, 1024);
  });

  test('大图压缩并缩边', async () => {
    const big = blobOf(500 * 1024);
    const r = await compressImage(big, fakeCodec({ srcW: 4000, srcH: 3000 }));
    assert.equal(r.compressed, true);
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1200);
    assert.ok(r.bytes < r.originalBytes);
  });

  test('WebP 不支持时回退 JPEG', async () => {
    const r = await compressImage(blobOf(500 * 1024), fakeCodec({ srcW: 2000, srcH: 2000, failWebp: true }));
    assert.equal(r.compressed, true);
    assert.equal(r.mimeType, 'image/jpeg');
  });

  test('压缩后反而更大时保留原图', async () => {
    // outRatio 很大 = 压完更大
    const r = await compressImage(blobOf(500 * 1024), fakeCodec({ srcW: 2000, srcH: 2000, outRatio: 5 }));
    assert.equal(r.compressed, false);
    assert.match(r.warning ?? '', /没有变小/);
  });

  test('编码彻底失败仍返回原图，不丢上传', async () => {
    const src = blobOf(500 * 1024);
    const r = await compressImage(src, fakeCodec({ srcW: 2000, srcH: 2000, failAll: true }));
    assert.equal(r.compressed, false);
    assert.equal(r.blob.size, 500 * 1024, '编码失败时图片必须原样保存');
    assert.match(r.warning ?? '', /压缩失败/);
  });

  test('压缩参数是固定常量，界面不得另立一套', () => {
    assert.equal(IMAGE_COMPRESSION.maxEdge, 1600);
    assert.ok(IMAGE_COMPRESSION.quality > 0 && IMAGE_COMPRESSION.quality < 1);
  });
});

describe('引用完整性：导进来不能是一堆碎图', () => {
  const data = {
    plants: [{ coverImageId: 'img-cover' }, { }],
    wateringRecords: [{ images: ['img-1', 'img-2'] }, { images: [] }],
    plantEvents: [{ images: ['img-1'] }, { images: ['img-3'] }],
  };

  test('收集全部被引用的 id', () => {
    const ids = collectReferencedImageIds(data);
    assert.deepEqual(ids, ['img-1', 'img-2', 'img-3', 'img-cover']);
  });

  test('重复引用只算一次', () => {
    const ids = collectReferencedImageIds({
      plants: [{ coverImageId: 'x' }],
      wateringRecords: [{ images: ['y', 'y'] }],
      plantEvents: [{ images: ['y'] }],
    });
    assert.deepEqual(ids, ['x', 'y']);
  });

  test('图片齐全则通过', () => {
    const r = checkImageReferences(['img-1', 'img-2'], ['img-1', 'img-2', 'img-9']);
    assert.equal(r.ok, true);
    assert.equal(r.missing.length, 0);
  });

  test('缺图时明确列出，不静默通过', () => {
    const r = checkImageReferences(['img-1', 'img-2', 'img-3'], ['img-1']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['img-2', 'img-3']);
  });

  test('多带图片不算问题（备份里有本库不引用的图是正常的）', () => {
    const r = checkImageReferences(['img-1'], ['img-1', 'img-extra']);
    assert.equal(r.ok, true);
  });
});

describe('清单只带元数据，不带二进制', () => {
  function rec(id: string, hash: string): ImageRecord {
    return {
      id,
      hash,
      blob: new Blob([new Uint8Array(10)]),
      fileName: `${id}.webp`,
      mimeType: 'image/webp',
      bytes: 10,
      width: 800,
      height: 600,
      originalBytes: 200,
      createdAt: '2026-09-30T10:00:00+08:00',
      version: 1,
    };
  }

  test('清单字段正确', () => {
    const m = buildManifest([rec('img-1', 'abc123')]);
    assert.equal(m.length, 1);
    assert.equal(m[0]?.fileName, 'img-1.webp');
    assert.equal(m[0]?.bytes, 10);
    assert.equal(m[0]?.originalBytes, 200, '原始大小要保留，界面上要让用户看到压缩比');
  });

  test('清单不含二进制', () => {
    const m = buildManifest([rec('img-1', 'abc123')]);
    assert.equal((m[0] as unknown as Record<string, unknown>).blob, undefined, 'data.json 里绝不能塞二进制');
  });
});

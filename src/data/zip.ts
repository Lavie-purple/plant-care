/**
 * 最小 ZIP 打包器（store 模式，不压缩）。
 *
 * 为什么需要它：File System Access API 的选目录功能
 * 在 **移动端全部不可用**（iOS Safari、Android Chrome 都没有）。
 * 降级路径原本只能下载一个 JSON，照片全丢——
 * 用户在手机上一番操作，最后发现照片拿不出来。
 *
 * 为什么不用 deflate：图片本身已经是压缩格式（WebP / JPEG），
 * 再压一遍几乎不省空间，却要付出 CPU 和内存。
 * JSON 也没大到需要压。这个取舍是刻意的。
 *
 * 只实现 store，不实现 zip64。上限 4GB，照片场景够用。
 */

export interface ZipEntry {
  /** 归档内的路径，用 / 分隔 */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i] ?? 0;
    c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 把 Date 转成 ZIP 用的 MS-DOS 时间与日期 */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;

  push(b: Uint8Array): void {
    this.parts.push(b);
    this.length += b.length;
  }

  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.push(b);
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

const MAX_ENTRIES = 0xffff;

/**
 * 打包成 ZIP。
 * 超过 65535 个文件会抛错——照片场景不会到，但静默截断更糟。
 */
export function createZip(entries: ZipEntry[], now: Date = new Date()): Blob {
  if (entries.length > MAX_ENTRIES) {
    throw new Error('文件数超过 ZIP 格式上限（65535），请分批导出');
  }
  const { time, date } = dosDateTime(now);
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);
    const offset = body.length;

    // local file header
    body.u32(0x04034b50);
    body.u16(20); // version needed
    body.u16(0x0800); // flags: UTF-8 文件名
    body.u16(0); // method: store
    body.u16(time);
    body.u16(date);
    body.u32(crc);
    body.u32(e.data.length);
    body.u32(e.data.length);
    body.u16(nameBytes.length);
    body.u16(0);
    body.push(nameBytes);
    body.push(e.data);

    // central directory entry
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(e.data.length);
    central.u32(e.data.length);
    central.u16(nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(offset);
    central.push(nameBytes);
  }

  const centralBytes = central.concat();
  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralBytes.length);
  end.u32(body.length);
  end.u16(0);

  return new Blob([body.concat() as BlobPart, centralBytes as BlobPart, end.concat() as BlobPart], {
    type: 'application/zip',
  });
}

/**
 * 解析 ZIP 目录，用于测试与将来导入时校验。
 * 只读中央目录，不解压。
 */
export interface ZipListing {
  name: string;
  size: number;
  crc: number;
  offset: number;
}

export function listZip(buf: ArrayBuffer): ZipListing[] {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP 文件：找不到中央目录');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipListing[] = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录项签名不对');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    out.push({
      name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      crc: view.getUint32(p + 16, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

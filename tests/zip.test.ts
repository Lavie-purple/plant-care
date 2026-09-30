/**
 * ZIP 打包测试。
 *
 * 动机很具体：移动端全都不支持选目录，不打包 ZIP 的话
 * 用户在手机上拍的照片根本导不出来。这是实测出来的真问题。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createZip, crc32, listZip } from '../src/data/zip.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOW = new Date('2026-09-30T14:32:00+08:00');

describe('CRC32', () => {
  test('已知向量正确', () => {
    // 业界标准测试向量
    assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  });

  test('空数据为 0', () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  test('内容不同则校验和不同', () => {
    assert.notEqual(crc32(enc.encode('a')), crc32(enc.encode('b')));
  });
});

describe('打包结构', () => {
  test('包含全部条目与正确的文件名', async () => {
    const zip = createZip(
      [
        { name: 'data.json', data: enc.encode('{"a":1}') },
        { name: 'images/abc.webp', data: new Uint8Array([1, 2, 3, 4, 5]) },
        { name: 'images/def.jpg', data: new Uint8Array([9, 9]) },
      ],
      NOW,
    );
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((x) => x.name),
      ['data.json', 'images/abc.webp', 'images/def.jpg'],
    );
  });

  test('记录的大小与实际一致', async () => {
    const payload = enc.encode('x'.repeat(1000));
    const zip = createZip([{ name: 'a.txt', data: payload }], NOW);
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list[0]?.size, 1000);
  });

  test('记录的是 store 模式，图片不必二次压缩', async () => {
    const zip = createZip([{ name: 'a.bin', data: new Uint8Array(10) }], NOW);
    const buf = await zip.arrayBuffer();
    const view = new DataView(buf);
    // 本地文件头的 offset 8 是压缩方法，0 = store
    assert.equal(view.getUint16(8, true), 0);
  });

  test('CRC 与内容对应', async () => {
    const data = enc.encode('hello world');
    const zip = createZip([{ name: 'a.txt', data }], NOW);
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list[0]?.crc, crc32(data));
  });

  test('文件名长度与内容不串位（中文名）', async () => {
    const zip = createZip([{ name: '数据/data.json', data: enc.encode('{}') }], NOW);
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list[0]?.name, '数据/data.json');
  });

  test('空归档也能生成合法 ZIP', async () => {
    const zip = createZip([], NOW);
    assert.equal(listZip(await zip.arrayBuffer()).length, 0);
  });

  test('MIME 类型是 application/zip', () => {
    assert.equal(createZip([], NOW).type, 'application/zip');
  });
});

describe('边界与失败', () => {
  test('单个大文件（模拟照片）不会溢出', async () => {
    const big = new Uint8Array(3_000_000).fill(7);
    const zip = createZip([{ name: 'images/big.jpg', data: big }], NOW);
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list[0]?.size, 3_000_000);
    assert.ok(zip.size > 3_000_000, 'ZIP 应略大于原始数据');
  });

  test('多个文件（模拟照片集）', async () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      name: `images/p${i}.jpg`,
      data: new Uint8Array(50_000).fill(i & 0xff),
    }));
    const zip = createZip([{ name: 'data.json', data: enc.encode('{}') }, ...entries], NOW);
    const list = listZip(await zip.arrayBuffer());
    assert.equal(list.length, 201);
  });

  test('超过 65535 个文件时抛错而不是静默截断', () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(1) }));
    assert.throws(() => createZip(many, NOW), /超过/);
  });

  test('不是 ZIP 时报明确错误', () => {
    const junk = new Uint8Array(100);
    assert.throws(() => listZip(junk.buffer), /不是合法的 ZIP/);
  });

  test('年份早于 1980 不会溢出（MS-DOS 格式下限）', () => {
    const old = new Date('1970-01-01T00:00:00Z');
    assert.doesNotThrow(() => createZip([{ name: 'a', data: new Uint8Array(1) }], old));
  });
});

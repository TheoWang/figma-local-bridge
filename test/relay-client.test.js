// 共享中继客户端工具测试：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { resolveFileKey, rasterizeSvgToPlaceImage } = require('../src/relay-client');

const statusOf = (sessions) => async () => ({ sessions });

test('resolveFileKey：fileKey 精确匹配优先，多会话取最近活跃', async () => {
  const fetch = statusOf([
    { fileKey: 'fkA', fileName: '文件A', alive: true, lastSeenAt: '2026-11-19T10:00:00Z' },
    { fileKey: 'fkB', fileName: 'fkA同名的文件', alive: true, lastSeenAt: '2026-11-19T09:00:00Z' },
  ]);
  assert.equal(await resolveFileKey(fetch, 'fkA'), 'fkA');
});

test('resolveFileKey：文件名唯一子串（大小写不敏感）', async () => {
  const fetch = statusOf([{ fileKey: 'fkA', fileName: 'Home Page', alive: true }]);
  assert.equal(await resolveFileKey(fetch, 'home page'), 'fkA');
});

test('resolveFileKey：子串歧义报错并附候选', async () => {
  const fetch = statusOf([
    { fileKey: 'fkA', fileName: '首页草稿', alive: true },
    { fileKey: 'fkB', fileName: '首页终稿', alive: true },
  ]);
  await assert.rejects(resolveFileKey(fetch, '首页'), /首页.*fkA.*fkB.*fileKey/s);
});

test('resolveFileKey：无匹配报错', async () => {
  const fetch = statusOf([{ fileKey: 'fkA', fileName: '文件A', alive: true }]);
  await assert.rejects(resolveFileKey(fetch, '不存在'), /没有匹配的在线文件/);
});

test('resolveFileKey：失联会话不参与匹配', async () => {
  const fetch = statusOf([
    { fileKey: 'fkDead', fileName: '文件X', alive: false },
    { fileKey: 'fkLive', fileName: '文件Y', alive: true },
  ]);
  await assert.rejects(resolveFileKey(fetch, '文件X'), /没有匹配的在线文件/);
  assert.equal(await resolveFileKey(fetch, '文件Y'), 'fkLive');
});

test('rasterizeSvgToPlaceImage：产出 placeImage 命令（PNG magic + 尺寸透传）', { skip: !hasSharp() }, async () => {
  const cmd = await rasterizeSvgToPlaceImage({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>',
    width: 24, height: 24, name: 'icon', x: 1, y: 2,
  });
  assert.equal(cmd.action, 'placeImage');
  assert.equal(cmd.params.width, 24);
  assert.equal(cmd.params.height, 24);
  assert.equal(cmd.params.name, 'icon');
  assert.equal(cmd.params.scaleMode, 'FIT');
  const png = Buffer.from(cmd.params.imageBase64, 'base64');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '应为 PNG 数据');
});

test('rasterizeSvgToPlaceImage：缺 svg 参数报错', async () => {
  await assert.rejects(rasterizeSvgToPlaceImage({}), /缺少 svg 参数/);
});

function hasSharp() {
  try { require.resolve('sharp'); return true; } catch { return false; }
}

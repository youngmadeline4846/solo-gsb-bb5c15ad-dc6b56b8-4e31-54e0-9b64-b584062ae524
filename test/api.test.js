'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 只在本文件需要时惰性启动服务（端口 0 = 系统分配），避免与其他测试文件的进程互相干扰
let server;
let baseUrl;

test.before(async () => {
  const app = require('../server');
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = 'http://127.0.0.1:' + addr.port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('POST /api/panel 成功拼版：返回标签索引/旋转角/全局点/SVG', async () => {
  const res = await postJson('/api/panel', {
    labels: 'EXIT\nWOMEN\nMEN',
    plateWidth: 120, plateHeight: 80
  });
  assert.equal(res.status, 200);
  const r = res.json;
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'panel');
  assert.equal(r.labelCount, 3);
  assert.deepEqual(r.labels.map(l => l.index), [1, 2, 3]);
  assert.ok(r.labels.every(l => l.rotation === 0 || l.rotation === 90));
  assert.ok(r.dots.length > 0);
  assert.match(r.svg, /<svg /);
  assert.match(r.svg, /data-label-index="1"/);
});

test('POST /api/panel labels 支持数组；放不下时 ok=false 且无部分版面', async () => {
  const ok = await postJson('/api/panel', { labels: ['ab', 'cd'], plateWidth: 120, plateHeight: 80 });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.labelCount, 2);

  const fail = await postJson('/api/panel', { labels: ['bbcdefghijklmno'], plateWidth: 90, plateHeight: 60 });
  assert.equal(fail.json.ok, false);
  assert.equal(fail.json.svg, null);
  assert.equal(fail.json.dots.length, 0);
  assert.ok(fail.json.errors.some(e => e.labelIndex === 1));
});

test('POST /api/layout 单标签接口行为不变（向后兼容）', async () => {
  const r = await postJson('/api/layout', { text: 'ab', plateWidth: 100, plateHeight: 50 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dots.length > 0, true);
  assert.doesNotMatch(r.json.svg, /data-label-index/);
});

test('POST /api/qc 质检接口可直接消费拼版结果的顶层 dots（接口兼容）', async () => {
  const panel = await postJson('/api/panel', { labels: 'a\nb', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const qc = await postJson('/api/qc', {
    design: panel.json.dots,
    csv: panel.json.dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.5,
    maxRadius: 2,
    plateWidth: 120,
    plateHeight: 80
  });
  assert.equal(qc.json.ok, true);
  assert.equal(qc.json.stats.missingCount, 0);
  assert.equal(qc.json.stats.extraCount, 0);
  assert.equal(qc.json.stats.passCount, panel.json.dots.length);
});

test('POST /api/qc 消费拼版 dots 时保留 label/rotation：baseline、pairs、SVG、CSV 均标注标签', async () => {
  const panel = await postJson('/api/panel', { labels: 'EXIT\nWOMEN', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const qc = await postJson('/api/qc', {
    design: panel.json.dots,
    csv: panel.json.dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.5,
    maxRadius: 2,
    plateWidth: 120,
    plateHeight: 80
  });
  assert.equal(qc.json.ok, true);
  // baseline 含标签数量及各标签索引/旋转角
  assert.equal(qc.json.baseline.labelCount, 2);
  assert.deepEqual(qc.json.baseline.labels.map(l => [l.index, l.rotation]),
    panel.json.labels.map(l => [l.index, l.rotation]));
  // pairs 带标签归属
  const src = panel.json.dots[0];
  assert.equal(qc.json.pairs[0].label, src.label);
  assert.equal(qc.json.pairs[0].labelRotation, src.rotation);
  // 叠加图与 CSV 标注对应标签
  assert.match(qc.json.svg, /data-label-count="2"/);
  assert.match(qc.json.svg, new RegExp('data-label="' + src.label + '"'));
  assert.match(qc.json.csv, /label_index,label_rotation_deg/);
  assert.match(qc.json.csv, /# summary,label_count,design_count/);
});

test('GET /api/health 健康检查正常', async () => {
  const r = await new Promise((resolve, reject) => {
    http.get(baseUrl + '/api/health', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('静态资源：/lib/panel.js 与首页可访问', async () => {
  const fetchText = path => new Promise((resolve, reject) => {
    http.get(baseUrl + path, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  const lib = await fetchText('/lib/panel.js');
  assert.equal(lib.status, 200);
  assert.match(lib.body, /packLabels/);
  const page = await fetchText('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /tabPanel/);
  assert.match(page.body, /多标签拼版/);
});

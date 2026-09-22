'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('../lib/path');
const Braille = require('../lib/braille');
const Panel = require('../lib/panel');

/* ---------- 基本性质：每个凸点恰好访问一次、步骤结构与 CSV ---------- */

test('单标签排版 dots 生成路径：步数=点数、原序号为 1..n 的排列、首步含起点空移', () => {
  const lay = Braille.layout({ text: 'EXIT Door 2', plateWidth: 100, plateHeight: 50 });
  assert.equal(lay.ok, true);
  const n = lay.dots.length;
  const r = Path.plan({ dots: lay.dots, startX: 0, startY: 0, plateWidth: 100, plateHeight: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.steps.length, n);
  assert.deepEqual(r.order.slice().sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1));
  assert.equal(new Set(r.order).size, n); // 无重复访问
  // step 连续 1..n，且每步坐标与对应原点一致
  r.steps.forEach((st, i) => {
    assert.equal(st.step, i + 1);
    const src = lay.dots[st.originalIndex - 1];
    assert.equal(st.x, Math.round(src.x * 10000) / 10000);
    assert.equal(st.y, Math.round(src.y * 10000) / 10000);
    assert.equal(st.label, null); // 单标签点无标签归属
  });
  // 从原点 (0,0) 到首点存在非零空移
  const first = lay.dots[r.steps[0].originalIndex - 1];
  const d0 = Math.hypot(first.x, first.y);
  assert.ok(Math.abs(r.steps[0].travelMm - Math.round(d0 * 10000) / 10000) < 1e-6);
  // 空移总长 = 各步 travelMm 之和
  const sum = r.steps.reduce((s, st) => s + st.travelMm, 0);
  assert.ok(Math.abs(sum - r.stats.afterTotalMm) < 1e-2);
});

test('CSV 表头与列为 step,label,x_mm,y_mm,travel_mm；UTF-8 BOM；单标签 label 留空', () => {
  const lay = Braille.layout({ text: 'ab', plateWidth: 100, plateHeight: 50 });
  const r = Path.plan({ dots: lay.dots });
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'step,label,x_mm,y_mm,travel_mm');
  assert.equal(lines.length, lay.dots.length + 1);
  const row = lines[1].split(',');
  assert.equal(row[0], '1');
  assert.equal(row[1], '');
  assert.equal(row.length, 5);
  assert.match(r.csv, /^﻿/);
});

test('拼版 dots 保留 label：步骤与 CSV 标注所属标签', () => {
  const panel = Panel.packLabels({ labels: 'EXIT\nWOMEN', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.ok, true);
  const r = Path.plan({ dots: panel.dots, startIndex: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, panel.dots.length);
  r.steps.forEach(st => { assert.ok(st.label >= 1 && st.label <= 2); });
  const line = r.csv.replace(/^﻿/, '').split('\r\n')[1].split(',');
  assert.ok(line[1] === '1' || line[1] === '2');
});

/* ---------- 起点模式 ---------- */

test('序号模式：指定凸点固定为第 1 步、首步空移为 0，且 2-opt 不会把它移走', () => {
  const dots = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
  const r = Path.plan({ dots, startIndex: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.order[0], 4);
  assert.equal(r.steps[0].travelMm, 0);
  assert.equal(new Set(r.order).size, dots.length);
});

test('坐标模式缺省起点 = 压印机原点 (0,0)；只传一个坐标时另一个按 0', () => {
  const dots = [{ x: 5, y: 0 }, { x: 10, y: 0 }];
  const r0 = Path.plan({ dots });
  const r1 = Path.plan({ dots, startX: 0, startY: 0 });
  assert.deepEqual(r0.order, r1.order);
  assert.equal(r0.params.mode, 'coord');
  assert.deepEqual([r0.params.startX, r0.params.startY], [0, 0]);
  const r2 = Path.plan({ dots, startX: 0 });
  assert.deepEqual(r2.order, r1.order);
});

/* ---------- 同距离稳定决胜 ---------- */

test('同距离决胜：标签索引 → x → y → 原序号，结果确定可重复', () => {
  // (4,3) 与 (3,4) 到原点同为 5；x 小者先
  let r = Path.plan({ dots: [{ x: 4, y: 3 }, { x: 3, y: 4 }], startX: 0, startY: 0 });
  assert.deepEqual(r.order, [2, 1]);
  // 同坐标重复点：原序号升序
  r = Path.plan({ dots: [{ x: 3, y: 4 }, { x: 3, y: 4 }], startX: 0, startY: 0 });
  assert.deepEqual(r.order, [1, 2]);
  // 标签索引优先于 x/y：label 1 的 (4,3) 先于 label 2 的 (3,4)
  r = Path.plan({
    dots: [{ x: 3, y: 4, label: 2 }, { x: 4, y: 3, label: 1 }],
    startX: 0, startY: 0
  });
  assert.deepEqual(r.order, [2, 1]);
  // 相同输入重复调用结果一致
  const again = Path.plan({
    dots: [{ x: 3, y: 4, label: 2 }, { x: 4, y: 3, label: 1 }],
    startX: 0, startY: 0
  });
  assert.deepEqual(again.order, r.order);
});

/* ---------- 最近邻 + 2-opt 行为 ---------- */

test('最近邻按起点贪心；直线点阵已是最优时 2-opt 不改动', () => {
  const dots = [{ x: 0, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 5 }, { x: 15, y: 5 }];
  const r = Path.plan({ dots, startX: 0, startY: 0 });
  assert.deepEqual(r.nnOrder, [1, 2, 3, 4]);
  assert.deepEqual(r.order, [1, 2, 3, 4]);
  assert.equal(r.stats.roundsUsed, 0);
  assert.equal(r.stats.improved, false);
  assert.equal(r.stats.savedMm, 0);
  assert.equal(r.stats.savedPercent, 0);
});

test('2-opt：存在交叉时严格缩短空移，轮次不超过 20，且优化后总长与统计一致', () => {
  // 3×3 点阵，起点 (2.5,5) 使最近邻走出含交叉的路线
  const dots = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 0, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 5 },
    { x: 0, y: 10 }, { x: 5, y: 10 }, { x: 10, y: 10 }
  ];
  const r = Path.plan({ dots, startX: 2.5, startY: 5 });
  assert.ok(r.stats.beforeTotalMm >= r.stats.afterTotalMm);
  assert.ok(r.stats.roundsUsed > 0);
  assert.ok(r.stats.roundsUsed <= 20);
  assert.ok(r.stats.savedPercent > 0);
  assert.equal(r.stats.improved, true);
  // 节省量 = 前后差；节省比例 = 差/前
  assert.ok(Math.abs((r.stats.beforeTotalMm - r.stats.afterTotalMm) - r.stats.savedMm) < 1e-3);
  assert.ok(Math.abs(r.stats.savedMm / r.stats.beforeTotalMm * 100 - r.stats.savedPercent) < 0.01);
  // 优化后仍是 1..n 的排列
  assert.deepEqual(r.order.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 用步骤 travelMm 重算总长，与统计一致
  const total = r.steps.reduce((s, st) => s + st.travelMm, 0);
  assert.ok(Math.abs(total - r.stats.afterTotalMm) < 1e-2);
});

test('单凸点：路线长度为 0（序号模式）或仅起点距离（坐标模式），轮次为 0', () => {
  let r = Path.plan({ dots: [{ x: 8, y: 6 }], startIndex: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, [1]);
  assert.equal(r.stats.afterTotalMm, 0);
  assert.equal(r.stats.beforeTotalMm, 0);
  assert.equal(r.stats.roundsUsed, 0);
  r = Path.plan({ dots: [{ x: 8, y: 6 }], startX: 0, startY: 0 });
  assert.equal(r.stats.afterTotalMm, 10);
});

/* ---------- 错误语义：非法参数不输出部分路径 ---------- */

test('凸点超过 2000：明确报错且 steps/order/csv/svg 全为空', () => {
  const dots = Array.from({ length: Path.MAX_POINTS + 1 }, (_, i) => ({ x: i, y: 0 }));
  const r = Path.plan({ dots, startX: 0, startY: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.type === 'too-many-points'));
  assert.match(r.errors[0].message, /2000/);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.order, []);
  assert.equal(r.csv, null);
  assert.equal(r.svg, null);
});

test('恰好 2000 个凸点允许生成，2001 拒绝', () => {
  const dots = Array.from({ length: Path.MAX_POINTS }, (_, i) => ({ x: (i % 50) * 2.5, y: Math.floor(i / 50) * 2.5 }));
  const r = Path.plan({ dots, startIndex: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, Path.MAX_POINTS);
  assert.equal(new Set(r.order).size, Path.MAX_POINTS);
});

test('dots 缺失/为空/坐标非法：报错且不输出部分路径', () => {
  let r = Path.plan({ startX: 0, startY: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  r = Path.plan({ dots: [], startX: 0, startY: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.type === 'dots-invalid'));
  r = Path.plan({ dots: [{ x: 1, y: 2 }, { x: 'bad', y: 3 }], startX: 0, startY: 0 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /第 2 个/);
  assert.equal(r.csv, null);
});

test('起点参数非法：序号越界/非整数、坐标非数字、两种起点同时指定', () => {
  const dots = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  let r = Path.plan({ dots, startIndex: 3 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.type === 'start-index'));
  r = Path.plan({ dots, startIndex: 0 });
  assert.equal(r.ok, false);
  r = Path.plan({ dots, startIndex: 1.5 });
  assert.equal(r.ok, false);
  r = Path.plan({ dots, startIndex: 'abc' });
  assert.equal(r.ok, false);
  r = Path.plan({ dots, startX: 'x', startY: 0 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /起点 X/);
  r = Path.plan({ dots, startX: 0, startY: 0, startIndex: 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /不能同时指定/);
  // 任一错误都不得输出部分路径
  [r, Path.plan({ dots, startIndex: 3 })].forEach(e => {
    assert.deepEqual(e.steps, []);
    assert.equal(e.csv, null);
    assert.equal(e.svg, null);
  });
});

/* ---------- SVG 叠加 ---------- */

test('SVG 含板材底图、路径线、方向箭头、步骤序号、起点标记与点数/轮次元数据', () => {
  const dots = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 0, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 5 },
    { x: 0, y: 10 }, { x: 5, y: 10 }, { x: 10, y: 10 }
  ];
  const r = Path.plan({ dots, startX: 2.5, startY: 5, plateWidth: 40, plateHeight: 30 });
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="[\d.]+mm"/);
  assert.match(r.svg, /id="emboss-path-lines"/);
  assert.match(r.svg, /data-direction-arrow="1"/);
  assert.match(r.svg, /id="emboss-path-dots"/);
  assert.match(r.svg, /id="emboss-path-labels"/);
  assert.match(r.svg, /id="emboss-path-start"/);
  assert.match(r.svg, /起点/);
  assert.match(r.svg, new RegExp('data-point-count="' + dots.length + '"'));
  assert.match(r.svg, /data-2opt-rounds="/);
  assert.match(r.svg, /data-step="1"/);
  // 序号 1..n 均出现在标签层
  for (let i = 1; i <= dots.length; i++) {
    assert.match(r.svg, new RegExp('data-step="' + i + '"'));
  }
  // 序号模式 SVG 标注起点凸点原序号
  const ri = Path.plan({ dots, startIndex: 3 });
  assert.match(ri.svg, /data-start-index="3"/);
  // 拼版点元素带 data-label
  const panel = Panel.packLabels({ labels: 'ab\ncd', plateWidth: 120, plateHeight: 80 });
  const rp = Path.plan({ dots: panel.dots, startIndex: 1 });
  assert.match(rp.svg, /data-label="1"/);
});

/*
 * 压印路径（Embossing Path）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 输入单标签排版或多标签拼版成功后的设计凸点 dots（每个凸点恰好访问一次），
 * 从用户指定起点出发生成压印机逐点作业顺序：
 *   1. 最近邻（Nearest Neighbor）：从当前位置每次选取未访问凸点中欧氏距离最小者；
 *      同距离按 ① 标签索引升序（无标签元数据的单标签点视为 0）→ ② x 升序 →
 *      ③ y 升序 → ④ 凸点在输入 dots 中的原序号升序 稳定决胜，保证相同输入结果一致。
 *   2. 2-opt：在最近邻路线上最多执行 20 轮，每轮按反转段“起点下标 i 升序、
 *      止点下标 j 升序”的顺序扫描，接受首个严格缩短总空移的反转并立即进入下一轮；
 *      一轮内找不到严格缩短的反转即提前停止（局部最优）。
 *
 * 起点两种模式（二选一，均不传时默认压印机原点 (0,0)）：
 *   - 坐标模式：startX/startY 给定压印机初始位置（虚拟固定点，不属于任何凸点），
 *     路线首段包含原点→首个凸点的空移，反转不得改变“从原点出发”这一前缀；
 *   - 序号模式：startIndex（1 基，对应输入 dots 的原序号）指定首个压印凸点，
 *     该凸点固定为路线第 1 个点（首步空移为 0），其后的点序才参与反转。
 *
 * 凸点数超过 2000 或任何参数非法时返回错误且不输出任何部分路径
 * （steps/order 为空、csv/svg 为 null）。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmbossPath = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var MAX_POINTS = 2000;     // 压印路径凸点数量上限
  var MAX_2OPT_ROUNDS = 20;  // 2-opt 最大轮数
  var EPS = 1e-9;            // 距离严格缩短/并列判定阈值（mm）

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round4(n) {
    var v = Math.round(n * 10000) / 10000;
    return v === 0 ? 0 : v; // 归一化 -0
  }

  /* ---------------- 输入校验与点集整理 ---------------- */

  function collectPoints(input) {
    var dots = [];
    var errors = [];

    if (!Array.isArray(input)) {
      return { dots: dots, errors: [{ type: 'dots-invalid', message: '缺少凸点数据（dots 必须为数组），请先完成一次成功的单标签排版或多标签拼版。' }] };
    }
    if (input.length === 0) {
      return { dots: dots, errors: [{ type: 'dots-invalid', message: '没有任何凸点，无法生成压印路径；请先完成一次含凸点的成功排版。' }] };
    }
    if (input.length > MAX_POINTS) {
      errors.push({
        type: 'too-many-points',
        message: '凸点数量为 ' + input.length + ' 个，超过压印路径 ' + MAX_POINTS +
          ' 个上限；请缩小板材内容或拆分拼版后再生成路径（本次不输出任何部分路径）。'
      });
      return { dots: dots, errors: errors };
    }
    for (var i = 0; i < input.length; i++) {
      var dpt = input[i] || {};
      var x = num(dpt.x), y = num(dpt.y);
      if (!isFinite(x) || !isFinite(y)) {
        errors.push({
          type: 'dots-invalid',
          message: '凸点数据第 ' + (i + 1) + ' 个坐标非法（x/y 必须为有限数字，单位 mm），请重新排版后再生成路径。'
        });
        break;
      }
      var p = {
        x: x,
        y: y,
        r: isFinite(num(dpt.r)) && num(dpt.r) > 0 ? num(dpt.r) : null,
        originalIndex: i + 1
      };
      var labelNo = num(dpt.label);
      var rotNo = num(dpt.rotation);
      if (isFinite(labelNo)) p.label = Math.trunc(labelNo);
      if (isFinite(rotNo)) p.labelRotation = rotNo;
      dots.push(p);
    }
    return { dots: dots, errors: errors };
  }

  // 标签索引决胜键：拼版点为其标签 1 基索引；单标签点无 label，统一记 0
  function labelKey(p) {
    return p.label == null ? 0 : p.label;
  }

  /* ---------------- 最近邻初始路线 ----------------
   * mode: 'coord'（虚拟起点 startX/startY）或 'index'（首点固定为 firstIndex）。
   * 返回路线（凸点在数组中的 0 基下标排列）。
   */
  function nearestNeighbor(points, mode, startX, startY, firstIndex) {
    var n = points.length;
    var used = new Array(n).fill(false);
    var route = new Array(n);
    var curX, curY, filled = 0;

    if (mode === 'index') {
      route[0] = firstIndex;
      used[firstIndex] = true;
      curX = points[firstIndex].x;
      curY = points[firstIndex].y;
      filled = 1;
    } else {
      curX = startX;
      curY = startY;
    }

    while (filled < n) {
      var best = -1;
      var bestD = Infinity;
      for (var k = 0; k < n; k++) {
        if (used[k]) continue;
        var cand = points[k];
        var dx = cand.x - curX, dy = cand.y - curY;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (best === -1 || d < bestD - EPS) {
          best = k; bestD = d;
        } else if (Math.abs(d - bestD) <= EPS) {
          // 同距离稳定决胜：标签索引 → x → y → 原序号
          var b = points[best];
          if (labelKey(cand) < labelKey(b) ||
              (labelKey(cand) === labelKey(b) &&
                (cand.x < b.x - EPS ||
                 (Math.abs(cand.x - b.x) <= EPS &&
                   (cand.y < b.y - EPS ||
                    (Math.abs(cand.y - b.y) <= EPS && cand.originalIndex < b.originalIndex)))))) {
            best = k; bestD = d;
          }
        }
      }
      route[filled++] = best;
      used[best] = true;
      curX = points[best].x;
      curY = points[best].y;
    }
    return route;
  }

  /* ---------------- 2-opt（最多 20 轮，每轮取首个严格缩短反转） ----------------
   * coord 模式：虚拟起点固定在路线之前，反转段 i 可从 0 起（即替换“原点→首点”边）；
   * index 模式：route[0] 为用户指定首点，反转段 i 必须 ≥ 1（首点绝不移动）。
   * 路线总空移 = 起点→首点 + 相邻凸点之间（index 模式首项为 0）。
   */
  function buildDistanceMatrix(points) {
    var n = points.length;
    var m = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var dx = points[i].x - points[j].x, dy = points[i].y - points[j].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        m[i * n + j] = d;
        m[j * n + i] = d;
      }
    }
    return m;
  }

  function distMatrix(m, n, i, j) {
    return m[i * n + j];
  }

  // 坐标模式：虚拟起点到点 i 的距离（index 模式反转不会触及首点，不会被调用）
  function startDist(points, startX, startY, i) {
    var dx = points[i].x - startX, dy = points[i].y - startY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // 反转 route[i..j] 后总空移的变化量（负值=缩短）。
  // prev = 反转段首点的前驱（虚拟起点用 -1 表示）；next = 反转段末点的后继（路线结尾用 -1）。
  function reverseDelta(m, n, points, mode, startX, startY, firstIndex, route, i, j) {
    var prev = i === 0 ? -1 : route[i - 1];
    var next = j === n - 1 ? -1 : route[j + 1];
    var before, after;
    if (prev === -1) {
      // 前驱为固定虚拟原点（index 模式 i 恒 ≥ 1，不会走到这里）
      before = startDist(points, startX, startY, route[i]);
      after = startDist(points, startX, startY, route[j]);
    } else {
      before = distMatrix(m, n, prev, route[i]);
      after = distMatrix(m, n, prev, route[j]);
    }
    if (next !== -1) {
      before += distMatrix(m, n, route[j], next);
      after += distMatrix(m, n, route[i], next);
    }
    return after - before;
  }

  function twoOpt(points, route, mode, startX, startY, firstIndex) {
    var n = points.length;
    var m = buildDistanceMatrix(points);
    var minI = mode === 'index' ? 1 : 0;
    var rounds = 0;

    for (var round = 0; round < MAX_2OPT_ROUNDS; round++) {
      var accepted = false;
      for (var i = minI; i < n - 1 && !accepted; i++) {
        for (var j = i + 1; j < n; j++) {
          var delta = reverseDelta(m, n, points, mode, startX, startY, firstIndex, route, i, j);
          if (delta < -EPS) {
            // 每轮按 (i,j) 下标顺序接受首个严格缩短的反转，随即进入下一轮
            var lo = i, hi = j;
            while (lo < hi) {
              var tmp = route[lo];
              route[lo] = route[hi];
              route[hi] = tmp;
              lo++; hi--;
            }
            accepted = true;
            rounds++;
            break;
          }
        }
      }
      if (!accepted) break;
    }
    return rounds;
  }

  /* ---------------- 路线长度 / 作业步骤 ---------------- */

  function routeLength(points, route, mode, startX, startY, firstIndex) {
    var total = 0;
    if (mode === 'index') {
      // 首点固定，首步空移为 0
      for (var t = 1; t < route.length; t++) {
        var dx = points[route[t]].x - points[route[t - 1]].x;
        var dy = points[route[t]].y - points[route[t - 1]].y;
        total += Math.sqrt(dx * dx + dy * dy);
      }
    } else {
      var fx = points[route[0]].x - startX, fy = points[route[0]].y - startY;
      total += Math.sqrt(fx * fx + fy * fy);
      for (var s = 1; s < route.length; s++) {
        var ax = points[route[s]].x - points[route[s - 1]].x;
        var ay = points[route[s]].y - points[route[s - 1]].y;
        total += Math.sqrt(ax * ax + ay * ay);
      }
    }
    return total;
  }

  function buildSteps(points, route, mode, startX, startY) {
    var steps = [];
    var prevX, prevY;
    if (mode === 'coord') { prevX = startX; prevY = startY; }
    for (var t = 0; t < route.length; t++) {
      var p = points[route[t]];
      if (mode === 'index' && t === 0) {
        prevX = p.x; prevY = p.y;
      }
      var dx = p.x - prevX, dy = p.y - prevY;
      steps.push({
        step: t + 1,
        originalIndex: p.originalIndex,
        x: round4(p.x),
        y: round4(p.y),
        label: p.label == null ? null : p.label,
        labelRotation: p.labelRotation == null ? null : p.labelRotation,
        travelMm: round4(Math.sqrt(dx * dx + dy * dy))
      });
      prevX = p.x; prevY = p.y;
    }
    return steps;
  }

  /* ---------------- 叠加 SVG（带序号与方向） ---------------- */

  function buildPathSvg(points, route, steps, opts) {
    var mode = opts.mode;
    var startX = opts.startX, startY = opts.startY;
    var plateWidth = opts.plateWidth, plateHeight = opts.plateHeight;
    var rounds = opts.rounds;
    var beforeTotal = opts.beforeTotal, afterTotal = opts.afterTotal;

    // 视口包围盒：板材矩形 ∪ 全部凸点 ∪ 坐标模式的虚拟起点
    var hasPlate = isFinite(plateWidth) && isFinite(plateHeight);
    var minX = hasPlate ? 0 : Infinity;
    var minY = hasPlate ? 0 : Infinity;
    var maxX = hasPlate ? plateWidth : -Infinity;
    var maxY = hasPlate ? plateHeight : -Infinity;
    function expand(x, y) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    points.forEach(function (p) { expand(p.x, p.y); });
    if (mode === 'coord') expand(startX, startY);
    if (!(maxX > minX) || !(maxY > minY)) { maxX = minX + 10; maxY = minY + 10; }
    var pad = Math.max(3, round3((maxX - minX) * 0.04));
    minX = round3(minX - pad); minY = round3(minY - pad);
    maxX = round3(maxX + pad); maxY = round3(maxY + pad);
    var W = round3(maxX - minX), H = round3(maxY - minY);

    var defaultR = 0.75;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="' + minX + ' ' + minY + ' ' + W + ' ' + H + '" data-unit="mm"' +
      ' data-point-count="' + points.length + '" data-mode="' + mode +
      '" data-2opt-rounds="' + rounds + '">');
    out.push('  <desc>压印路径预览：蓝色折线为优化后压印机逐点作业顺序（小三角为行进方向），' +
      '凸点旁数字为作业步骤序号（1 基），绿色标记为起点；共 ' + points.length + ' 个凸点，每个恰好访问一次，' +
      '2-opt 执行 ' + rounds + ' 轮，优化前空移 ' + round3(beforeTotal) + 'mm，优化后 ' +
      round3(afterTotal) + 'mm。</desc>');

    if (isFinite(plateWidth) && isFinite(plateHeight)) {
      out.push('  <rect x="0" y="0" width="' + plateWidth + '" height="' + plateHeight +
        '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    } else {
      out.push('  <rect x="' + minX + '" y="' + minY + '" width="' + W + '" height="' + H +
        '" fill="#ffffff" stroke="none"/>');
    }

    // 折线坐标序列（坐标模式含虚拟起点；序号模式首点即起点，折线从首点开始）
    var chain = [];
    if (mode === 'coord') chain.push({ x: startX, y: startY, step: 0 });
    route.forEach(function (idx, t) {
      chain.push({ x: points[idx].x, y: points[idx].y, step: t + 1, point: points[idx] });
    });

    // 1) 路径线段与方向箭头（先画，压在凸点与序号之下）
    out.push('  <g id="emboss-path-lines" stroke="#2563eb" stroke-width="0.18" opacity="0.75" fill="#1d4ed8">');
    for (var s = 1; s < chain.length; s++) {
      var a = chain[s - 1], b = chain[s];
      out.push('    <line x1="' + round3(a.x) + '" y1="' + round3(a.y) + '" x2="' + round3(b.x) +
        '" y2="' + round3(b.y) + '" data-step="' + b.step +
        '" data-from="' + (a.step === 0 ? 0 : a.point.originalIndex) +
        '" data-to="' + b.point.originalIndex + '"/>');
      var segDx = b.x - a.x, segDy = b.y - a.y;
      var segLen = Math.sqrt(segDx * segDx + segDy * segDy);
      // 仅在足够长的线段 65% 处画方向小三角，避免与凸点重叠成糊点
      if (segLen >= 1.5) {
        var ux = segDx / segLen, uy = segDy / segLen;
        var tipX = a.x + ux * segLen * 0.65, tipY = a.y + uy * segLen * 0.65;
        var size = 0.55;
        var px = -uy, py = ux; // 垂直方向
        var t1x = tipX - ux * size + px * size * 0.6;
        var t1y = tipY - uy * size + py * size * 0.6;
        var t2x = tipX - ux * size - px * size * 0.6;
        var t2y = tipY - uy * size - py * size * 0.6;
        out.push('    <polygon points="' + round3(tipX) + ',' + round3(tipY) + ' ' +
          round3(t1x) + ',' + round3(t1y) + ' ' + round3(t2x) + ',' + round3(t2y) +
          '" stroke="none" data-step="' + b.step + '" data-direction-arrow="1"/>');
      }
    }
    out.push('  </g>');

    // 2) 凸点（黑色）+ 作业序号（蓝色），序号放在凸点右上方
    out.push('  <g id="emboss-path-dots" fill="#111111">');
    var labelAttr = function (p) {
      return p.label == null ? '' : ' data-label="' + p.label + '"' +
        (p.labelRotation == null ? '' : ' data-label-rotation="' + p.labelRotation + '"');
    };
    steps.forEach(function (st, t) {
      var p = points[route[t]];
      var r = p.r != null ? p.r : defaultR;
      out.push('    <circle cx="' + round3(p.x) + '" cy="' + round3(p.y) + '" r="' + round3(r) +
        '" data-step="' + st.step + '" data-original-index="' + p.originalIndex + '"' +
        labelAttr(p) + '/>');
    });
    out.push('  </g>');

    // 3) 起点标记（绿色）：坐标模式在虚拟原点画向上三角；序号模式在首点加绿色高亮环
    out.push('  <g id="emboss-path-start" fill="#16a34a" stroke="#16a34a">');
    if (mode === 'coord') {
      var ts = 1.1;
      out.push('    <polygon points="' + round3(startX) + ',' + round3(startY - ts) + ' ' +
        round3(startX - ts * 0.85) + ',' + round3(startY + ts * 0.7) + ' ' +
        round3(startX + ts * 0.85) + ',' + round3(startY + ts * 0.7) +
        '" data-start-x="' + round3(startX) + '" data-start-y="' + round3(startY) + '"/>');
      out.push('    <text x="' + round3(startX) + '" y="' + round3(startY + ts * 2 + 0.4) +
        '" font-size="1.8" text-anchor="middle" fill="#15803d" stroke="none"' +
        ' pointer-events="none">起点 ' + round3(startX) + ',' + round3(startY) + '</text>');
    } else {
      var sp = points[route[0]];
      var sr = (sp.r != null ? sp.r : defaultR) + 0.45;
      out.push('    <circle cx="' + round3(sp.x) + '" cy="' + round3(sp.y) + '" r="' + round3(sr) +
        '" fill="none" stroke-width="0.28" data-start-index="' + sp.originalIndex + '"/>');
      out.push('    <text x="' + round3(sp.x) + '" y="' + round3(sp.y - sr - 0.5) +
        '" font-size="1.8" text-anchor="middle" fill="#15803d" stroke="none"' +
        ' pointer-events="none">起点 #' + sp.originalIndex + '</text>');
    }
    out.push('  </g>');

    // 4) 步骤序号（最上层）
    out.push('  <g id="emboss-path-labels" font-size="1.5" font-weight="bold" fill="#1d4ed8" pointer-events="none">');
    steps.forEach(function (st, t) {
      var p = points[route[t]];
      var r = p.r != null ? p.r : defaultR;
      var tx = p.x + r + 0.35, ty = p.y - r - 0.15;
      out.push('    <text x="' + round3(tx) + '" y="' + round3(ty) + '" text-anchor="start"' +
        ' data-step="' + st.step + '">' + st.step + '</text>');
    });
    out.push('  </g>');

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- CSV 下载（step,label,x_mm,y_mm,travel_mm） ---------------- */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv(steps) {
    var rows = [['step', 'label', 'x_mm', 'y_mm', 'travel_mm'].join(',')];
    steps.forEach(function (st) {
      rows.push([
        st.step,
        st.label == null ? '' : st.label,
        st.x, st.y, st.travelMm
      ].map(csvCell).join(','));
    });
    // UTF-8 BOM + CRLF，Excel 可直接打开
    return '﻿' + rows.join('\r\n');
  }

  /* ---------------- 主入口 ---------------- */

  function plan(input) {
    input = input || {};
    var errors = [];

    var collected = collectPoints(input.dots);
    var points = collected.dots;
    errors.push.apply(errors, collected.errors);

    // 起点模式解析：坐标（startX/startY）与序号（startIndex）二选一；均缺省 = 原点 (0,0)
    var hasStartX = input.startX != null && input.startX !== '';
    var hasStartY = input.startY != null && input.startY !== '';
    var hasCoord = hasStartX || hasStartY;
    var hasIndex = input.startIndex != null && input.startIndex !== '';
    var startX = num(hasStartX ? input.startX : 0);
    var startY = num(hasStartY ? input.startY : 0);
    var startIndexRaw = hasIndex ? num(input.startIndex) : NaN;

    if (hasCoord && hasIndex) {
      errors.push({ type: 'param', message: '起点坐标（startX/startY）与起点凸点序号（startIndex）不能同时指定，请二选一。' });
    }
    if (hasCoord) {
      if (!isFinite(startX)) errors.push({ type: 'param', message: '起点 X 坐标必须是数字（mm）。' });
      if (!isFinite(startY)) errors.push({ type: 'param', message: '起点 Y 坐标必须是数字（mm）。' });
    }

    var mode = hasIndex ? 'index' : 'coord';
    var firstIndex = -1;
    var dotsValid = collected.errors.length === 0;
    if (hasIndex) {
      if (!isFinite(startIndexRaw) || Math.floor(startIndexRaw) !== startIndexRaw) {
        errors.push({ type: 'param', message: '起点凸点序号必须为正整数（1 基，对应凸点在当前结果中的原序号）。' });
      } else if (dotsValid && (startIndexRaw < 1 || startIndexRaw > points.length)) {
        errors.push({
          type: 'start-index',
          message: '起点凸点序号 ' + startIndexRaw + ' 超出范围：当前共有 ' + points.length +
            ' 个凸点，序号应在 1～' + points.length + ' 之间。'
        });
      } else if (isFinite(startIndexRaw) && startIndexRaw >= 1) {
        firstIndex = startIndexRaw - 1;
      }
    }

    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);
    if (input.plateWidth != null && input.plateWidth !== '' && !(plateWidth > 0)) {
      errors.push({ type: 'param', message: '板材宽度必须为正数（mm），或留空不画板材底图。' });
    }
    if (input.plateHeight != null && input.plateHeight !== '' && !(plateHeight > 0)) {
      errors.push({ type: 'param', message: '板材高度必须为正数（mm），或留空不画板材底图。' });
    }

    var base = {
      ok: false,
      errors: errors,
      params: {
        mode: mode,
        startX: mode === 'coord' ? (isFinite(startX) ? round4(startX) : null) : null,
        startY: mode === 'coord' ? (isFinite(startY) ? round4(startY) : null) : null,
        startIndex: mode === 'index' ? (isFinite(startIndexRaw) ? startIndexRaw : null) : null,
        pointCount: points.length,
        plateWidth: isFinite(plateWidth) ? plateWidth : null,
        plateHeight: isFinite(plateHeight) ? plateHeight : null,
        maxRounds: MAX_2OPT_ROUNDS,
        maxPoints: MAX_POINTS
      },
      steps: [],
      order: [],
      stats: null,
      svg: null,
      csv: null
    };
    if (errors.length) return base; // 参数/数据非法：绝不输出部分路径

    // 1. 最近邻初始路线与优化前空移总长
    var nnRoute = nearestNeighbor(points, mode, startX, startY, firstIndex);
    var nnOrder = nnRoute.map(function (idx) { return points[idx].originalIndex; });
    var beforeTotal = routeLength(points, nnRoute, mode, startX, startY, firstIndex);

    // 2. 最多 20 轮 2-opt（每轮首个严格缩短反转）
    var rounds = twoOpt(points, nnRoute, mode, startX, startY, firstIndex);
    var afterTotal = routeLength(points, nnRoute, mode, startX, startY, firstIndex);

    var saved = Math.max(0, beforeTotal - afterTotal);
    var savedPercent = beforeTotal > 0 ? saved / beforeTotal * 100 : 0;

    var steps = buildSteps(points, nnRoute, mode, startX, startY);
    var order = nnRoute.map(function (idx) { return points[idx].originalIndex; });

    var svgOpts = {
      mode: mode,
      startX: startX, startY: startY,
      plateWidth: isFinite(plateWidth) ? plateWidth : null,
      plateHeight: isFinite(plateHeight) ? plateHeight : null,
      rounds: rounds,
      beforeTotal: beforeTotal,
      afterTotal: afterTotal
    };

    base.ok = true;
    base.errors = [];
    base.steps = steps;
    base.order = order;
    base.nnOrder = nnOrder; // 优化前访问顺序（原序号，1 基），便于核对/测试
    base.stats = {
      pointCount: points.length,
      beforeTotalMm: round4(beforeTotal),
      afterTotalMm: round4(afterTotal),
      savedMm: round4(saved),
      savedPercent: Math.round(savedPercent * 100) / 100,
      roundsUsed: rounds,
      maxRounds: MAX_2OPT_ROUNDS,
      improved: afterTotal < beforeTotal - EPS,
      firstStep: steps[0] ? steps[0].originalIndex : null,
      lastStep: steps.length ? steps[steps.length - 1].originalIndex : null
    };
    base.svg = buildPathSvg(points, nnRoute, steps, svgOpts);
    base.csv = buildCsv(steps);
    return base;
  }

  return {
    MAX_POINTS: MAX_POINTS,
    MAX_2OPT_ROUNDS: MAX_2OPT_ROUNDS,
    plan: plan,
    nearestNeighbor: nearestNeighbor,
    twoOpt: twoOpt,
    buildCsv: buildCsv
  };
});

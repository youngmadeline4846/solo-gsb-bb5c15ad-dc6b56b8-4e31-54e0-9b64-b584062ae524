/*
 * 盲文标签排版台 前端逻辑
 * 三种模式：
 *   - 排版：输入变化 -> 防抖调用 POST /api/layout -> 渲染 SVG 预览 / 错误 -> 下载 SVG/JSON
 *   - 多标签拼版：每行一条标签 + 共享板材/点距/行距/边距/标签间距 -> POST /api/panel，
 *     整板预览全部标签边界与点位，下载含标签索引与旋转角的 SVG/JSON
 *   - 压印质检：以最近一次成功排版的设计点为基准，粘贴实测 CSV 并设置偏移/公差/半径，
 *     调用 POST /api/qc（浏览器端也可直接用 window.QC 同构计算），渲染四类叠加 SVG 与报告下载
 */
(function () {
  'use strict';

  /* ================= 模式切换 ================= */

  var tabLayout = document.getElementById('tabLayout');
  var tabPanel = document.getElementById('tabPanel');
  var tabQc = document.getElementById('tabQc');
  var viewLayout = document.getElementById('viewLayout');
  var viewPanel = document.getElementById('viewPanel');
  var viewQc = document.getElementById('viewQc');

  function setMode(mode) {
    tabLayout.classList.toggle('active', mode === 'layout');
    tabPanel.classList.toggle('active', mode === 'panel');
    var isQc = mode === 'qc';
    tabQc.classList.toggle('active', isQc);
    tabLayout.setAttribute('aria-selected', String(mode === 'layout'));
    tabPanel.setAttribute('aria-selected', String(mode === 'panel'));
    tabQc.setAttribute('aria-selected', String(isQc));
    viewLayout.hidden = mode !== 'layout';
    viewPanel.hidden = mode !== 'panel';
    viewQc.hidden = !isQc;
    if (isQc) refreshBaselineBox();
  }
  tabLayout.addEventListener('click', function () { setMode('layout'); });
  tabPanel.addEventListener('click', function () { setMode('panel'); });
  tabQc.addEventListener('click', function () { setMode('qc'); });

  /* ================= 排版模式 ================= */

  var fields = ['text', 'plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'];
  var els = {};
  fields.forEach(function (id) { els[id] = document.getElementById(id); });

  var errorsBox = document.getElementById('errors');
  var statsBox = document.getElementById('stats');
  var preview = document.getElementById('preview');
  var brailleLine = document.getElementById('brailleLine');
  var btnSvg = document.getElementById('downloadSvg');
  var btnJson = document.getElementById('downloadJson');

  var lastResult = null;     // 最近一次成功的排版结果（用于下载）
  var lastBaseline = null;   // 最近一次成功排版的设计点基准（质检模式用，失败时不被清空）
  var debounceTimer = null;

  function collectParams() {
    var p = { text: els.text.value };
    ['plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'].forEach(function (id) {
      var v = els[id].value.trim();
      if (v !== '') p[id] = Number(v);
    });
    return p;
  }

  function renderErrors(errors) {
    errorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    errorsBox.appendChild(ul);
    errorsBox.hidden = false;
  }

  function renderStats(r) {
    var p = r.params;
    var s = r.stats;
    statsBox.innerHTML =
      '每行最多 <b>' + r.cellsPerLine + '</b> 个盲文单元，最多 <b>' + r.maxLines + '</b> 行；' +
      '本次 <b>' + s.totalLines + '</b> 行 / <b>' + s.totalCells + '</b> 个单元 / <b>' + s.totalDots + '</b> 个凸点<br>' +
      '占用幅面 ' + s.usedWidth + ' × ' + s.usedHeight + ' mm（板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，' +
      '字距 ' + p.cellGap + ' mm，凸点直径 ' + p.dotDiameter + ' mm）';
    statsBox.hidden = false;
  }

  function fmtTime(d) {
    function z(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) +
      ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }

  function update() {
    var params = collectParams();
    fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        if (r.ok) {
          lastResult = r;
          // 质检基准：记录最近一次成功排版（含时间戳与完整参数）
          lastBaseline = {
            time: fmtTime(new Date()),
            text: r.params.text,
            params: r.params,
            dots: r.dots
          };
          errorsBox.hidden = true;
          // 内联预览时去掉 XML 声明，避免被 HTML 解析器当作冗余节点
          preview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
          brailleLine.textContent = r.brailleText.replace(/\n/g, ' / ');
          renderStats(r);
          btnSvg.disabled = false;
          btnJson.disabled = false;
          if (!viewQc.hidden) refreshBaselineBox();
        } else {
          lastResult = null;
          statsBox.hidden = true;
          brailleLine.textContent = '';
          preview.innerHTML = '<p class="placeholder">排版失败：请根据左侧原因调整参数</p>';
          renderErrors(r.errors || [{ message: '未知错误' }]);
          btnSvg.disabled = true;
          btnJson.disabled = true;
        }
      })
      .catch(function () {
        lastResult = null;
        statsBox.hidden = true;
        preview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
        renderErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        btnSvg.disabled = true;
        btnJson.disabled = true;
      });
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, 250);
  }

  fields.forEach(function (id) {
    els[id].addEventListener('input', scheduleUpdate);
  });

  function download(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  btnSvg.addEventListener('click', function () {
    if (lastResult) download('braille-label.svg', 'image/svg+xml;charset=utf-8', lastResult.svg);
  });

  btnJson.addEventListener('click', function () {
    if (!lastResult) return;
    var copy = {};
    Object.keys(lastResult).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastResult[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-layout.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  /* ================= 多标签拼版模式 ================= */

  var panelFields = ['panelLabels', 'panelPlateWidth', 'panelPlateHeight', 'panelDotSpacing',
    'panelLineSpacing', 'panelMargin', 'panelLabelGap', 'panelCellGap', 'panelDotDiameter'];
  var pEls = {};
  panelFields.forEach(function (id) { pEls[id] = document.getElementById(id); });

  var panelErrorsBox = document.getElementById('panelErrors');
  var panelStatsBox = document.getElementById('panelStats');
  var panelPreview = document.getElementById('panelPreview');
  var btnPanelSvg = document.getElementById('panelDownloadSvg');
  var btnPanelJson = document.getElementById('panelDownloadJson');
  var lastPanel = null;
  var lastPanelBaseline = null; // 最近一次成功拼版（质检基准用，失败时不被清空）
  var panelTimer = null;

  function collectPanelParams() {
    var p = { labels: pEls.panelLabels.value };
    ['panelPlateWidth', 'panelPlateHeight', 'panelDotSpacing', 'panelLineSpacing',
      'panelMargin', 'panelLabelGap', 'panelCellGap', 'panelDotDiameter'].forEach(function (id) {
      var key = id.replace(/^panel/, '');
      key = key.charAt(0).toLowerCase() + key.slice(1);
      var v = pEls[id].value.trim();
      if (v !== '') p[key] = Number(v);
    });
    return p;
  }

  function renderPanelErrors(errors) {
    panelErrorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    panelErrorsBox.appendChild(ul);
    panelErrorsBox.hidden = false;
  }

  function renderPanelStats(r) {
    var s = r.stats;
    var p = r.params;
    panelStatsBox.innerHTML =
      '共 <b>' + s.labelCount + '</b> 条标签（跳过空行 <b>' + s.skippedBlank + '</b>），' +
      '其中 <b>' + s.rotatedCount + '</b> 条旋转 90°；共 <b>' + s.totalCells + '</b> 个单元 / <b>' +
      s.totalDots + '</b> 个凸点<br>' +
      '已装区域 <b>' + s.packWidth + ' × ' + s.packHeight + '</b> mm（标签面积 ' + s.labelArea +
      ' mm²，剩余面积 <b>' + s.remainingArea + '</b> mm²）；有效幅面 ' + s.usableWidth + ' × ' +
      s.usableHeight + ' mm，板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，标签间距 ' +
      p.labelGap + ' mm';
    panelStatsBox.hidden = false;
  }

  function updatePanel() {
    var params = collectPanelParams();
    fetch('/api/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(handlePanelResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.Panel) {
          try {
            handlePanelResult(Panel.packLabels(params));
          } catch (e) {
            renderPanelErrors([{ message: '拼版计算失败：' + e.message }]);
          }
        } else {
          lastPanel = null;
          panelStatsBox.hidden = true;
          panelPreview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
          renderPanelErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
          btnPanelSvg.disabled = true;
          btnPanelJson.disabled = true;
        }
      });
  }

  // fetch 成功路径与本地回退路径共用
  function handlePanelResult(r) {
    if (r.ok) {
      lastPanel = r;
      // 质检拼版基准：记录最近一次成功拼版（含时间戳、标签索引/旋转角与带元数据的全局 dots）
      lastPanelBaseline = {
        time: fmtTime(new Date()),
        params: r.params,
        labels: r.labels.map(function (l) {
          return { index: l.index, text: l.text, rotation: l.rotation };
        }),
        labelCount: r.labelCount,
        rotatedCount: r.stats ? r.stats.rotatedCount : 0,
        dots: r.dots
      };
      panelErrorsBox.hidden = true;
      panelPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderPanelStats(r);
      btnPanelSvg.disabled = false;
      btnPanelJson.disabled = false;
      // 若用户停留在质检页，立即刷新基准区（按钮可用性/标签摘要随最新拼版更新）
      if (!viewQc.hidden) refreshBaselineBox();
    } else {
      lastPanel = null;
      panelStatsBox.hidden = true;
      renderPanelErrors(r.errors || [{ message: '未知错误' }]);
      btnPanelSvg.disabled = true;
      btnPanelJson.disabled = true;
      if (!viewQc.hidden) refreshBaselineBox();
    }
  }

  function schedulePanelUpdate() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(updatePanel, 250);
  }

  panelFields.forEach(function (id) {
    pEls[id].addEventListener('input', schedulePanelUpdate);
  });

  btnPanelSvg.addEventListener('click', function () {
    if (lastPanel) download('braille-panel.svg', 'image/svg+xml;charset=utf-8', lastPanel.svg);
  });

  btnPanelJson.addEventListener('click', function () {
    if (!lastPanel) return;
    var copy = {};
    Object.keys(lastPanel).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastPanel[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-panel.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  // 首屏进入时不请求；切到拼版页签后若从未加载过则立即排一次
  var panelLoaded = false;
  tabPanel.addEventListener('click', function () {
    if (!panelLoaded) { panelLoaded = true; updatePanel(); }
  });

  /* ================= 压印质检模式 ================= */

  var qcCsv = document.getElementById('qcCsv');
  var qcOffsetX = document.getElementById('qcOffsetX');
  var qcOffsetY = document.getElementById('qcOffsetY');
  var qcRotation = document.getElementById('qcRotation');
  var qcTolerance = document.getElementById('qcTolerance');
  var qcMaxRadius = document.getElementById('qcMaxRadius');
  var qcRun = document.getElementById('qcRun');
  var qcErrors = document.getElementById('qcErrors');
  var qcStats = document.getElementById('qcStats');
  var qcPreview = document.getElementById('qcPreview');
  var qcLegend = document.getElementById('qcLegend');
  var qcBaseline = document.getElementById('qcBaseline');
  var qcMaxOffsetX = document.getElementById('qcMaxOffsetX');
  var qcMaxOffsetY = document.getElementById('qcMaxOffsetY');
  var qcMaxAngle = document.getElementById('qcMaxAngle');
  var qcAngleStep = document.getElementById('qcAngleStep');
  var qcAutoCalibrate = document.getElementById('qcAutoCalibrate');
  var qcCalibMsg = document.getElementById('qcCalibMsg');
  var btnQcCsv = document.getElementById('qcDownloadCsv');
  var btnQcSvg = document.getElementById('qcDownloadSvg');
  var qcUseLayout = document.getElementById('qcUseLayout');
  var qcUsePanel = document.getElementById('qcUsePanel');

  var lastQc = null;
  var qcTimer = null;
  // 当前质检基准来源：'layout'=最近单标签排版；'panel'=最近多标签拼版
  var baselineSource = 'layout';

  function escapeHtml(s) {
    return String(s).replace(/[<>&]/g, function (c) {
      return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
    });
  }

  function activeBaseline() {
    return baselineSource === 'panel' ? lastPanelBaseline : lastBaseline;
  }

  // 切换基准来源：刷新按钮/基准条并清掉上一次质检结果，避免叠加图与 CSV 与新基准错配；
  // 已粘贴实测 CSV 时直接按新基准重跑
  function selectBaselineSource(source) {
    baselineSource = source;
    qcUseLayout.classList.toggle('active', source === 'layout');
    qcUsePanel.classList.toggle('active', source === 'panel');
    qcUseLayout.setAttribute('aria-pressed', String(source === 'layout'));
    qcUsePanel.setAttribute('aria-pressed', String(source === 'panel'));
    lastQc = null;
    qcStats.hidden = true;
    qcLegend.hidden = true;
    qcErrors.hidden = true;
    if (!qcCalibMsg.hidden) qcCalibMsg.hidden = true;
    btnQcCsv.disabled = true;
    btnQcSvg.disabled = true;
    qcPreview.innerHTML = '<p class="placeholder">已切换基准，点击「开始质检」查看叠加结果</p>';
    refreshBaselineBox();
    if (activeBaseline() && qcCsv.value.trim() !== '') runQc();
  }

  qcUseLayout.addEventListener('click', function () { selectBaselineSource('layout'); });
  qcUsePanel.addEventListener('click', function () { selectBaselineSource('panel'); });

  function refreshBaselineBox() {
    // 按钮可用性：单标签排版在首屏即会自动成功；拼版按钮在尚无成功拼版时禁用并提示先完成拼版
    qcUseLayout.disabled = !lastBaseline;
    qcUsePanel.disabled = !lastPanelBaseline;
    qcUseLayout.title = lastBaseline ? '以最近一次成功的单标签排版设计点为基准' : '请先在「排版模式」完成一次成功排版';
    qcUsePanel.title = lastPanelBaseline ? '以最近一次成功拼版的全局 dots 为基准' : '尚无成功拼版，请先在「多标签拼版」完成一次成功拼版';
    qcUseLayout.classList.toggle('active', baselineSource === 'layout');
    qcUsePanel.classList.toggle('active', baselineSource === 'panel');

    if (baselineSource === 'panel') {
      if (lastPanelBaseline) {
        renderPanelBaseline(lastPanelBaseline);
      } else {
        qcBaseline.className = 'baseline warn';
        qcBaseline.innerHTML = '尚无成功拼版基准：请先切换到「多标签拼版」完成一次成功拼版（拼版失败不会生成基准）。';
      }
      return;
    }
    if (lastBaseline) {
      renderLayoutBaseline(lastBaseline);
    } else {
      qcBaseline.className = 'baseline warn';
      qcBaseline.innerHTML = '尚无成功排版基准：请先切换到「排版模式」完成一次成功排版。';
    }
  }

  function renderLayoutBaseline(base) {
    var safeText = escapeHtml(base.text);
    qcBaseline.className = 'baseline ok';
    qcBaseline.innerHTML =
      '基准（<b>单标签排版</b>）：最近一次成功排版「<b>' + (safeText || '（空白标签）') + '</b>」' +
      '（' + base.dots.length + ' 个设计点，板材 ' +
      base.params.plateWidth + ' × ' + base.params.plateHeight + ' mm）<br>' +
      '<span class="muted">排版时间 ' + base.time + '</span>';
  }

  function renderPanelBaseline(base) {
    // 各标签的索引/旋转角以小圆标列出（0° 蓝 / 90° 橙），title 悬停显示标签原文
    var chips = base.labels.map(function (l) {
      var cls = l.rotation === 90 ? 'rot90' : 'rot0';
      return '<span class="label-chip ' + cls + '" title="' + escapeHtml(l.text) + '">#' +
        l.index + (l.rotation === 90 ? ' ⟳90°' : '') + '</span>';
    }).join(' ');
    qcBaseline.className = 'baseline ok';
    qcBaseline.innerHTML =
      '基准（<b>多标签拼版</b>）：最近一次成功拼版共 <b>' + base.labelCount + '</b> 条标签' +
      '（<b>' + base.rotatedCount + '</b> 条旋转 90°），展平 <b>' + base.dots.length +
      '</b> 个设计点（保留 label / rotation 元数据），板材 ' +
      base.params.plateWidth + ' × ' + base.params.plateHeight + ' mm<br>' +
      '<span class="muted">拼版时间 ' + base.time + '；各标签索引 / 旋转角：</span>' +
      '<span class="label-chips">' + chips + '</span>';
  }

  function numVal(input) {
    var v = input.value.trim();
    return v === '' ? null : Number(v);
  }

  function renderQcErrors(errors) {
    qcErrors.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      if (e.line != null) li.dataset.line = e.line;
      ul.appendChild(li);
    });
    qcErrors.appendChild(ul);
    qcErrors.hidden = false;
  }

  function renderQcStats(r) {
    var s = r.stats;
    var bl = r.baseline || {};
    var labelInfo = bl.labelCount
      ? '标签 <b>' + bl.labelCount + '</b> 条，'
      : '';
    qcStats.innerHTML =
      '通过率 <b class="rate">' + s.passRatePercent + '%</b>' +
      '（合格 <b>' + s.passCount + '</b> / 设计点 ' + s.designCount + '）　' +
      labelInfo +
      '配对 <b>' + s.matchedCount + '</b>，其中偏移超差 <b>' + s.offsetCount + '</b>；' +
      '缺失 <b>' + s.missingCount + '</b>，多余 <b>' + s.extraCount + '</b><br>' +
      '最大偏差 <b>' + (s.maxDeviation == null ? '—' : s.maxDeviation) + '</b> mm；' +
      '平均偏差 <b>' + (s.meanDeviation == null ? '—' : s.meanDeviation) + '</b> mm' +
      '（公差 ' + r.params.tolerance + ' mm，关联半径 ' + r.params.maxRadius +
      ' mm，旋转 ' + r.params.rotation + '°，偏移 ' + r.params.offsetX + ' / ' + r.params.offsetY + ' mm）';
    qcStats.hidden = false;
    qcLegend.hidden = false;
  }

  function handleQcResult(r) {
    if (r.ok) {
      lastQc = r;
      qcErrors.hidden = true;
      qcPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderQcStats(r);
      btnQcCsv.disabled = false;
      btnQcSvg.disabled = false;
    } else {
      lastQc = null;
      qcStats.hidden = true;
      qcLegend.hidden = true;
      qcPreview.innerHTML = '<p class="placeholder">质检未能完成：请根据左侧错误修正后重试</p>';
      renderQcErrors(r.errors || [{ message: '未知错误' }]);
      btnQcCsv.disabled = true;
      btnQcSvg.disabled = true;
    }
  }

  function runQc() {
    var base = activeBaseline();
    if (!base) {
      refreshBaselineBox();
      var tip = baselineSource === 'panel'
        ? '没有成功拼版的设计点基准，请先在「多标签拼版」完成一次成功拼版。'
        : '没有成功排版的设计点基准，请先在「排版模式」完成排版。';
      renderQcErrors([{ message: tip }]);
      return;
    }
    var payload = {
      design: base.dots,
      plateWidth: base.params.plateWidth,
      plateHeight: base.params.plateHeight,
      csv: qcCsv.value,
      offsetX: numVal(qcOffsetX),
      offsetY: numVal(qcOffsetY),
      rotation: numVal(qcRotation),
      tolerance: numVal(qcTolerance),
      maxRadius: numVal(qcMaxRadius)
    };
    fetch('/api/qc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(handleQcResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleQcResult(QC.inspect(payload));
          } catch (e) {
            renderQcErrors([{ message: '质检计算失败：' + e.message }]);
          }
        } else {
          renderQcErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        }
      });
  }

  qcRun.addEventListener('click', runQc);

  /* ---------- 自动校准：一键估算平移（可选小角度刚体）并写回输入框 ---------- */

  function showCalibMsg(kind, text) {
    qcCalibMsg.className = 'calib-msg ' + kind;
    qcCalibMsg.textContent = text;
    qcCalibMsg.hidden = false;
  }

  function handleCalibResult(r) {
    if (r.ok) {
      // 写回估算值（程序化赋值，不会触发 input 事件），再立即重跑四类判定
      qcOffsetX.value = r.offsetX;
      qcOffsetY.value = r.offsetY;
      if (r.rigidMode) qcRotation.value = r.rotation;
      var detail = r.rigidMode
        ? '估算小角度刚体：旋转 = ' + r.rotation + '°（围绕板材中心 ' + r.centerX + ', ' +
          r.centerY + ' mm），X = ' + r.offsetX + ' mm，Y = ' + r.offsetY +
          ' mm（角度 ' + r.angleCount + ' 个、角度×平移候选 ' + r.candidateCount +
          ' 个，匹配 ' + r.matchedCount + ' 对，总残差 ' + r.totalResidual +
          ' mm）；角度与偏移已写回并自动重跑质检。'
        : '估算全局平移：X = ' + r.offsetX + ' mm，Y = ' + r.offsetY +
          ' mm（候选 ' + r.candidateCount + ' 个，匹配 ' + r.matchedCount +
          ' 对，总残差 ' + r.totalResidual + ' mm）；偏移已写回并自动重跑质检。';
      showCalibMsg('ok', detail);
      runQc();
    } else {
      // 无可用候选 / 参数非法：保留角度与偏移输入框原值，仅给出明确提示
      var msg = (r.errors && r.errors[0] && r.errors[0].message) || '自动校准失败。';
      showCalibMsg('warn', '未能估算校准参数，角度与偏移输入保持原值：' + msg);
    }
  }

  function runAutoCalibrate() {
    var base = activeBaseline();
    if (!base) {
      refreshBaselineBox();
      var tip = baselineSource === 'panel'
        ? '没有成功拼版的设计点基准，请先在「多标签拼版」完成一次成功拼版。'
        : '没有成功排版的设计点基准，请先在「排版模式」完成排版。';
      renderQcErrors([{ message: tip }]);
      return;
    }
    var payload = {
      design: base.dots,
      plateWidth: base.params.plateWidth,
      plateHeight: base.params.plateHeight,
      csv: qcCsv.value,
      maxOffsetX: numVal(qcMaxOffsetX),
      maxOffsetY: numVal(qcMaxOffsetY),
      maxRadius: numVal(qcMaxRadius)
    };
    // 最大旋转角填正数时启用「角度 × 平移」联合搜索；留空/0 时不传角度参数，
    // 走与旧版完全一致的纯平移估算（API 亦兼容不传角度的调用）
    var maxAngle = numVal(qcMaxAngle);
    var angleStep = numVal(qcAngleStep);
    if (maxAngle != null && maxAngle > 0) {
      payload.maxAngle = maxAngle;
      payload.angleStep = angleStep;
    }
    qcAutoCalibrate.disabled = true;
    fetch('/api/qc/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) { handleCalibResult(r); })
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleCalibResult(QC.estimateCalibration(payload));
          } catch (e) {
            showCalibMsg('warn', '自动校准计算失败：' + e.message);
          }
        } else {
          showCalibMsg('warn', '网络请求失败，请确认服务已启动；偏移输入保持原值。');
        }
      })
      .finally(function () { qcAutoCalibrate.disabled = false; });
  }

  qcAutoCalibrate.addEventListener('click', runAutoCalibrate);

  // 参数或 CSV 修改后防抖自动重跑（已有质检结果时），手动按钮始终可用；
  // 输入一旦被改动，清掉上一次自动校准的提示
  [qcCsv, qcOffsetX, qcOffsetY, qcRotation, qcTolerance, qcMaxRadius,
   qcMaxOffsetX, qcMaxOffsetY, qcMaxAngle, qcAngleStep].forEach(function (el) {
    el.addEventListener('input', function () {
      if (!qcCalibMsg.hidden) qcCalibMsg.hidden = true;
      if (!lastQc) return;
      clearTimeout(qcTimer);
      qcTimer = setTimeout(runQc, 300);
    });
  });

  btnQcCsv.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-report.csv', 'text/csv;charset=utf-8', lastQc.csv);
  });
  btnQcSvg.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-overlay.svg', 'image/svg+xml;charset=utf-8', lastQc.svg);
  });

  /* ================= 启动 ================= */

  update(); // 首屏立即排版
})();

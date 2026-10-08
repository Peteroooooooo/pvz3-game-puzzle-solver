(function() {
  'use strict';
  const MAX_EDGE = 960;
  const copy = {
    zh: {
      button: '📷 从图片导入', title: '从游戏截图导入', choose: '选择图片', crop: '框选游戏区域', retry: '重新识别',
      cancel: '取消', apply: '载入盘面', hint: '本地识别，不上传图片。按上排、下排从左到右编号；黄色项目请对照截图核对。',
      loading: '正在读取图片…', recognizing: '正在识别…', cropHint: '在截图上拖动框选包含全部七瓶的区域，然后重新识别。',
      cropReady: '已选择区域，点击「重新识别」。', failed: '未能定位上排 3 瓶、下排 4 瓶。请框选完整游戏区域后重试。',
      invalid: '请选择可读取的 PNG、JPG 或 WebP 图片。', unknown: '请确认', empty: '空', free: '自由中转', target: '目标配方',
      tube: n => `瓶 ${n}`, layer: n => `第 ${n} 层`, colors: ['番茄红', '橙汁橙', '豌豆绿', '水波蓝', '葡萄紫'],
      ready: (ms, n) => `已识别七瓶 · ${ms} ms${n ? ` · ${n} 项待核对` : ''}。核对后载入盘面。`,
      resolve: '请先选择标为「请确认」的格子或配方。', gap: '液体必须从瓶底连续填充，请修正中间的空格。',
      duplicate: '目标配方颜色不能重复，请核对配方。', imported: '截图配置已载入，可直接修改或求解；撤销可恢复原盘面。',
      timeout: '识别超时。请缩小到游戏区域后重试。', error: '图片识别失败，请换图或框选游戏区域后重试。', close: '关闭', preview: '截图预览，可框选游戏区域'
    },
    en: {
      button: '📷 Import screenshot', title: 'Import game screenshot', choose: 'Choose image', crop: 'Select game area', retry: 'Recognize again',
      cancel: 'Cancel', apply: 'Load board', hint: 'Processed locally; no upload. Tubes are numbered left to right, top row first. Check yellow fields against the screenshot.',
      loading: 'Reading image…', recognizing: 'Recognizing…', cropHint: 'Drag around all seven tubes, then recognize again.',
      cropReady: 'Area selected. Click “Recognize again”.', failed: 'Could not locate 3 upper and 4 lower tubes. Select the complete game area and retry.',
      invalid: 'Choose a readable PNG, JPG or WebP image.', unknown: 'Please confirm', empty: 'Empty', free: 'Free transfer', target: 'Target recipe',
      tube: n => `Tube ${n}`, layer: n => `Layer ${n}`, colors: ['Tomato Red', 'Juice Orange', 'Pea Green', 'Wave Blue', 'Grape Purple'],
      ready: (ms, n) => `7 tubes recognized · ${ms} ms${n ? ` · ${n} fields to check` : ''}. Review, then load the board.`,
      resolve: 'Choose a value for each “Please confirm” field.', gap: 'Liquid must be continuous from the bottom. Correct any gaps.',
      duplicate: 'Target recipe colors must be distinct. Check the targets.', imported: 'Screenshot loaded. Edit or solve the board; Undo restores the previous board.',
      timeout: 'Recognition timed out. Select the game area and retry.', error: 'Recognition failed. Try another image or select the game area.', close: 'Close', preview: 'Screenshot preview; drag to select the game area'
    }
  };
  const colorIds = ['R', 'O', 'G', 'B', 'P'];
  const colors = ['#ef4444', '#ff8a1f', '#22c55e', '#7dd3fc', '#a855f7'];
  const dialog = document.getElementById('waterImageDialog');
  const input = document.getElementById('waterImageFile');
  const preview = document.getElementById('waterImagePreview');
  const cards = document.getElementById('waterImageCards');
  const status = document.getElementById('waterImageStatus');
  const apply = document.getElementById('waterImageApply');
  const retry = document.getElementById('waterImageRetry');
  const cropButton = document.getElementById('waterImageCrop');
  let imageCanvas = null, result = null, roi = null, cropMode = false, drag = null;
  let worker = null, generation = 0, cancelJob = null, enginePromise = null, busy = false, drawFrame = null;
  const text = () => copy[document.documentElement.lang.startsWith('en') ? 'en' : 'zh'];

  function translate() {
    const t = text();
    for (const [id, key] of [['btnImportImage','button'], ['waterImageTitle','title'], ['waterImageChoose','choose'],
      ['waterImageCrop','crop'], ['waterImageRetry','retry'], ['waterImageCancel','cancel'], ['waterImageApply','apply'], ['waterImageHint','hint']]) {
      document.getElementById(id).textContent = t[key];
    }
    document.getElementById('waterImageClose').setAttribute('aria-label', t.close);
    preview.setAttribute('aria-label', t.preview);
    if (result) { renderCards(); updateReady(); }
  }

  function cancel() {
    generation++;
    if (worker) { worker.terminate(); worker = null; }
    if (cancelJob) { const reject = cancelJob; cancelJob = null; reject(new Error('CANCELLED')); }
    busy = false;
  }

  function release() {
    cancel(); result = null; roi = null; drag = null; cropMode = false;
    if (drawFrame !== null) { cancelAnimationFrame(drawFrame); drawFrame = null; }
    if (imageCanvas) { imageCanvas.width = 0; imageCanvas.height = 0; imageCanvas = null; }
    preview.width = 0; preview.height = 0; cards.replaceChildren();
    apply.disabled = true; retry.disabled = true; cropButton.disabled = true;
    preview.classList.remove('selecting');
  }

  function script(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src; el.onload = resolve;
      el.onerror = () => { el.remove(); reject(new Error('ENGINE_LOAD')); };
      document.head.appendChild(el);
    });
  }

  function loadEngine() {
    if (window.PVZ3WaterImage) return Promise.resolve(window.PVZ3WaterImage);
    if (!enginePromise) enginePromise = (async () => {
      if (!window.PVZ3WaterImageTemplates) await script('./water_image_templates.js');
      await script('./water_image_engine.js');
      return window.PVZ3WaterImage;
    })().catch(error => { enginePromise = null; throw error; });
    return enginePromise;
  }

  function recognizeCanvas(canvas, requestId) {
    const { width, height } = canvas;
    const fallback = async () => {
      const engine = await loadEngine();
      // Direct file opening can disallow external workers. Yield before bounded work.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (requestId !== generation) throw new Error('CANCELLED');
      return engine.recognize({ width, height, data: canvas.getContext('2d').getImageData(0, 0, width, height).data });
    };
    if (location.protocol === 'file:' || typeof Worker === 'undefined') return fallback();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        if (worker === current) { current.terminate(); worker = null; }
        cancelJob = null;
        if (error) reject(error); else resolve(value);
      };
      let current;
      try {
        current = new Worker('./water_image_worker.js'); worker = current;
        cancelJob = error => finish(error);
        timer = setTimeout(() => finish(new Error('TIMEOUT')), 5000);
        current.onmessage = event => {
          if (event.data.requestId !== requestId) return;
          finish(event.data.error ? new Error(event.data.error) : null, event.data.result);
        };
        current.onerror = event => { event.preventDefault(); finish(new Error('WORKER_LOAD')); };
        const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        current.postMessage({ requestId, width, height, buffer: pixels.buffer }, [pixels.buffer]);
      } catch (error) { finish(error); }
    }).catch(error => {
      if (requestId !== generation) throw new Error('CANCELLED');
      if (error.message === 'WORKER_LOAD' || error.name === 'SecurityError') return fallback();
      throw error;
    });
  }

  function draw() {
    if (!imageCanvas) return;
    if (preview.width !== imageCanvas.width) preview.width = imageCanvas.width;
    if (preview.height !== imageCanvas.height) preview.height = imageCanvas.height;
    const ctx = preview.getContext('2d');
    ctx.drawImage(imageCanvas, 0, 0);
    if (result) result.bottles.forEach((bottle, index) => {
      const b = bottle.box, uncertain = bottle.targetUncertain || bottle.slots.some(s => s.uncertain);
      ctx.strokeStyle = uncertain ? '#fbbf24' : '#34d399'; ctx.lineWidth = 2;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(b.x, Math.max(0, b.y - 22), 25, 22);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = 'bold 16px sans-serif';
      ctx.fillText(String(index + 1), b.x + 7, Math.max(17, b.y - 5));
    });
    const rect = drag ? dragRect() : roi;
    if (rect) {
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]); ctx.strokeRect(rect.x, rect.y, rect.width, rect.height); ctx.setLineDash([]);
    }
  }

  function dropdown(value, uncertain, isTarget, onChange) {
    const t = text(), select = document.createElement('select');
    if (uncertain) select.classList.add('needs-review');
    if (value === null && uncertain) select.add(new Option(t.unknown, '?'));
    select.add(new Option(isTarget ? t.free : t.empty, ''));
    colorIds.forEach((id, i) => select.add(new Option(t.colors[i], id)));
    select.value = value === null && uncertain ? '?' : value || '';
    select.style.borderLeft = `5px solid ${colors[colorIds.indexOf(value)] || '#64748b'}`;
    select.onchange = () => {
      if (select.value === '?') return;
      const id = select.value || null;
      onChange(id); select.classList.remove('needs-review');
      select.style.borderLeftColor = colors[colorIds.indexOf(id)] || '#64748b';
      updateReady(); draw();
    };
    return select;
  }

  function renderCards() {
    cards.replaceChildren();
    if (!result) return;
    const t = text();
    result.bottles.forEach((bottle, index) => {
      const card = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = t.tube(index + 1); card.appendChild(legend);
      for (let level = 3; level >= 0; level--) {
        const label = document.createElement('label'); label.append(t.layer(level + 1));
        const slot = bottle.slots[level];
        const select = dropdown(slot.color, slot.uncertain, false, value => { slot.color = value; slot.uncertain = false; });
        select.dataset.tube = index; select.dataset.layer = level; label.appendChild(select); card.appendChild(label);
      }
      const label = document.createElement('label'); label.append(t.target);
      const select = dropdown(bottle.target, bottle.targetUncertain, true, value => { bottle.target = value; bottle.targetUncertain = false; });
      select.dataset.tube = index; select.dataset.target = 'true'; label.appendChild(select); card.appendChild(label);
      cards.appendChild(card);
    });
  }

  function updateReady() {
    if (!result) return;
    const count = result.bottles.reduce((n, b) => n + Number(b.targetUncertain) + b.slots.filter(s => s.uncertain).length, 0);
    status.textContent = text().ready(result.elapsedMs, count);
  }

  async function runRecognition() {
    if (!imageCanvas) return;
    cancel(); const requestId = generation;
    result = null; cards.replaceChildren(); apply.disabled = true; busy = true;
    retry.disabled = true; cropButton.disabled = true; status.textContent = text().recognizing;
    cropMode = false; preview.classList.remove('selecting'); draw();
    const area = roi || { x: 0, y: 0, width: imageCanvas.width, height: imageCanvas.height };
    const work = document.createElement('canvas'), scale = Math.min(1, MAX_EDGE / Math.max(area.width, area.height));
    work.width = Math.max(1, Math.round(area.width * scale)); work.height = Math.max(1, Math.round(area.height * scale));
    work.getContext('2d').drawImage(imageCanvas, area.x, area.y, area.width, area.height, 0, 0, work.width, work.height);
    try {
      const recognized = await recognizeCanvas(work, requestId);
      if (requestId !== generation) return;
      const sx = area.width / work.width, sy = area.height / work.height;
      recognized.bottles.forEach(b => {
        b.box = { ...b.box, x: area.x + b.box.x * sx, y: area.y + b.box.y * sy, width: b.box.width * sx, height: b.box.height * sy };
      });
      result = recognized; renderCards(); updateReady(); apply.disabled = false; draw();
    } catch (error) {
      if (requestId !== generation) return;
      status.textContent = text()[error.message === 'BOTTLES_NOT_FOUND' ? 'failed' : error.message === 'TIMEOUT' ? 'timeout' : 'error'];
    } finally {
      work.width = 0; work.height = 0;
      if (requestId === generation) { busy = false; retry.disabled = false; cropButton.disabled = false; }
    }
  }

  async function openFile(file) {
    if (!file) return;
    release(); const requestId = generation;
    window.dispatchEvent(new Event('water-image-open'));
    translate(); if (!dialog.open) dialog.showModal();
    status.textContent = text().loading;
    if (!/\.(png|jpe?g|webp)$/i.test(file.name) || (file.type && !/^image\/(png|jpeg|webp)$/.test(file.type))) {
      status.textContent = text().invalid; return;
    }
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      if (requestId !== generation) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('IMAGE_SIZE');
      const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      imageCanvas = document.createElement('canvas');
      imageCanvas.width = Math.round(image.naturalWidth * scale); imageCanvas.height = Math.round(image.naturalHeight * scale);
      imageCanvas.getContext('2d').drawImage(image, 0, 0, imageCanvas.width, imageCanvas.height);
      image.src = ''; URL.revokeObjectURL(url);
      draw(); await runRecognition();
    } catch (error) {
      if (requestId === generation) status.textContent = text().invalid;
    } finally { image.src = ''; URL.revokeObjectURL(url); }
  }

  function point(event) {
    const rect = preview.getBoundingClientRect();
    return { x: Math.max(0, Math.min(preview.width, (event.clientX - rect.left) * preview.width / rect.width)),
      y: Math.max(0, Math.min(preview.height, (event.clientY - rect.top) * preview.height / rect.height)) };
  }
  function dragRect() {
    return { x: Math.round(Math.min(drag.start.x, drag.end.x)), y: Math.round(Math.min(drag.start.y, drag.end.y)),
      width: Math.round(Math.abs(drag.start.x - drag.end.x)), height: Math.round(Math.abs(drag.start.y - drag.end.y)) };
  }
  preview.onpointerdown = event => {
    if (!cropMode || busy) return;
    event.preventDefault(); preview.setPointerCapture(event.pointerId);
    drag = { start: point(event), end: point(event) }; draw();
  };
  preview.onpointermove = event => {
    if (!drag) return;
    drag.end = point(event);
    if (drawFrame === null) drawFrame = requestAnimationFrame(() => { drawFrame = null; draw(); });
  };
  preview.onpointerup = event => {
    if (!drag) return;
    drag.end = point(event); const rect = dragRect(); drag = null;
    if (rect.width >= 40 && rect.height >= 40) {
      roi = rect; result = null; cards.replaceChildren(); apply.disabled = true; status.textContent = text().cropReady;
    }
    draw();
  };
  preview.onpointercancel = () => { drag = null; draw(); };
  cropButton.onclick = () => {
    cropMode = !cropMode; preview.classList.toggle('selecting', cropMode);
    status.textContent = cropMode ? text().cropHint : text().cropReady;
  };
  retry.onclick = runRecognition;
  document.getElementById('btnImportImage').onclick = () => { input.value = ''; input.click(); };
  document.getElementById('waterImageChoose').onclick = () => { input.value = ''; input.click(); };
  input.onchange = () => openFile(input.files[0]);
  document.getElementById('waterImageCancel').onclick = () => dialog.close();
  document.getElementById('waterImageClose').onclick = () => dialog.close();
  dialog.addEventListener('close', release);
  apply.onclick = () => {
    if (!result || busy) return;
    const unresolved = [...cards.querySelectorAll('select')].find(select => select.value === '?');
    if (unresolved) { status.textContent = text().resolve; unresolved.focus(); return; }
    const tubes = result.bottles.map(b => b.slots.map(s => s.color));
    for (const tube of tubes) {
      while (tube.length && tube[tube.length - 1] === null) tube.pop();
      if (tube.some(c => c === null)) { status.textContent = text().gap; return; }
    }
    const targets = result.bottles.map(b => b.target), activeTargets = targets.filter(Boolean);
    if (new Set(activeTargets).size !== activeTargets.length) { status.textContent = text().duplicate; return; }
    window.dispatchEvent(new CustomEvent('water-image-import', { detail: { tubes, targets, message: text().imported } }));
    dialog.close();
  };
  new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  translate();
})();

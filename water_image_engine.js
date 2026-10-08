(function(root, factory) {
  const refs = typeof module === 'object' && module.exports ? require('./water_image_templates.js') : root.PVZ3WaterImageTemplates;
  const api = factory(refs);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PVZ3WaterImage = api;
})(typeof self !== 'undefined' ? self : globalThis, function(refs) {
  'use strict';

  // Work on a bounded image once per import. No dependencies or background loops.
  const MAX_EDGE = 960;
  const IDS = [null, 'R', 'O', 'G', 'B', 'P'];
  const stickerRefs = Object.entries(refs).map(([id, ref]) => {
    const pixels = Uint8Array.from(ref.pixels, c => Number(c)), whiteNear = new Uint8Array(576);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && x + dx < 24 && y + dy >= 0 && y + dy < 24 && pixels[(y + dy) * 24 + x + dx] === 6) whiteNear[y * 24 + x] = 1;
      }
    }
    return { id, ...ref, pixels, whiteNear };
  });

  function classify(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (max < 65 || delta < max * 0.32) return 0;
    let hue = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
    hue = ((hue * 60) + 360) % 360;
    // Red liquid stays red under the pale glass reflection.
    if (hue < 17 || hue >= 345) return delta > max * 0.40 && max > 100 ? 1 : 0;
    if (hue < 65) return delta > max * 0.55 && max > 110 ? 2 : 0;
    if (hue < 165) return delta > max * 0.45 ? 3 : 0;
    if (hue < 235) return 4;
    if (hue < 330) return 5;
    return 0;
  }

  function prepare(image) {
    const { width, height, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32
      || Math.max(width, height) > MAX_EDGE || data.length !== width * height * 4) {
      throw new Error('IMAGE_SIZE');
    }
    const n = width * height;
    const colors = new Uint8Array(n), masks = new Uint8Array(n);
    const hist = new Uint32Array(256);
    const activeRows = new Uint32Array(height);
    for (let i = 0; i < n; i++) {
      const k = i * 4, r = data[k], g = data[k + 1], b = data[k + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (data[k + 3] < 128) continue;
      if (max > 45) activeRows[Math.floor(i / width)]++;
      colors[i] = classify(r, g, b);
      if (max - min < max * 0.20) hist[max]++;
    }
    let total = hist.reduce((a, b) => a + b, 0), cumulative = 0, neutralPeak = 255;
    for (let v = 0; v < 256; v++) {
      cumulative += hist[v];
      if (cumulative >= total * 0.98) { neutralPeak = v; break; }
    }
    const whiteThreshold = Math.max(90, Math.min(180, neutralPeak * 0.74));
    for (let i = 0; i < n; i++) {
      const k = i * 4, r = data[k], g = data[k + 1], b = data[k + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (data[k + 3] < 128) continue;
      if (max - min < max * 0.20 && max >= whiteThreshold) masks[i] = 6;
      else if (max > 100 && max - min > max * 0.25) {
        const delta = max - min;
        let hue = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
        hue = ((hue * 60) + 360) % 360;
        masks[i] = hue < 17 || hue >= 345 ? (delta > max * 0.45 ? 1 : 0) : hue < 65 ? 2 : hue < 165 ? 3 : hue < 235 ? 4 : hue < 330 ? 5 : 0;
      }
    }
    const whiteNear = new Uint8Array(n);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const k = i * 4, max = Math.max(data[k], data[k + 1], data[k + 2]), min = Math.min(data[k], data[k + 1], data[k + 2]);
      // Sticker outlines are tinted by bottle lighting. This relaxed rim map
      // is only used for sticker matching, never for bottle localization.
      if (data[k + 3] >= 128 && max >= whiteThreshold && max - min < max * 0.40) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) whiteNear[i + dy * width + dx] = 1;
      }
    }
    let firstRow = 0, lastRow = height - 1;
    while (firstRow < lastRow && activeRows[firstRow] < width * 0.04) firstRow++;
    while (lastRow > firstRow && activeRows[lastRow] < width * 0.04) lastRow--;
    return { ...image, colors, masks, whiteNear, whiteThreshold, activeHeight: lastRow - firstRow + 1 };
  }

  // A 3x3 close joins small JPEG/antialiasing gaps. Keep color classes separate.
  function components(frame) {
    const { width: w, height: h, masks } = frame;
    const n = w * h, dilated = new Uint8Array(n), closed = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bits = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const c = masks[i + dy * w + dx];
          if (c) bits |= 1 << c;
        }
        dilated[i] = bits;
      }
    }
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        let bits = 126;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) bits &= dilated[i + dy * w + dx];
        closed[i] = bits;
      }
    }
    const visited = new Uint8Array(n), queue = new Int32Array(n), candidates = [];
    for (let seed = 0; seed < n; seed++) {
      let bits = closed[seed] & ~visited[seed];
      for (let c = 1; c <= 6 && bits; c++) {
        const bit = 1 << c;
        if (!(bits & bit)) continue;
        bits &= ~bit;
        let head = 0, tail = 1, minX = w, maxX = 0, minY = h, maxY = 0;
        queue[0] = seed; visited[seed] |= bit;
        while (head < tail) {
          const p = queue[head++], x = p % w, y = Math.floor(p / w);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const q = p + dy * w + dx;
            if (q < 0 || q >= n || x + dx < 0 || x + dx >= w) continue;
            if ((closed[q] & bit) && !(visited[q] & bit)) {
              visited[q] |= bit; queue[tail++] = q;
            }
          }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bh >= Math.max(24, frame.activeHeight * 0.12) && bh < frame.activeHeight * 0.65 && bw >= bh * 0.30 && bw <= bh * 1.15
          && tail >= bh * bw * 0.07 && tail <= bh * bw * 0.85) {
          candidates.push({ x: minX, y: minY, width: bw, height: bh, border: c, area: tail });
        }
      }
    }
    return candidates.sort((a, b) => b.height - a.height).slice(0, 48);
  }

  function overlap(a, b) {
    const iw = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const ih = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return iw * ih / Math.min(a.width * a.height, b.width * b.height);
  }

  function locate(frame, retry = true) {
    const candidates = components(frame);
    let best = null;
    // Compare a bounded set of height/row hypotheses, never all combinations.
    for (const anchor of candidates) {
      const eligible = candidates.filter(c => c.height >= anchor.height * 0.72 && c.height <= anchor.height * 1.38);
      for (const top of eligible) {
        const topRow = eligible.filter(c => Math.abs(c.y + c.height - top.y - top.height) < anchor.height * 0.22);
        const bottomOptions = eligible.filter(c => c.y > top.y + anchor.height * 0.75);
        for (const bottom of bottomOptions) {
          const bottomRow = eligible.filter(c => Math.abs(c.y + c.height - bottom.y - bottom.height) < anchor.height * 0.20);
          const unique = row => {
            const result = [];
            for (const c of row.sort((a, b) => b.height - a.height)) {
              if (!result.some(v => overlap(c, v) > 0.35)) result.push(c);
            }
            return result.sort((a, b) => a.x - b.x);
          };
          const upper = unique(topRow), lower = unique(bottomRow);
          if (upper.length !== 3 || lower.length !== 4) continue;
          const boxes = [...upper, ...lower];
          if (boxes.some(c => c.x <= 2 || c.y <= 2 || c.x + c.width >= frame.width - 2
            || c.y + c.height >= frame.height - 2)) continue;
          const spanTop = upper[2].x + upper[2].width - upper[0].x;
          const spanBottom = lower[3].x + lower[3].width - lower[0].x;
          if (spanTop < anchor.height * 1.8 || spanBottom < anchor.height * 2.4) continue;
          const mean = boxes.reduce((s, c) => s + c.height, 0) / 7;
          const variation = boxes.reduce((s, c) => s + Math.abs(c.height - mean), 0) / (mean * 7);
          const score = mean / frame.height - variation * 0.5;
          if (!best || score > best.score) best = { boxes, score };
        }
      }
    }
    if (!best) {
      if (retry) {
        // At small scales, pale background pixels can connect a white bottle
        // outline to the shelf. One stricter neutral pass separates that bridge.
        const masks = frame.masks.slice(), threshold = frame.whiteThreshold * 1.06;
        for (let i = 0; i < masks.length; i++) if (masks[i] === 6) {
          const k = i * 4;
          if (Math.max(frame.data[k], frame.data[k + 1], frame.data[k + 2]) < threshold) masks[i] = 0;
        }
        return locate({ ...frame, masks }, false);
      }
      throw new Error('BOTTLES_NOT_FOUND');
    }
    return best.boxes;
  }

  function recognize(image) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frame = prepare(image);
    const boxes = locate(frame);
    const bottles = boxes.map(box => readBottle(frame, box));
    return { bottles, width: image.width, height: image.height,
      elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start) };
  }

  function readBottle(frame, box) {
    const { x, y, width: bw, height: bh, border } = box;
    const target = readTarget(frame, box);
    const jug = bw / bh > 0.70 && (border === 2 || border === 4);
    // The hourglass/jug neck can shift the centre. Recover the body span per row
    // from its actual outline instead of taking the bounding-box centre (handles).
    const profiles = [];
    for (let yy = Math.ceil(y + bh * 0.16); yy < y + bh * 0.95; yy++) {
      let left = -1, right = -1;
      for (let xx = x; xx < x + bw; xx++) {
        if (frame.masks[yy * frame.width + xx] === border) {
          if (left < 0) left = xx;
          right = xx;
        }
      }
      if (jug) {
        // A calibrated jug body profile excludes the handle. Coordinates are
        // relative to the detected contour, independent of screenshot resolution.
        const shape = [[0.16,0.18,0.64], [0.40,0.26,0.62], [0.68,0.07,0.78], [0.94,0.23,0.65]];
        const t = (yy - y) / bh;
        for (let s = 1; s < shape.length; s++) {
          if (t <= shape[s][0]) {
            const a = shape[s - 1], b = shape[s], f = Math.max(0, (t - a[0]) / (b[0] - a[0]));
            left = x + bw * (a[1] + (b[1] - a[1]) * f);
            right = x + bw * (a[2] + (b[2] - a[2]) * f);
            break;
          }
        }
      }
      profiles.push({ yy, left, right });
    }
    const bins = Array.from({ length: 4 }, () => new Uint32Array(6));
    const samples = new Uint32Array(4);
    for (const row of profiles) {
      if (row.left < 0 || row.right - row.left < bw * 0.20) continue;
      const level = Math.min(3, Math.floor((row.yy - (y + bh * 0.215)) / (bh * 0.74 / 4)));
      if (level < 0) continue;
      const span = row.right - row.left;
      for (const f of [0.10, 0.13, 0.16, 0.84, 0.87, 0.90]) {
        const xx = Math.round(row.left + span * f);
        const sticker = target.box;
        if (sticker && xx >= sticker.x && xx < sticker.x + sticker.width
          && row.yy >= sticker.y && row.yy < sticker.y + sticker.height) {
          if (target.mask) {
            if (target.mask[(row.yy - sticker.y) * sticker.width + xx - sticker.x]) continue;
          } else {
            const ref = stickerRefs.find(r => r.id === target.color);
            const tx = Math.floor((xx - sticker.x) * 24 / sticker.width), ty = Math.floor((row.yy - sticker.y) * 24 / sticker.height);
            const c = ref.pixels[ty * 24 + tx];
            if (c === 6 || c === IDS.indexOf(target.color) || (target.color === 'R' && (c === 2 || c === 3))) continue;
          }
        }
        const pixel = row.yy * frame.width + xx;
        let c = frame.colors[pixel];
        if (border === 5 && c === 5) {
          const k = pixel * 4, max = Math.max(frame.data[k], frame.data[k + 1], frame.data[k + 2]);
          const min = Math.min(frame.data[k], frame.data[k + 1], frame.data[k + 2]);
          // A purple rim and the shelf visible through an empty grape bottle
          // are desaturated; grape liquid inside that bottle is saturated.
          if (max - min < max * 0.50) c = 0;
        }
        bins[level][c]++; samples[level]++;
      }
    }
    const slots = bins.map((counts, i) => {
      const rank = [...counts].map((count, color) => ({ count, color })).sort((a, b) => b.count - a.count);
      const winner = rank[0];
      return { color: IDS[winner.color], uncertain: samples[i] < 12 || winner.count / Math.max(1, samples[i]) < 0.55 };
    }).reverse();
    // An unambiguously empty bottom implies an empty tube when no upper layer
    // has a positive color reading (a sticker may hide all samples in one band).
    if (!slots[0].color && !slots[0].uncertain && slots.every(s => !s.color)) slots.forEach(s => { s.uncertain = false; });
    return { box: { ...box }, slots, target: target.color, targetUncertain: target.uncertain,
      targetBox: target.box, targetScore: target.score };
  }

  function readTarget(frame, box) {
    const { x, y, width: bw, height: bh } = box;
    const enclosed = enclosedSticker(frame, box);
    function match(ref, cx, cy, height, stride) {
      const width = height * ref.aspect, sx = cx - width / 2, sy = cy - height / 2;
      let expectedWhite = 0, foundWhite = 0, correctWhite = 0, correctFound = 0, colored = 0, correctColor = 0;
      for (let yy = 0; yy < 24; yy += stride) {
        const row = Math.round(sy + (yy + 0.5) * height / 24);
        if (row < 0 || row >= frame.height) return { score: 0 };
        for (let xx = 0; xx < 24; xx += stride) {
          const col = Math.round(sx + (xx + 0.5) * width / 24);
          if (col < 0 || col >= frame.width) return { score: 0 };
          const i = row * frame.width + col;
          const actual = frame.masks[i] === 6 ? 6 : frame.colors[i], wanted = ref.pixels[yy * 24 + xx];
          // Transparent template pixels describe no foreground. Liquid and
          // background behind the sticker must not contribute to its score.
          if (!wanted) continue;
          if (wanted === 6) { expectedWhite++; if (frame.whiteNear[i]) correctWhite++; }
          if (actual === 6) { foundWhite++; if (ref.whiteNear[yy * 24 + xx]) correctFound++; }
          if (wanted && wanted !== 6) { colored++; if (actual === wanted) correctColor++; }
        }
      }
      const whiteFit = (correctWhite / Math.max(1, expectedWhite) + correctFound / Math.max(1, foundWhite)) / 2;
      const colorFit = correctColor / Math.max(1, colored);
      return { score: whiteFit * 0.65 + colorFit * 0.35, cx, cy, height, ref,
        box: { x: sx, y: sy, width, height } };
    }
    const matches = [];
    for (const ref of stickerRefs) {
      if (enclosed && ref.id !== enclosed.color) continue;
      let best = { score: 0 };
      for (const scale of [0.26, 0.32, 0.38, 0.44, 0.50]) {
        for (let fx = 0.28; fx < 0.73; fx += 0.08) for (let fy = 0.46; fy < 0.76; fy += 0.06) {
          const m = match(ref, x + bw * fx, y + bh * fy, bh * scale, 2);
          if (m.score > best.score) best = m;
        }
      }
      matches.push(best);
    }
    matches.sort((a, b) => b.score - a.score);
    let best = { score: 0 };
    for (const coarse of matches) {
      if (!coarse.ref) continue;
      const step = Math.max(1, Math.round(bh * 0.016));
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        for (const dh of [-0.025, 0, 0.025]) {
          const m = match(coarse.ref, coarse.cx + dx * step, coarse.cy + dy * step, coarse.height + bh * dh, 1);
          if (m.score > best.score) best = m;
        }
      }
    }
    if (best.score < 0.77 || (!enclosed && best.score < 0.90)) {
      if (enclosed) return enclosed;
      // A weak template resemblance alone is not evidence of a sticker.
      // Reflections and liquid decoration also produce medium scores.
      return { color: null, uncertain: false, box: null, score: Math.round(best.score * 100) / 100 };
    }
    if (enclosed && enclosed.color === best.ref.id) {
      // Mask the actual enclosed sticker, including its tinted outline,
      // rather than guessing exclusion pixels from an approximate rectangle.
      return { ...enclosed, uncertain: best.score < 0.82, score: Math.round(best.score * 100) / 100 };
    }
    return { color: best.ref.id, uncertain: best.score < 0.85,
      box: best.box, score: Math.round(best.score * 100) / 100 };
  }

  // Local pale-rim enclosure supports tinted/previously unseen sticker shapes.
  // Reflections have no substantial enclosed, consistently colored interior.
  function enclosedSticker(frame, bottle) {
    const x = Math.ceil(bottle.x + bottle.width * 0.12), y = Math.ceil(bottle.y + bottle.height * 0.30);
    const w = Math.floor(bottle.width * 0.76), h = Math.floor(bottle.height * 0.57), n = w * h;
    const mask = new Uint8Array(n), dilated = new Uint8Array(n), closed = new Uint8Array(n);
    // Game lighting tints the grape's white outline pink. Relax saturation only
    // in this small interior ROI; bottle localization keeps its original masks.
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const k = ((y + yy) * frame.width + x + xx) * 4;
      const max = Math.max(frame.data[k], frame.data[k + 1], frame.data[k + 2]);
      const min = Math.min(frame.data[k], frame.data[k + 1], frame.data[k + 2]);
      mask[yy * w + xx] = Number(max >= frame.whiteThreshold && max - min < max * 0.40);
    }
    for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
      const i = yy * w + xx;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (mask[i + dy * w + dx]) dilated[i] = 1;
    }
    for (let yy = 2; yy < h - 2; yy++) for (let xx = 2; xx < w - 2; xx++) {
      const i = yy * w + xx;
      let value = 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) value &= dilated[i + dy * w + dx];
      closed[i] = value;
    }
    const visited = new Uint8Array(n), queue = new Int32Array(n), regions = [];
    for (let seed = 0; seed < n; seed++) {
      if (closed[seed] || visited[seed]) continue;
      let head = 0, tail = 1, touchesEdge = false, minX = w, maxX = 0, minY = h, maxY = 0;
      queue[0] = seed; visited[seed] = 1;
      const counts = new Uint32Array(6);
      while (head < tail) {
        const i = queue[head++], xx = i % w, yy = Math.floor(i / w);
        if (xx === 0 || yy === 0 || xx === w - 1 || yy === h - 1) touchesEdge = true;
        minX = Math.min(minX, xx); maxX = Math.max(maxX, xx); minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
        counts[frame.colors[(y + yy) * frame.width + x + xx]]++;
        for (let direction = 0; direction < 4; direction++) {
          const dx = direction === 0 ? -1 : direction === 1 ? 1 : 0;
          const dy = direction === 2 ? -1 : direction === 3 ? 1 : 0;
          const nx = xx + dx, ny = yy + dy, q = ny * w + nx;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && !closed[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; }
        }
      }
      const rw = maxX - minX + 1, rh = maxY - minY + 1;
      if (touchesEdge || rh < bottle.height * 0.14 || rh > bottle.height * 0.48 || rw < bottle.width * 0.18 || rw > bottle.width * 0.70) continue;
      let color = 1;
      for (let c = 2; c <= 5; c++) if (counts[c] > counts[color]) color = c;
      const colored = tail - counts[0];
      if (colored < tail * 0.60 || counts[color] < colored * 0.65) continue;
      // Keep the original enclosed shape rather than masking its whole rectangle.
      const excluded = new Uint8Array(n);
      for (let i = 0; i < tail; i++) excluded[queue[i]] = 1;
      for (let i = 0; i < n; i++) if (closed[i]) excluded[i] = 1;
      regions.push({ color: IDS[color], uncertain: true, box: { x, y, width: w, height: h }, mask: excluded, score: counts[color] / tail });
    }
    return regions.sort((a, b) => b.score - a.score)[0] || null;
  }

  return { MAX_EDGE, recognize, classify };
});

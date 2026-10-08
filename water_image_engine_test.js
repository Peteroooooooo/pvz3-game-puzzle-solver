'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const engine = require('./water_image_engine.js');

// Exact decoded pixels of the supplied screenshot, reduced to 960x441.
// Stored compressed so tests need no image decoder, browser, or new dependency.
const source = { width: 960, height: 441, data: zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'tests/fixtures/water-sort-example.rgba.gz'))) };
const expected = [
  ['B', 'G', 'P', 'B'], ['O', 'P', 'P', 'O'], ['R', 'G', 'O', 'G'],
  ['B', 'G', 'B', 'R'], [null, null, null, null], ['P', 'O', 'R', 'R'], [null, null, null, null]
];
const targets = [null, 'B', 'P', 'R', 'O', null, null];

function frame(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

function resize(input, width) {
  const height = Math.round(input.height * width / input.width), output = frame(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, (x + 0.5) * input.width / width - 0.5), sy = Math.max(0, (y + 0.5) * input.height / height - 0.5);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(input.width - 1, x0 + 1), y1 = Math.min(input.height - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    for (let c = 0; c < 3; c++) {
      const a = input.data[(y0 * input.width + x0) * 4 + c] * (1 - fx) + input.data[(y0 * input.width + x1) * 4 + c] * fx;
      const b = input.data[(y1 * input.width + x0) * 4 + c] * (1 - fx) + input.data[(y1 * input.width + x1) * 4 + c] * fx;
      output.data[(y * width + x) * 4 + c] = a * (1 - fy) + b * fy;
    }
  }
  return output;
}

function paste(output, input, x, y, rect = { x: 0, y: 0, width: input.width, height: input.height }) {
  for (let dy = 0; dy < rect.height; dy++) for (let dx = 0; dx < rect.width; dx++) {
    const src = ((rect.y + dy) * input.width + rect.x + dx) * 4, dst = ((y + dy) * output.width + x + dx) * 4;
    output.data.set(input.data.subarray(src, src + 4), dst);
  }
  return output;
}

const baseline = engine.recognize(source);
const reflowed = frame(960, 441);
baseline.bottles.forEach((b, i) => {
  const upper = i < 3, x = upper ? 170 + i * 175 : 125 + (i - 3) * 180;
  const y = (upper ? 210 : 412) - b.box.height;
  paste(reflowed, source, x, y, b.box);
});
const padded = paste(frame(960, 500), resize(source, 800), 80, 65);
const portrait = paste(frame(720, 960), resize(source, 720), 0, 300);
const dim = { ...source, data: Uint8ClampedArray.from(source.data, (v, i) => i % 4 === 3 ? v : Math.round(v * 0.85)) };
const cropped = paste(frame(480,375), source, 0,0, {x:240,y:50,width:480,height:375});
const cases = [['supplied screenshot', source], ['720px', resize(source, 720)], ['640px', resize(source, 640)],
  ['wide margins', padded], ['portrait black margins', portrait], ['changed tube spacing', reflowed], ['85% brightness', dim], ['selected game area',cropped]];
const timings = [];
const failures = [];
for (const [name, image] of cases) {
  try {
    const result = engine.recognize(image);
    const actual = result.bottles.map(b => b.slots.map(s => s.color)), actualTargets = result.bottles.map(b => b.target);
    if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(actualTargets) !== JSON.stringify(targets)) {
      failures.push({ name, actual, actualTargets });
    }
    for (const index of [0, 5, 6]) {
      if (result.bottles[index].targetUncertain) {
        failures.push({ name, bottle: index + 1, error: 'a bottle without a sticker must be free transfer, not an unresolved recipe' });
      }
    }
    timings.push({ name, milliseconds: result.elapsedMs });
  } catch (error) { failures.push({ name, error: error.message }); }
}
assert.deepEqual(failures, [], 'all configurations and empty-bottle targets must match');
const grape = { width: 960, height: 441, data: zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'tests/fixtures/water-sort-grape.rgba.gz'))) };
const grapeSlots = [
  ['R','O','B','B'], ['P','B','R','P'], ['G','G','R','O'], ['O','G','G','O'],
  [null,null,null,null], [null,null,null,null], ['P','R','P','B']
];
const grapeTargets = ['R','B',null,null,'G',null,'P'];
const grapeCases = [['grape screenshot', grape], ['grape 720px', resize(grape,720)], ['grape 640px', resize(grape,640)],
  ['grape portrait margins', paste(frame(720,960),resize(grape,720),0,300)],
  ['grape 85% brightness', {...grape, data: Uint8ClampedArray.from(grape.data,(v,i) => i % 4 === 3 ? v : Math.round(v*.85))}]];
for (const [name,image] of grapeCases) {
  const result = engine.recognize(image);
  assert.deepEqual(result.bottles.map(b => b.slots.map(s => s.color)), grapeSlots, `${name}: sticker pixels must not change liquid layers`);
  assert.deepEqual(result.bottles.map(b => b.target), grapeTargets, `${name}: grape and pea recipes must be recognized`);
  assert.ok([2,3,5].every(i => !result.bottles[i].targetUncertain), `${name}: plain bottles must remain free transfer`);
  timings.push({name,milliseconds:result.elapsedMs});
}
const emptyGrape = { width: 960, height: 441, data: zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'tests/fixtures/water-sort-empty-grape.rgba.gz'))) };
const emptyGrapeSlots = [
  ['B','O','P','O'], ['G','P','B','G'], ['B','R','G','G'], ['O','B','P','P'],
  ['R','O','R','R'], [null,null,null,null], [null,null,null,null]
];
const emptyGrapeTargets = [null,'G','B','O',null,null,'P'];
const emptyGrapeCases = [['empty grape screenshot',emptyGrape], ['empty grape 720px',resize(emptyGrape,720)],
  ['empty grape 640px',resize(emptyGrape,640)], ['empty grape 480px',resize(emptyGrape,480)],
  ['empty grape portrait margins',paste(frame(720,960),resize(emptyGrape,720),0,300)],
  ['empty grape 85% brightness',{...emptyGrape,data:Uint8ClampedArray.from(emptyGrape.data,(v,i)=>i%4===3?v:Math.round(v*.85))}],
  ['empty grape selected game area',paste(frame(515,370),emptyGrape,0,0,{x:250,y:50,width:515,height:370})]];
for (const [name,image] of emptyGrapeCases) {
  let result;
  assert.doesNotThrow(()=>{ result=engine.recognize(image); },`${name}: all seven bottles must be located`);
  assert.deepEqual(result.bottles.map(b=>b.slots.map(s=>s.color)),emptyGrapeSlots,`${name}: reflected red is liquid; purple glass and shelf are not`);
  assert.deepEqual(result.bottles.map(b=>b.target),emptyGrapeTargets,`${name}: foreground recipe shapes must be independent of their background`);
  assert.ok(result.bottles.every(b=>!b.targetUncertain && b.slots.every(s=>!s.uncertain)),`${name}: this clear screenshot must load without unresolved or review fields`);
  timings.push({name,milliseconds:result.elapsedMs});
}
const greenSticker = { ...source, data: Uint8ClampedArray.from(source.data) };
for (let y = 336; y <= 374; y++) for (let x = 641; x <= 679; x++) {
  const distance = Math.hypot(x - 660, y - 355);
  if (distance > 18) continue;
  const i = (y * greenSticker.width + x) * 4;
  const rgb = distance >= 14 ? [245,245,245] : [60,175,20];
  greenSticker.data.set(rgb, i);
}
const greenResult = engine.recognize(greenSticker);
assert.equal(greenResult.bottles[6].target, 'G', 'an unseen green sticker is recognized by its enclosed color');
assert.equal(greenResult.bottles[6].targetUncertain, true, 'generic sticker classification requires review');
assert.deepEqual(greenResult.bottles[6].slots.map(s => s.color), [null,null,null,null], 'a sticker is not liquid');
const tintedSticker = {...greenSticker, data:Uint8ClampedArray.from(greenSticker.data)};
for (let y=336;y<=374;y++) for (let x=641;x<=679;x++) {
  const distance=Math.hypot(x-660,y-355);
  if (distance>=14 && distance<=18) tintedSticker.data.set([245,180,235],(y*tintedSticker.width+x)*4);
}
const tintedResult=engine.recognize(tintedSticker);
assert.equal(tintedResult.bottles[6].target,'G','a pink rim must work for other sticker shapes and colors too');
assert.deepEqual(tintedResult.bottles[6].slots.map(s=>s.color),[null,null,null,null],'a tinted sticker is not liquid');
const partial = frame(960,441);
const syntheticTubes = [['P','P','P','P'], ['G','O','B'], ['R','G'], ['B'], [], ['O','R','B','G'], []];
const rgb = { R: [230,35,20], O: [245,135,0], G: [40,155,10], B: [35,200,235], P: [115,20,170] };
function rect(image, x, y, width, height, color) {
  for (let yy = Math.ceil(y); yy < y + height; yy++) for (let xx = Math.ceil(x); xx < x + width; xx++) image.data.set(color, (yy * image.width + xx) * 4);
}
syntheticTubes.forEach((tube, i) => {
  const upper = i < 3, x = upper ? 250 + i * 150 : 180 + (i - 3) * 150, y = upper ? 65 : 260;
  rect(partial, x,y,65,140,[240,240,240]); rect(partial,x+4,y+4,57,132,[40,45,50]);
  tube.forEach((c, slot) => rect(partial,x+5,y+140*(0.955-(slot+1)*0.185),55,140*0.185,rgb[c]));
});
const partialResult = engine.recognize(partial);
assert.deepEqual(partialResult.bottles.map(b => b.slots.map(s => s.color)), syntheticTubes.map(t => [...t, ...Array(4-t.length).fill(null)]), 'partial fills and four identical adjacent layers');
assert.deepEqual(partialResult.bottles.map(b => b.target), Array(7).fill(null), 'liquid color is not a recipe target');
assert.ok(partialResult.bottles.every(b => !b.targetUncertain), 'plain bottles must not request recipe confirmation');
assert.throws(() => engine.recognize(frame(960, 441)), /BOTTLES_NOT_FOUND/);
assert.throws(() => engine.recognize(frame(961, 100)), /IMAGE_SIZE/);
assert.throws(() => engine.recognize({ width: 960, height: 441, data: new Uint8Array(2) }), /IMAGE_SIZE/);
const missingBottle = { ...source, data: Uint8ClampedArray.from(source.data) };
const missing = baseline.bottles[6].box;
for (let y = missing.y - 3; y < missing.y + missing.height + 3; y++) {
  for (let x = missing.x - 3; x < missing.x + missing.width + 3; x++) {
    const k = (y * missingBottle.width + x) * 4;
    missingBottle.data[k] = missingBottle.data[k + 1] = missingBottle.data[k + 2] = 0;
  }
}
assert.throws(() => engine.recognize(missingBottle), /BOTTLES_NOT_FOUND/, 'a missing bottle must not be guessed');
console.log(JSON.stringify(timings, null, 2));
console.log('water_image_engine_test: PASS');

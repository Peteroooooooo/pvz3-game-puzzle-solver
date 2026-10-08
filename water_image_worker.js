'use strict';
importScripts('./water_image_templates.js', './water_image_engine.js');
self.onmessage = event => {
  const { requestId, width, height, buffer } = event.data;
  try {
    const result = self.PVZ3WaterImage.recognize({ width, height, data: new Uint8ClampedArray(buffer) });
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({ requestId, error: error.message });
  }
};

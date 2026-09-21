'use strict';

importScripts('./water_solver_engine.js');

self.onmessage = event => {
  const { requestId, mode, tubes, targets, options } = event.data || {};
  try {
    let result;
    if (mode === 'static-optimal') {
      result = self.PVZ3WaterSolverEngine.solveStaticOptimal(tubes, targets, options);
    } else if (mode === 'fast-next-clear') {
      result = self.PVZ3WaterSolverEngine.solveNextClearFast(tubes, targets, options);
    } else {
      result = self.PVZ3WaterSolverEngine.solveRefillPolicy(tubes, targets, options);
    }
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error && error.stack ? error.stack : String(error)
    });
  }
};

/* worker.js -- runs the whole image pipeline off the UI thread. */
'use strict';
importScripts('lib/opencv.js', 'pipeline.js');

let pipe = null, readyCb = [];
// NOTE: never resolve a Promise with the opencv module object (it is a thenable that resolves to itself).
function onReady(cvObj) {
  pipe = IronPipeline.createPipeline(cvObj);
  postMessage({ type: 'ready' });
}
if (self.cv && self.cv.Mat) onReady(self.cv);
else self.cv.onRuntimeInitialized = () => onReady(self.cv);

onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'analyze') return;
  if (!pipe) { postMessage({ type: 'error', code: 'not_ready', message: 'Image engine is still loading. Try again in a moment.' }); return; }
  try {
    const img = { data: new Uint8ClampedArray(m.buffer), width: m.width, height: m.height };
    const res = pipe.analyze(img, m.device, m.bundle, (stage) => postMessage({ type: 'progress', stage }));
    postMessage({ type: 'result', result: res });
  } catch (err) {
    const msg = String(err && err.message || err);
    if (err && err.name === 'PipelineError') postMessage({ type: 'error', code: err.code, message: err.message });
    else if (/memory|allocation|abort|OOM/i.test(msg)) postMessage({ type: 'error', code: 'oom', message: 'The phone ran out of memory processing this photo. Close other apps and try again.' });
    else postMessage({ type: 'error', code: 'internal', message: 'Unexpected error while analysing this photo: ' + msg });
  }
};

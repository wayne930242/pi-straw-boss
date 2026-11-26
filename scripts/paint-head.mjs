import assert from 'node:assert/strict';

/** Use the main document's frame ID: a nested SVG image can emit its own PrePaint on this same renderer thread. */
export function headCosts(events, window, pid) {
  const frame = events.flatMap(e => e.name === 'TracingStartedInBrowser' ? e.args?.data?.frames ?? [] : [])
    .find(f => f.isOutermostMainFrame && f.processId === pid && new URL(f.url).pathname.endsWith('/head'));
  assert.ok(frame, 'head document missing from renderer trace');
  const paints = window.filter(e => e.name === 'Paint');
  const doc = window.filter(e => e.name === 'PrePaint' && e.args?.data?.frame === frame.frame);
  assert.ok(doc.length, 'no head document PrePaint in marked window');
  const ms = rows => rows.reduce((sum, e) => {
    assert.ok(e.ph === 'X' && Number.isFinite(e.dur) && e.dur >= 0, `missing ${e.name} duration`);
    return sum + e.dur;
  }, 0) / 1000;
  return { documentPrePaint: doc.length, paintMs: ms(paints), documentPrePaintMs: ms(doc) };
}

export function headGate(standard, raven, original) {
  const work = row => row.paintMs + row.documentPrePaintMs;
  assert.ok(standard.paint > 0 && work(original) > 0, 'empty reference paint measurement');
  const paintLimit = 3 * standard.paint, workLimitMs = 0.6 * work(original);
  return { paintLimit, workLimitMs, workMs: work(raven), originalWorkMs: work(original),
    pass: raven.paint <= paintLimit && work(raven) <= workLimitMs };
}

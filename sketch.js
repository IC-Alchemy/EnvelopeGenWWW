/* Polymetric Trips - Filter Envelope UI + Audio (p5 + p5.sound) */

let osc, filter, ampEnv;
let isAudioReady = false;

// Gate state for manual envelope evaluation (for cutoff modulation)
let gateOn = false;
let gateStartSec = 0;
let releaseStartSec = 0;
let releaseStartLevel = 0;

// Controls
let uiRoot;
let attackS, decayS, sustainS, releaseS;
let minCutoffS, maxCutoffS, resonanceS;
let gateBtn;

/* Cached values */
let A = 0.02, D = 0.15, S = 0.6, R = 0.3;
let minCutHz = 200, maxCutHz = 4000, qRes = 6;

/* Envelope UI interaction state */
const PREVIEW_SUSTAIN = 0.8; // seconds, for visualization and mapping
let envRect = {x:0, y:0, w:0, h:0};
let handlePos = { attack:{x:0,y:0}, sustain:{x:0,y:0}, release:{x:0,y:0} };
let dragging = null; // 'attack' | 'sustain' | 'release'
const HANDLE_R = 10;

/* Cutoff range interaction state */
let cutRect = {x:0, y:0, w:0, h:0};
let cutHandlePos = { min:{x:0,y:0}, max:{x:0,y:0} };
let draggingCut = null; // 'min' | 'max'

function setup() {
  const w = Math.min(windowWidth - 32, 1080);
  const h = Math.round(Math.min(windowHeight - 220, 520));
  createCanvas(w, Math.max(280, h));

  buildUI();
  noStroke();
}

function windowResized() {
  const w = Math.min(windowWidth - 32, 1080);
  const h = Math.round(Math.min(windowHeight - 220, 520));
  resizeCanvas(w, Math.max(280, h));
}

function buildUI() {
  uiRoot = select('#ui');

  const rows = [];

  rows.push(makeSliderRow('Attack', 0, 2000, 1, 50, v => `${(v/1000).toFixed(2)}s`, s => attackS = s));
  rows.push(makeSliderRow('Decay', 0, 3000, 1, 150, v => `${(v/1000).toFixed(2)}s`, s => decayS = s));
  rows.push(makeSliderRow('Sustain', 0, 1000, 1, 600, v => `${(v/1000).toFixed(2)}`, s => sustainS = s));
  rows.push(makeSliderRow('Release', 0, 4000, 1, 300, v => `${(v/1000).toFixed(2)}s`, s => releaseS = s));

  rows.push(makeSliderRow('Cutoff Min', 0, 1000, 1, hzToNorm(200)*1000, v => {
    const hz = normToHz(v/1000);
    return `${fmtHz(hz)}`;
  }, s => minCutoffS = s));

  rows.push(makeSliderRow('Cutoff Max', 0, 1000, 1, hzToNorm(4000)*1000, v => {
    const hz = normToHz(v/1000);
    return `${fmtHz(hz)}`;
  }, s => maxCutoffS = s));

  rows.push(makeSliderRow('Resonance', 5, 200, 1, 60, v => {
    return `Q ${(v/10).toFixed(1)}`;
  }, s => resonanceS = s));

  // Gate button
  const row = createDiv().addClass('row').parent(uiRoot);
  const lab = createElement('label', 'Gate').parent(row);
  const btn = createButton('Hold to Play').addClass('gate').parent(row);
  btn.mousePressed(handlePress);
  btn.mouseReleased(handleRelease);
  gateBtn = btn;

  // Keyboard
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      handlePress();
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' || e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      handleRelease();
    }
  });
}

function makeSliderRow(labelText, min, max, step, val, fmt, assign) {
  const row = createDiv().addClass('row').parent(uiRoot);
  createElement('label', labelText).parent(row);
  const slider = createSlider(min, max, val, step).parent(row);
  const valEl = createSpan('').addClass('value').parent(row);
  const update = () => {
    valEl.html(fmt(slider.value()));
  };
  slider.input(update);
  update();
  assign(slider);
  return row;
}

function ensureAudio() {
  if (isAudioReady) return;
  const ctx = getAudioContext();
  if (ctx.state !== 'running') ctx.resume();

  osc = new p5.Oscillator('sawtooth');
  filter = new p5.Filter('lowpass');
  ampEnv = new p5.Envelope();

  // Signal flow: osc -> filter -> master
  osc.disconnect();
  osc.connect(filter);
  filter.connect(); // to master

  // Base tone
  osc.freq(110); // A2
  osc.start();

  // Very low base amp; envelope will shape audible level
  osc.amp(0);

  isAudioReady = true;
}

function handlePress() {
  ensureAudio();
  if (!isAudioReady) return;

  // Update parameters from UI
  syncParamsFromUI();

  // Set amp envelope and trigger
  ampEnv.setADSR(A, D, S, R);
  ampEnv.setRange(0.35, 0.0001);
  ampEnv.triggerAttack(osc);

  // Gate state for cutoff envelope
  gateOn = true;
  gateStartSec = millis()/1000;
}

function handleRelease() {
  if (!isAudioReady) return;
  ampEnv.triggerRelease(osc);

  // Compute current level at release to start release segment of cutoff env
  const now = millis()/1000;
  releaseStartLevel = evalEnvLevel(now - gateStartSec); // level at release
  releaseStartSec = now;
  gateOn = false;
}

function draw() {
  background('#0e0f12');
  drawGrid();

  // Sync params every frame for responsiveness
  syncParamsFromUI();

  // Evaluate current envelope level and apply to filter cutoff
  const now = millis()/1000;
  let level;
  if (gateOn) {
    level = evalEnvLevel(now - gateStartSec);
  } else {
    level = evalReleaseLevel(now - releaseStartSec, releaseStartLevel);
  }
  const cutoff = lerp(minCutHz, maxCutHz, constrain(level, 0, 1));
  if (isAudioReady) {
    filter.freq(cutoff);
    filter.res(qRes); // p5.Filter Q
  }

  drawEnvelopeVis(level);
  drawCutoffBar(cutoff);
}

// Sync UI -> params with constraints
function syncParamsFromUI() {
  if (!attackS) return;
  A = attackS.value()/1000;
  D = decayS.value()/1000;
  S = sustainS.value()/1000;
  R = releaseS.value()/1000;

  // Ensure min <= max
  const minN = minCutoffS.value()/1000;
  const maxN = maxCutoffS.value()/1000;
  if (minN > maxN) {
    maxCutoffS.value(minCutoffS.value());
  }
  minCutHz = normToHz(minCutoffS.value()/1000);
  maxCutHz = normToHz(maxCutoffS.value()/1000);

  qRes = resonanceS.value()/10;
}

// Manual ADSR evaluation for visualization and cutoff driving
function evalEnvLevel(t) {
  if (t <= 0) return 0;
  if (t < A) {
    return t / Math.max(A, 1e-6);
  }
  const t2 = t - A;
  if (t2 < D) {
    const dNorm = t2 / Math.max(D, 1e-6);
    return 1 - (1 - S) * dNorm;
  }
  return S;
}

function evalReleaseLevel(tSinceRelease, startLevel) {
  if (tSinceRelease <= 0) return startLevel || 0;
  if (R <= 0) return 0;
  const r = 1 - (tSinceRelease / R);
  if (r <= 0) return 0;
  return (startLevel || 0) * r;
}

function drawGrid() {
  push();
  const pad = 16;
  const w = width - pad*2;
  const h = height - pad*2;
  translate(pad, pad);

  // Panel bg
  noStroke();
  fill('#16181d');
  rect(0, 0, w, h, 12);

  // Subtle grid
  stroke('#1e222a');
  strokeWeight(1);
  const rows = 6, cols = 16;
  for (let i=1;i<rows;i++) {
    const y = (i/rows)*h;
    line(0, y, w, y);
  }
  for (let j=1;j<cols;j++) {
    const x = (j/cols)*w;
    line(x, 0, x, h);
  }

  pop();
}

function drawEnvelopeVis(currentLevel) {
  push();

  // Geometry
  const pad = 24;
  const w = width - pad*2;
  const h = height*0.6;
  const x0 = pad;
  const y0 = 24;
  translate(x0, y0);

  // Expose rect (canvas coords) for hit-testing
  envRect = { x: x0, y: y0, w, h };

  // Timeline scaling
  const total = Math.max(0.2, A + D + R + PREVIEW_SUSTAIN);
  const sx = w / total;

  // ADSR path
  noFill();
  stroke('#4cc2ff');
  strokeWeight(2);

  // Attack + Decay
  beginShape();
  vertex(0, h);                 // start at 0
  vertex(A*sx, 0);              // attack peak
  vertex((A + D)*sx, h - h*S);  // decay to sustain
  endShape();

  // Sustain (dashed)
  const sustStartX = (A + D)*sx;
  const sustEndX = (A + D + PREVIEW_SUSTAIN)*sx;
  setLineDash([6,6]);
  line(sustStartX, h - h*S, sustEndX, h - h*S);
  setLineDash([]);

  // Release
  beginShape();
  vertex(sustEndX, h - h*S);
  vertex(sustEndX + R*sx, h);
  endShape();

  // Current level marker (indicator only)
  const xNow = map(currentLevel, 0, 1, 0, w);
  stroke('#7ee787');
  strokeWeight(6);
  point(xNow, h - h*currentLevel);

  // Handle positions (canvas coords for hit-testing)
  handlePos.attack  = { x: x0 + A*sx,                               y: y0 + 0 };
  handlePos.sustain = { x: x0 + (A + D)*sx,                         y: y0 + (h - h*S) };
  handlePos.release = { x: x0 + (A + D + PREVIEW_SUSTAIN + R)*sx,   y: y0 + h };

  // Draw handles (in local coords)
  const hovered = pickHandle(mouseX, mouseY);
  noStroke();
  drawHandleCircle(handlePos.attack,  hovered==='attack'  || dragging==='attack');
  drawHandleCircle(handlePos.sustain, hovered==='sustain' || dragging==='sustain');
  drawHandleCircle(handlePos.release, hovered==='release' || dragging==='release');

  // Cursor hint
  if (hovered && !dragging) {
    cursor('pointer');
  } else if (!dragging) {
    cursor('default');
  }

  // Labels
  noStroke();
  fill('#9aa4b2');
  textSize(12);
  text('Envelope (ADSR) — drag handles: A, D/S, R', 2, -6);

  pop();
}

function drawCutoffBar(cutoffHz) {
  push();
  const pad = 24;
  const w = width - pad*2;
  const y = height - 60;

  // Local draw space
  translate(pad, 0);

  // Scale on log axis (local x in [0..w])
  const xFromHzLocal = hz => {
    const n = hzToNorm(hz);
    return lerp(0, w, n);
  };

  // Expose rect (canvas coords) for hit-testing and handle drawing
  // Give it a thicker hit height for easier touch/mouse interactions
  cutRect = { x: pad, y, w, h: 28 };

  // Rail
  stroke('#1e222a');
  strokeWeight(6);
  line(0, y, w, y);

  // Range
  stroke('#4cc2ff');
  strokeWeight(6);
  const xMinLocal = xFromHzLocal(minCutHz);
  const xMaxLocal = xFromHzLocal(maxCutHz);
  line(xMinLocal, y, xMaxLocal, y);

  // Current cutoff
  stroke('#7ee787');
  strokeWeight(10);
  point(xFromHzLocal(cutoffHz), y);

  // End handles (canvas coords for hit test)
  cutHandlePos.min = { x: pad + xMinLocal, y };
  cutHandlePos.max = { x: pad + xMaxLocal, y };

  // Hover feedback and cursor
  const hoveredCut = pickCutHandle(mouseX, mouseY);
  noStroke();
  drawCutHandle(cutHandlePos.min, hoveredCut==='min' || draggingCut==='min');
  drawCutHandle(cutHandlePos.max, hoveredCut==='max' || draggingCut==='max');
  if (hoveredCut && !draggingCut) cursor('pointer');

  // Ticks and labels
  noStroke();
  fill('#9aa4b2');
  textSize(12);
  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const t of ticks) {
    const x = xFromHzLocal(t);
    stroke('#1e222a');
    strokeWeight(1);
    line(x, y-10, x, y+10);
    noStroke();
    fill('#9aa4b2');
    textAlign(CENTER);
    text(fmtHz(t), x, y+24);
  }

  // Legend
  textAlign(LEFT);
  text(`Cutoff: ${fmtHz(cutoffHz)}  |  Range: ${fmtHz(minCutHz)} – ${fmtHz(maxCutHz)}  |  Q ${qRes.toFixed(1)}`, 0, y-16);

  pop();
}

function setLineDash(list) {
  drawingContext.setLineDash(list);
}

/* === Envelope Interaction: helpers and events === */

function clampf(v, min, max){ return Math.min(max, Math.max(min, v)); }

function pointInEnv(x, y) {
  return x >= envRect.x && x <= envRect.x + envRect.w &&
         y >= envRect.y && y <= envRect.y + envRect.h;
}

function dist2(ax, ay, bx, by){
  const dx = ax - bx, dy = ay - by;
  return dx*dx + dy*dy;
}

function pickHandle(mx, my){
  if (!pointInEnv(mx, my)) return null;
  const r2 = (HANDLE_R + 4) * (HANDLE_R + 4);
  let best = null, bestD = Infinity;
  const order = ['attack','sustain','release'];
  for (const name of order){
    const p = handlePos[name];
    const d = dist2(mx, my, p.x, p.y);
    if (d <= r2 && d < bestD){
      best = name;
      bestD = d;
    }
  }
  return best;
}

function drawHandleCircle(pCanvas, active){
  // We are inside translated envelope space; convert to local coords
  const px = pCanvas.x - envRect.x;
  const py = pCanvas.y - envRect.y;
  push();
  fill(active ? '#e6edf3' : '#c6d0dc');
  stroke(active ? '#4cc2ff' : '#1e222a');
  strokeWeight(active ? 2 : 1);
  circle(px, py, HANDLE_R*2);
  pop();
}

/* Cutoff bar handle */
function drawCutHandle(pCanvas, active){
  const px = pCanvas.x - cutRect.x;
  const py = pCanvas.y - cutRect.y;
  push();
  fill(active ? '#e6edf3' : '#c6d0dc');
  stroke(active ? '#4cc2ff' : '#1e222a');
  strokeWeight(active ? 2 : 1);
  circle(px, py, HANDLE_R*2);
  pop();
}

function pickCutHandle(mx, my){
  // Expand vertical hitbox around the bar for easier interaction
  const yTop = cutRect.y - 18;
  const yBot = cutRect.y + 18;
  if (!(mx >= cutRect.x && mx <= cutRect.x + cutRect.w && my >= yTop && my <= yBot)) return null;

  const r2 = (HANDLE_R + 4) * (HANDLE_R + 4);
  let best = null, bestD = Infinity;
  for (const name of ['min','max']){
    const p = cutHandlePos[name];
    const d = dist2(mx, my, p.x, p.y);
    if (d <= r2 && d < bestD){
      best = name; bestD = d;
    }
  }
  return best;
}

function updateCutFromPointer(x, _y){
  if (!draggingCut) return;
  const n = clampf((x - cutRect.x) / cutRect.w, 0, 1);
  const hz = normToHz(n);

  if (draggingCut === 'min'){
    minCutHz = clampf(hz, 20, Math.min(maxCutHz, 20000));
  } else if (draggingCut === 'max'){
    maxCutHz = clampf(hz, Math.max(20, minCutHz), 20000);
  }

  // Keep order
  if (minCutHz > maxCutHz){
    if (draggingCut === 'min') minCutHz = maxCutHz;
    else maxCutHz = minCutHz;
  }

  pushCutoffToSliders();
}

function pushCutoffToSliders(){
  if (!minCutoffS || !maxCutoffS) return;
  setSliderValue(minCutoffS, Math.round(hzToNorm(minCutHz)*1000));
  setSliderValue(maxCutoffS, Math.round(hzToNorm(maxCutHz)*1000));
}
function updateFromPointer(x, y){
  if (!dragging) return;
  const w = envRect.w, h = envRect.h;
  const total = Math.max(0.2, A + D + R + PREVIEW_SUSTAIN);
  const sx = w / total;

  if (dragging === 'attack'){
    const t = clampf( (x - envRect.x) / sx, 0, 2.0 );
    A = t;
  } else if (dragging === 'sustain'){
    const t = clampf( (x - envRect.x) / sx, A, A + 3.0 );
    D = clampf(t - A, 0, 3.0);
    const lev = clampf(1 - (y - envRect.y) / h, 0, 1);
    S = lev;
  } else if (dragging === 'release'){
    const tAbs = (x - envRect.x) / sx;
    const sustEnd = A + D + PREVIEW_SUSTAIN;
    R = clampf(tAbs - sustEnd, 0, 4.0);
  }

  pushParamsToSliders();
}

function setSliderValue(slider, v){
  slider.value(v);
  if (slider.elt){
    slider.elt.dispatchEvent(new Event('input', { bubbles:true }));
  }
}

function pushParamsToSliders(){
  if (!attackS) return;
  setSliderValue(attackS,  Math.round(A*1000));
  setSliderValue(decayS,   Math.round(D*1000));
  setSliderValue(sustainS, Math.round(S*1000));
  setSliderValue(releaseS, Math.round(R*1000));
}

/* Mouse */
function mousePressed(){
  // Try cutoff handles first
  const hc = pickCutHandle(mouseX, mouseY);
  if (hc){
    draggingCut = hc;
    return false;
  }
  // Then envelope handles
  const h = pickHandle(mouseX, mouseY);
  if (h){
    dragging = h;
    return false;
  }
}
function mouseDragged(){
  if (draggingCut){
    updateCutFromPointer(mouseX, mouseY);
    return false;
  }
  if (dragging){
    updateFromPointer(mouseX, mouseY);
    return false;
  }
}
function mouseReleased(){
  let consumed = false;
  if (draggingCut){
    draggingCut = null;
    consumed = true;
  }
  if (dragging){
    dragging = null;
    consumed = true;
  }
  if (consumed) return false;
}

// Touch
function touchStarted(){
  if (touches && touches.length){
    const t = touches[0];
    const hc = pickCutHandle(t.x, t.y);
    if (hc){
      draggingCut = hc;
      return false;
    }
    const h = pickHandle(t.x, t.y);
    if (h){
      dragging = h;
      return false;
    }
  }
}
function touchMoved(){
  if (touches && touches.length){
    const t = touches[0];
    if (draggingCut){
      updateCutFromPointer(t.x, t.y);
      return false;
    }
    if (dragging){
      updateFromPointer(t.x, t.y);
      return false;
    }
  }
}
function touchEnded(){
  let consumed = false;
  if (draggingCut){
    draggingCut = null;
    consumed = true;
  }
  if (dragging){
    dragging = null;
    consumed = true;
  }
  if (consumed) return false;
}

// Utils

function normToHz(n) {
  const min = 20, max = 20000;
  const ratio = max / min; // 1000
  return min * Math.pow(ratio, n);
}

function hzToNorm(hz) {
  const min = 20, max = 20000;
  const ratio = max / min;
  return constrain(Math.log(hz/min)/Math.log(ratio), 0, 1);
}

function fmtHz(hz) {
  if (hz >= 1000) return `${(hz/1000).toFixed(hz<10000?2:1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

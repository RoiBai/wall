const SUPABASE_URL = "https://gobqzibnugfsypmdadss.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvYnF6aWJudWdmc3lwbWRhZHNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzQwOTgsImV4cCI6MjA4ODA1MDA5OH0.l99SE5sdkZ9ipI5KZ1IYyPtLs1co1fA4e9WPrb-lJII";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// room from URL: ?room=abc
function getRoom() {
  const p = new URLSearchParams(location.search);
  return p.get("room") || "public";
}

// persistent user id
function getUserId() {
  const k = "berlinwall_user_id";
  let v = localStorage.getItem(k);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(k, v);
  }
  return v;
}

const ROOM = getRoom();
const USER_ID = getUserId();

let currentTopStickerId = null;
let currentTopOwnerId = null;
let lastSendTs = 0; // transform throttle

let capture, gFiltered;

let W = 900, H = 520;
let leftW, rightW;

const shapeOptions = ["circle", "rect", "tri", "star"];
const filterOptions = ["NONE", "INVERT", "GRAY", "POSTERIZE", "THRESHOLD", "BLUR"];

let selectedShape = "circle";
let selectedFilter = "INVERT";

const ui = { barH: 110 };
const SAFE = 10;

let overlay = { x: 220, y: 200, s: 220, dragging:false, resizing:false, dx:0, dy:0 };

// Right side: baked wall + single editable top sticker
let wallBase;
let topSticker = null; // {gfx,x,y,s,dragging,resizing,dx,dy}

// ---------- responsive ----------
function fitCanvasToHolder(){
  const holder = document.getElementById("p5-holder");
  if (!holder) return;

  // --- 1) compute target canvas size (keep aspect 900:520) ---
  const r = holder.getBoundingClientRect();
  const aspect = 900 / 520;

  let cw = r.width;
  let ch = r.height;

  let targetW = cw;
  let targetH = cw / aspect;
  if (targetH > ch) {
    targetH = ch;
    targetW = ch * aspect;
  }

  // small padding to avoid visual clipping by border-radius
  targetW = Math.max(200, Math.floor(targetW) - 2);
  targetH = Math.max(120, Math.floor(targetH) - 2);

  // --- 2) cache old sizes + layers (for preserving wall) ---
  const oldW = W;
  const oldH = H;
  const oldLeftW = leftW;
  const oldAreaH = (H - ui.barH);

  const oldWall = wallBase;     // may be undefined at first run
  const oldTop = topSticker;    // may be null

  // --- 3) resize main canvas ---
  resizeCanvas(targetW, targetH, true);

  // update globals
  W = width; 
  H = height;
  leftW = W / 2;
  rightW = W / 2;

  const areaH = H - ui.barH;

  // --- 4) recreate gFiltered (left preview buffer) ---
  gFiltered = createGraphics(leftW, areaH);
  gFiltered.pixelDensity(1);

  // --- 5) recreate wallBase but COPY old content into it ---
  wallBase = createGraphics(rightW, areaH);
  wallBase.pixelDensity(1);
  wallBase.clear();

  if (oldWall) {
    // oldWall is in right-panel local coords (0..oldRightW, 0..oldAreaH)
    // scale it to new right-panel size
    wallBase.image(oldWall, 0, 0, rightW, areaH);
  }

  // --- 6) preserve overlay position (keep inside left panel) ---
  if (!oldW || !oldH) {
    // first time: set a nice default
    overlay.x = leftW * 0.35;
    overlay.y = areaH * 0.55;
    overlay.s = Math.min(Math.min(leftW, areaH) * 0.55, 220);
  } else {
    // scale overlay center and size approximately with left panel
    const sx = leftW / (oldLeftW || leftW);
    const sy = areaH / (oldAreaH || areaH);

    overlay.x *= sx;
    overlay.y *= sy;
    overlay.s *= Math.min(sx, sy);

    // keep reasonable bounds
    overlay.s = constrain(overlay.s, 60, Math.min(leftW, areaH) * 0.95);
    constrainOverlayToLeft();
  }

  // --- 7) preserve topSticker (position/scale) if exists ---
  if (oldTop && oldW && oldH) {
    const sxAll = W / oldW;
    const syAll = areaH / (oldAreaH || areaH);

    // keep the same visual placement (global coords)
    oldTop.x *= sxAll;
    oldTop.y *= syAll;
    oldTop.s *= Math.min(sxAll, syAll);

    topSticker = oldTop;
    constrainTopSticker(topSticker);
  } else {
    // if no oldTop, keep as is
    // (do nothing)
  }
}

function setup(){
  const holder = document.getElementById("p5-holder");
  const cnv = createCanvas(900, 520);
  if (holder) cnv.parent(holder);
  pixelDensity(1);

  capture = createCapture(VIDEO);
  capture.size(640, 480);
  capture.hide();

  leftW = width / 2;
  rightW = width / 2;

  const areaH = height - ui.barH;
  gFiltered = createGraphics(leftW, areaH); gFiltered.pixelDensity(1);

  wallBase = createGraphics(rightW, areaH); wallBase.pixelDensity(1); wallBase.clear();

  fitCanvasToHolder();
  loadSnapshotIfAny().then(() => subscribeWall());
}

function windowResized(){
  fitCanvasToHolder();
}

// ---------- draw ----------
function draw(){
  background(30);

  noStroke();
  fill(40); rect(0, 0, leftW, H-ui.barH);
  fill(45); rect(leftW, 0, rightW, H-ui.barH);

  drawLiveLeft();
  drawRightWall();
  drawBottomBar();

  stroke(80);
  line(leftW, 0, leftW, H-ui.barH);
  line(0, H-ui.barH, W, H-ui.barH);
}

function drawLiveLeft(){
  const areaH = H - ui.barH;

  imageMode(CORNER);
  rectMode(CORNER);

  // base camera
  image(capture, 0, 0, leftW, areaH);

  // overlay outline always visible
  drawOverlayOutline();

  // filter preview inside shape (applies immediately)
  if (selectedFilter === "NONE") return;

  gFiltered.clear();
  gFiltered.image(capture, 0, 0, leftW, areaH);
  applyFilterToGraphics(gFiltered, selectedFilter);

  drawingContext.save();
  drawingContext.beginPath();
  addShapePathToContext(drawingContext, selectedShape, overlay.x, overlay.y, overlay.s);
  drawingContext.clip();
  image(gFiltered, 0, 0);
  drawingContext.restore();
}

function getOverlayHandlePos(){
  // triangle: handle near the right-bottom vertex
  if (selectedShape === "tri"){
    return { x: overlay.x + overlay.s * 0.55, y: overlay.y + overlay.s * 0.55 };
  }
  // others: bounding box bottom-right
  return { x: overlay.x + overlay.s * 0.5, y: overlay.y + overlay.s * 0.5 };
}

function drawOverlayOutline(){
  const areaH = H - ui.barH;

  push();
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(0,0,leftW,areaH);
  drawingContext.clip();

  noFill(); stroke(255); strokeWeight(2);
  drawShapeOutline(selectedShape, overlay.x, overlay.y, overlay.s);

  // resize handle (shape-aware)
  const hp = getOverlayHandlePos();
  noStroke(); fill(255);
  circle(hp.x, hp.y, 10);

  drawingContext.restore();
  pop();
}

function drawRightWall(){
  const areaH = H - ui.barH;

  push();
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(leftW,0,rightW,areaH);
  drawingContext.clip();

  imageMode(CORNER);
  image(wallBase, leftW, 0);

  if(topSticker){
    const st = topSticker;
    imageMode(CENTER);

    const w = st.gfx.width * st.s;
    const h = st.gfx.height * st.s;
    image(st.gfx, st.x, st.y, w, h);

    rectMode(CENTER);
    noFill(); stroke(255); strokeWeight(2);
    rect(st.x, st.y, w, h);

    const hx = st.x + w/2, hy = st.y + h/2;
    noStroke(); fill(255);
    circle(hx, hy, 10);
  }

  drawingContext.restore();
  pop();
}

// ---------- interaction ----------
function mousePressed(){
  // bottom bar click
  if(mouseY >= H - ui.barH){
    handleBarClick();
    return;
  }

  // right: only topSticker editable
  if(mouseX >= leftW && mouseY < H-ui.barH && topSticker && topSticker.editable){
    const st = topSticker;
    const w = st.gfx.width * st.s;
    const h = st.gfx.height * st.s;

    const hx = st.x + w/2, hy = st.y + h/2;
    if(dist(mouseX, mouseY, hx, hy) < 10){
      st.resizing = true;
      st.dx = mouseX - hx;
      st.dy = mouseY - hy;
      return;
    }
    if(pointInRectCenter(mouseX, mouseY, st.x, st.y, w, h)){
      st.dragging = true;
      st.dx = mouseX - st.x;
      st.dy = mouseY - st.y;
      return;
    }
  }

  // left overlay drag/resize
  if(mouseX < leftW && mouseY < H-ui.barH){
    const handle = leftHandleHit(mouseX, mouseY);
    if(handle==="resize"){
      overlay.resizing=true;
      const hp = getOverlayHandlePos();
      overlay.dx = mouseX - hp.x;
      overlay.dy = mouseY - hp.y;
      return;
    }
    if(pointInShape(selectedShape, mouseX, mouseY, overlay.x, overlay.y, overlay.s)){
      overlay.dragging=true;
      overlay.dx = mouseX - overlay.x;
      overlay.dy = mouseY - overlay.y;
      return;
    }
  }
}

function mouseDragged(){
  // left overlay
  if(overlay.dragging){
    overlay.x = mouseX - overlay.dx;
    overlay.y = mouseY - overlay.dy;
    constrainOverlayToLeft();
  }
  if(overlay.resizing){
    const hp = getOverlayHandlePos();
    // compute new size by dragging toward handle direction
    const hx = mouseX - overlay.dx;
    const hy = mouseY - overlay.dy;

    // approximate: use max distance from center along x/y
    const newS = max(60, max((hx - overlay.x) * 2, (hy - overlay.y) * 2));
    overlay.s = min(newS, Math.min(leftW, (H-ui.barH)) * 0.95);
    constrainOverlayToLeft();
  }

  // right topSticker
  if(topSticker && topSticker.editable){
    const st = topSticker;

    if(st.dragging){
      st.x = mouseX - st.dx;
      st.y = mouseY - st.dy;
      constrainTopSticker(st);
    }

    if(st.resizing){
      const hx = mouseX - st.dx;
      const hy = mouseY - st.dy;
      const w = max(60, (hx - st.x) * 2);
      const h = max(60, (hy - st.y) * 2);
      const sFromW = w / st.gfx.width;
      const sFromH = h / st.gfx.height;
      st.s = constrain(max(sFromW, sFromH), 0.15, 3.0);
      constrainTopSticker(st);
    }

    if (topSticker && topSticker.editable && currentTopStickerId && currentTopOwnerId === USER_ID) {
      if (topSticker.dragging || topSticker.resizing) {
        sendTransformEvent(currentTopStickerId, topSticker.x, topSticker.y, topSticker.s);
      }
    }
  }
}

function mouseReleased(){
  overlay.dragging=false;
  overlay.resizing=false;

  if(topSticker){
    topSticker.dragging = false;
    topSticker.resizing = false;
  }
}

function constrainTopSticker(st){
  const areaH = H - ui.barH;
  st.x = constrain(st.x, leftW + 20, W - 20);
  st.y = constrain(st.y, 20, areaH - 20);
}

// ---------- bottom bar logic ----------
function handleBarClick(){
  const y0 = H - ui.barH;

  const shapeYOffset = 12;

  let x = SAFE + 10, y = y0 + 22 + shapeYOffset;
  for (let i = 0; i < shapeOptions.length; i++) {
    const bx = x + i * 54, by = y + 20;
    if (hitRectCenter(mouseX, mouseY, bx, by, 44, 44)) {
      selectedShape = shapeOptions[i];
      return;
    }
  }

  // filter buttons
  let fx = SAFE + 260, fy = y0+26;
  for(let i=0;i<filterOptions.length;i++){
    const bx = fx+(i%3)*110;
    const by = fy+floor(i/3)*40;
    if(hitRect(mouseX, mouseY, bx, by, 100, 30)){
      selectedFilter = filterOptions[i];
      return;
    }
  }

  // capture icon
  const capX = min(SAFE + 710, W - SAFE - 110);
  if(hitRect(mouseX, mouseY, capX, y0+26, 110, 70)){
    captureAndMergeToWall();
    return;
  }
}

// ---------- capture + bake ----------
function bakeTopStickerToWall(){
  if(!topSticker) return;

  const st = topSticker;

  wallBase.push();
  wallBase.imageMode(CENTER);

  const localX = st.x - leftW; // right-local
  const localY = st.y;

  const w = st.gfx.width * st.s;
  const h = st.gfx.height * st.s;

  wallBase.image(st.gfx, localX, localY, w, h);
  wallBase.pop();

  topSticker = null;
}

function captureAndMergeToWall(){
  const areaH = H - ui.barH;

  // map left overlay crop -> video coords
  const cropX_left = overlay.x - overlay.s/2;
  const cropY_left = overlay.y - overlay.s/2;
  const cropS_left = overlay.s;

  const sx = (cropX_left / leftW) * capture.width;
  const sy = (cropY_left / areaH) * capture.height;
  const sW = (cropS_left / leftW) * capture.width;
  const sH = (cropS_left / areaH) * capture.height;

  const stickerSize = int(constrain(overlay.s, 60, 320));
  let sticker = createGraphics(stickerSize, stickerSize);
  sticker.pixelDensity(1);
  sticker.clear();

  sticker.image(capture, 0, 0, stickerSize, stickerSize, sx, sy, sW, sH);
  if(selectedFilter !== "NONE") applyFilterToGraphics(sticker, selectedFilter);

  // mask to shape
  const ctx = sticker.drawingContext;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  addShapePathToContext(ctx, selectedShape, stickerSize/2, stickerSize/2, stickerSize);
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";

  // ✅ publish only (do NOT set topSticker here, do NOT bake here)
  (async () => {
    try{
      const stickerId = crypto.randomUUID();
      const initX = leftW + rightW/2;
      const initY = areaH/2;
      const initS = 1.0;

      console.log("STEP1 uploading sticker...");
      const url = await uploadStickerGraphic(sticker, stickerId);
      console.log("STEP1 ok url=", url);

      console.log("STEP2 inserting wall_events...");
      const inserted = await sendCaptureEvent(stickerId, url, initX, initY, initS);
      console.log("STEP2 ok inserted=", inserted);

    } catch(e){
      console.error("publish failed FULL:", e);
      alert("Publish failed: " + (e?.message || JSON.stringify(e)));
    }
  })();
}

// ---------- UI drawing ----------
function drawBottomBar(){
  const y0 = H - ui.barH;

  noStroke();
  fill(25);
  rect(SAFE, y0, W - SAFE*2, ui.barH);

  const shapeYOffset = 12; 

  drawSectionLabel(SAFE + 10, y0 + 12, "SHAPE");
  let x = SAFE + 10, y = y0 + 22 + shapeYOffset;
  for (let i = 0; i < shapeOptions.length; i++) {
    const opt = shapeOptions[i];
    const bx = x + i * 54;
    const by = y + 20;
    drawIconButton(bx, by, 44, 44, opt, selectedShape === opt);
  }

  drawSectionLabel(SAFE + 260, y0+12, "FILTER");
  let fx = SAFE + 260, fy = y0+26;
  for(let i=0;i<filterOptions.length;i++){
    const opt = filterOptions[i];
    const bx = fx + (i%3)*110;
    const by = fy + floor(i/3)*40;
    drawTextButton(bx, by, 100, 30, opt, selectedFilter===opt);
  }

  // Capture icon button: right-aligned with SAFE padding
  const capX = min(SAFE + 710, W - SAFE - 110);
  drawCaptureIconButton(capX, y0+26, 110, 70);
}

function drawSectionLabel(x,y,label){
  push();
  fill(200);
  textSize(12);
  textAlign(LEFT, TOP);
  text(label, x, y);
  pop();
}

function drawIconButton(cx, cy, w, h, shapeName, active){
  push();
  rectMode(CENTER);
  stroke(active ? 255 : 120);
  strokeWeight(active ? 2 : 1);
  fill(35);
  rect(cx, cy, w, h, 8);

  noStroke();
  fill(220);
  const s=18;
  if(shapeName==="circle") circle(cx, cy, s*1.5);
  if(shapeName==="rect") { rectMode(CENTER); rect(cx, cy, s*1.6, s*1.2, 4); }
  if(shapeName==="tri") triangle(cx, cy-s*0.9, cx-s, cy+s*0.8, cx+s, cy+s*0.8);
  if(shapeName==="star") drawStarIcon(cx, cy, s*0.45, s, 5);
  pop();
}

function drawStarIcon(cx, cy, r1, r2, n){
  push();
  beginShape();
  for(let i=0;i<n*2;i++){
    const a = -HALF_PI + i*PI/n;
    const r = (i%2===0)? r2 : r1;
    vertex(cx + cos(a)*r, cy + sin(a)*r);
  }
  endShape(CLOSE);
  pop();
}

function drawTextButton(x,y,w,h,label,active){
  push();
  rectMode(CORNER);
  stroke(active ? 255 : 120);
  strokeWeight(active ? 2 : 1);
  fill(35);
  rect(x,y,w,h,8);

  fill(230);
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(12);
  text(label, x+w/2, y+h/2);
  pop();
}

function drawCaptureIconButton(x,y,w,h){
  push();
  rectMode(CORNER);
  stroke(200);
  strokeWeight(2);
  fill(35);
  rect(x,y,w,h,12);

  // camera icon
  const cx = x + w/2;
  const cy = y + h/2;

  noFill();
  stroke(230);
  strokeWeight(2);

  // body
  rectMode(CENTER);
  rect(cx, cy+2, 44, 28, 6);

  // lens
  circle(cx, cy+2, 14);

  // top bump
  rect(cx-14, cy-14, 14, 8, 3);

  pop();
}

// ---------- hit tests ----------
function hitRect(mx,my,x,y,w,h){
  return mx>=x && mx<=x+w && my>=y && my<=y+h;
}
function hitRectCenter(mx,my,cx,cy,w,h){
  return mx>=cx-w/2 && mx<=cx+w/2 && my>=cy-h/2 && my<=cy+h/2;
}
function pointInRectCenter(px,py,cx,cy,w,h){
  return px>=cx-w/2 && px<=cx+w/2 && py>=cy-h/2 && py<=cy+h/2;
}

function leftHandleHit(mx,my){
  const hp = getOverlayHandlePos();
  if(dist(mx,my,hp.x,hp.y) < 10) return "resize";
  return null;
}

function constrainOverlayToLeft(){
  const areaH = H - ui.barH;
  overlay.x = constrain(overlay.x, overlay.s*0.2, leftW - overlay.s*0.2);
  overlay.y = constrain(overlay.y, overlay.s*0.2, areaH - overlay.s*0.2);
}

// ---------- filters ----------
function applyFilterToGraphics(g, mode){
  if(mode==="NONE") return;
  if(mode==="INVERT") g.filter(INVERT);
  if(mode==="GRAY") g.filter(GRAY);
  if(mode==="POSTERIZE") g.filter(POSTERIZE, 3);
  if(mode==="THRESHOLD") g.filter(THRESHOLD, 0.5);
  if(mode==="BLUR") g.filter(BLUR, 3);
}

// ---------- shapes ----------
function drawShapeOutline(shapeName,cx,cy,s){
  if(shapeName==="circle") circle(cx,cy,s);
  else if(shapeName==="rect"){ rectMode(CENTER); rect(cx,cy,s,s,18); }
  else if(shapeName==="tri") triangle(cx, cy-s*0.55, cx-s*0.55, cy+s*0.55, cx+s*0.55, cy+s*0.55);
  else if(shapeName==="star") drawStar(this,cx,cy,s*0.22,s*0.55,5);
}

function pointInShape(shapeName, px, py, cx, cy, s){
  if(shapeName==="circle") return dist(px,py,cx,cy)<=s/2;
  if(shapeName==="rect") return abs(px-cx)<=s/2 && abs(py-cy)<=s/2;
  if(shapeName==="tri") return pointInTriangle(px,py,cx,cy,s);
  if(shapeName==="star") return dist(px,py,cx,cy)<=s/2; // approx
  return false;
}

function pointInTriangle(px, py, cx, cy, s){
  const x1=cx, y1=cy-s*0.55;
  const x2=cx-s*0.55, y2=cy+s*0.55;
  const x3=cx+s*0.55, y3=cy+s*0.55;
  const d1=triSign(px,py,x1,y1,x2,y2);
  const d2=triSign(px,py,x2,y2,x3,y3);
  const d3=triSign(px,py,x3,y3,x1,y1);
  const hasNeg=(d1<0)||(d2<0)||(d3<0);
  const hasPos=(d1>0)||(d2>0)||(d3>0);
  return !(hasNeg && hasPos);
}
function triSign(px,py,ax,ay,bx,by){
  return (px-bx)*(ay-by)-(ax-bx)*(py-by);
}

// clip paths
function addShapePathToContext(ctx, shapeName, cx, cy, s){
  if(shapeName==="circle"){
    ctx.arc(cx,cy,s/2,0,Math.PI*2);
    return;
  }
  if(shapeName==="rect"){
    const r=18; const x=cx-s/2, y=cy-s/2, w=s, h=s;
    roundRectPath(ctx,x,y,w,h,r);
    return;
  }
  if(shapeName==="tri"){
    ctx.moveTo(cx, cy-s*0.55);
    ctx.lineTo(cx-s*0.55, cy+s*0.55);
    ctx.lineTo(cx+s*0.55, cy+s*0.55);
    ctx.closePath();
    return;
  }
  if(shapeName==="star"){
    starPath(ctx,cx,cy,s*0.22,s*0.55,5);
    return;
  }
}

function roundRectPath(ctx,x,y,w,h,r){
  ctx.moveTo(x+r,y);
  ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function starPath(ctx,x,y,r1,r2,n){
  const step=Math.PI/n;
  let a=-Math.PI/2;
  ctx.moveTo(x+Math.cos(a)*r2,y+Math.sin(a)*r2);
  for(let i=0;i<n*2;i++){
    const r=(i%2===0)?r2:r1;
    ctx.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r);
    a+=step;
  }
  ctx.closePath();
}

function drawStar(pg,x,y,r1,r2,n){
  let angle=TWO_PI/n;
  let half=angle/2;
  pg.beginShape();
  for(let a=-HALF_PI;a<TWO_PI-HALF_PI+0.001;a+=angle){
    pg.vertex(x+cos(a)*r2,y+sin(a)*r2);
    pg.vertex(x+cos(a+half)*r1,y+sin(a+half)*r1);
  }
  pg.endShape(CLOSE);
}

async function loadSnapshotIfAny(){
  const { data, error } = await sb.from("room_state")
    .select("snapshot_url, snapshot_updated_at, top_image_url, top_sticker_id, top_user_id, top_payload")
    .eq("room", ROOM)
    .maybeSingle();

  if (error) {
    console.warn("room_state read error:", error);
    return;
  }
  if (!data) return;

  // load baked wall snapshot (cache-bust)
  if (data.snapshot_url) {
    const v = data.snapshot_updated_at ? Date.parse(data.snapshot_updated_at) : Date.now();
    const snapUrl = `${data.snapshot_url}?v=${v}`;
    const img = await loadImageAsync(snapUrl);

    wallBase.clear();
    wallBase.image(img, 0, 0, wallBase.width, wallBase.height);
  }

  // load current top sticker (cache-bust)
  if (data.top_image_url && data.top_payload) {
    const v2 = data.snapshot_updated_at ? Date.parse(data.snapshot_updated_at) : Date.now();
    const topUrl = `${data.top_image_url}?v=${v2}`;

    const img2 = await loadImageAsync(topUrl);
    const g = createGraphics(img2.width, img2.height);
    g.pixelDensity(1);
    g.clear();
    g.image(img2, 0, 0);

    currentTopStickerId = data.top_sticker_id;
    currentTopOwnerId = data.top_user_id;

    topSticker = {
      gfx: g,
      x: data.top_payload.x,
      y: data.top_payload.y,
      s: data.top_payload.s,
      dragging: false,
      resizing: false,
      dx: 0,
      dy: 0,
      editable: (data.top_user_id === USER_ID)
    };
  }
}

async function sendCaptureEvent(stickerId, imageUrl, x, y, s) {
  const payload = { imageUrl, x, y, s };
  const { data, error } = await sb.from("wall_events").insert([{
    room: ROOM,
    type: "capture",
    sticker_id: stickerId,
    user_id: USER_ID,
    payload
  }]).select();

  if (error) {
    console.error("wall_events insert error:", error);
    throw error;
  }
  return data;
}

async function sendTransformEvent(stickerId, x, y, s) {
  const now = performance.now();
  if (now - lastSendTs < 80) return; // ~12fps
  lastSendTs = now;

  const payload = { x, y, s };
  await sb.from("wall_events").insert([{
    room: ROOM,
    type: "transform",
    sticker_id: stickerId,
    user_id: USER_ID,
    payload
  }]);
  if (error) console.warn("transform insert error:", error);
}

function subscribeWall() {
  sb.channel(`wall-${ROOM}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "wall_events",
      filter: `room=eq.${ROOM}`
    }, async (p) => {
      const row = p.new;
      if (row.type === "capture") {
        await onRemoteCapture(row);
      } else if (row.type === "transform") {
        onRemoteTransform(row);
      }
    })
    .subscribe();
}

function loadImageAsync(url) {
  return new Promise((resolve, reject) => {
    loadImage(url, resolve, reject);
  });
}

async function onRemoteCapture(row) {
  if (topSticker) {
    await refreshWallBaseFromServer();  
    bakeTopStickerToWall();             
    await uploadWallSnapshot();         
  }

  await sb.from("room_state").upsert([{
    room: ROOM,
    top_image_url: row.payload.imageUrl,
    top_sticker_id: row.sticker_id,
    top_user_id: row.user_id,
    top_payload: { x: row.payload.x, y: row.payload.y, s: row.payload.s },
  }]);
  
  currentTopStickerId = row.sticker_id;
  currentTopOwnerId = row.user_id;

  const img = await loadImageAsync(`${row.payload.imageUrl}?v=${Date.now()}`);
  const g = createGraphics(img.width, img.height);
  g.pixelDensity(1);
  g.clear();
  g.image(img, 0, 0);

  topSticker = {
    gfx: g,
    x: row.payload.x,
    y: row.payload.y,
    s: row.payload.s,
    dragging: false,
    resizing: false,
    dx: 0,
    dy: 0,
    editable: (row.user_id === USER_ID)
  };
}

function onRemoteTransform(row) {
  if (!currentTopStickerId || row.sticker_id !== currentTopStickerId) return;
  if (!topSticker) return;

  topSticker.x = row.payload.x;
  topSticker.y = row.payload.y;
  topSticker.s = row.payload.s;
}

async function uploadWallSnapshot() {
  const blob = await new Promise(res => wallBase.elt.toBlob(res, "image/webp", 0.75));
  const path = `${ROOM}/full_wall.webp`;

  const { error: upErr } = await sb.storage.from("stickers").upload(path, blob, {
    upsert: true,
    contentType: "image/webp"
  });
  if (upErr) throw upErr;

  const { data } = sb.storage.from("stickers").getPublicUrl(path);
  const url = data.publicUrl;

  const { error: dbErr } = await sb.from("room_state").upsert([{
    room: ROOM,
    snapshot_url: url,
    snapshot_updated_at: new Date().toISOString()
  }]);
  if (dbErr) throw dbErr;

  return url;
}

async function refreshWallBaseFromServer() {
  const { data, error } = await sb.from("room_state")
    .select("snapshot_url, snapshot_updated_at")
    .eq("room", ROOM)
    .maybeSingle();

  if (error) {
    console.warn("refreshWallBaseFromServer error:", error);
    return;
  }
  if (!data || !data.snapshot_url) return;

  const v = data.snapshot_updated_at ? Date.parse(data.snapshot_updated_at) : Date.now();
  const snapUrl = `${data.snapshot_url}?v=${v}`;

  const img = await loadImageAsync(snapUrl);
  wallBase.clear();
  wallBase.image(img, 0, 0, wallBase.width, wallBase.height);
}

async function uploadStickerGraphic(gfx, stickerId) {
  // gfx is p5.Graphics
  const blob = await new Promise(res => gfx.elt.toBlob(res, "image/webp", 0.85));
  const path = `${ROOM}/${stickerId}.webp`;

  const { error: upErr } = await sb.storage.from("stickers").upload(path, blob, {
    upsert: true,
    contentType: "image/webp"
  });
  if (upErr) throw upErr;

  const { data } = sb.storage.from("stickers").getPublicUrl(path);
  return data.publicUrl;

}

const cfg = window.APP_CONFIG || {};
const sb = window.supabase?.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

const video = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const diag = document.getElementById('diagnostic');
const result = document.getElementById('result');

let stream = null;
let businesses = [];
let targets = [];
let timer = null;
let scanning = false;
let lastMatch = null;
let candidateMatch = null;
let candidateHits = 0;
let missHits = 0;
let cvReadyPromise = null;

function configured() {
  return !!sb && !!cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('TU-PROYECTO') &&
    !!cfg.SUPABASE_PUBLISHABLE_KEY && !cfg.SUPABASE_PUBLISHABLE_KEY.includes('TU_PUBLISHABLE');
}

function waitForOpenCV() {
  if (window.cv && cv.Mat && cv.ORB) return Promise.resolve();
  if (cvReadyPromise) return cvReadyPromise;
  cvReadyPromise = new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.cv && cv.Mat && cv.ORB) return resolve();
      if (Date.now() - started > 20000) return reject(new Error('OpenCV no ha terminado de cargar. Recarga la página e inténtalo de nuevo.'));
      setTimeout(tick, 100);
    };
    tick();
  });
  return cvReadyPromise;
}

function createORB(nfeatures = 1000) {
  if (!window.cv || !cv.ORB) throw new Error('OpenCV ORB no está disponible. Comprueba que OpenCV.js haya cargado correctamente.');
  // OpenCV.js expone ORB como constructor en los builds actuales.
  try { return new cv.ORB(nfeatures); } catch (e) {
    // Compatibilidad con builds que expongan una función global ORB_create.
    if (typeof cv.ORB_create === 'function') return cv.ORB_create(nfeatures);
    throw e;
  }
}

function setDiag(msg) { diag.textContent = msg; }

async function loadImage(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  const loaded = new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la imagen objetivo: ' + url));
  });
  img.src = url;
  return loaded;
}

function imageMat(img, max = 1000) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
  return cv.imread(canvas);
}

function prepareTarget(b, img, orb) {
  const mat = imageMat(img);
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), keypoints, descriptors);
  const target = {
    b,
    img,
    width: mat.cols,
    height: mat.rows,
    keypoints,
    descriptors,
    featureCount: keypoints.size()
  };
  mat.delete(); gray.delete();
  return target;
}

async function loadBusinesses() {
  if (!configured()) throw new Error('Configura config.js con la URL y Publishable Key de Supabase.');
  setDiag('Conectando con Supabase…');
  const { data, error } = await sb.from('businesses').select('*').eq('active', true).order('name');
  if (error) throw new Error('Supabase: ' + error.message);
  businesses = data || [];
  if (!businesses.length) {
    targets = [];
    return;
  }

  await waitForOpenCV();
  const orb = createORB(1200);
  targets.forEach(t => { t.keypoints?.delete(); t.descriptors?.delete(); });
  targets = [];

  let loaded = 0;
  for (const b of businesses) {
    if (!b.target_path) continue;
    const { data: publicData } = sb.storage.from('targets').getPublicUrl(b.target_path);
    const url = publicData?.publicUrl;
    if (!url) continue;
    try {
      const img = await loadImage(url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(b.updated_at || Date.now()));
      const target = prepareTarget(b, img, orb);
      if (target.featureCount >= 12 && !target.descriptors.empty()) {
        targets.push(target);
        loaded++;
      }
    } catch (e) {
      console.warn('Objetivo no cargado', b.name, e);
    }
  }
  orb.delete();
  return { total: businesses.length, loaded };
}

async function start() {
  if (stream) return;
  startBtn.disabled = true;
  try {
    setDiag('Preparando motor de reconocimiento…');
    const info = await loadBusinesses();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite cámara. Usa HTTPS o localhost.');
    setDiag(`Supabase OK · ${info?.total ?? businesses.length} negocio(s) · ${info?.loaded ?? targets.length} imagen(es) preparadas.`);

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    stopBtn.disabled = false;
    statusEl.textContent = targets.length ? 'Enfoca una imagen registrada…' : 'No hay imágenes de reconocimiento disponibles.';
    setDiag(`Cámara OK · ${targets.length} objetivo(s) listo(s).`);
    timer = setInterval(scan, 700);
  } catch (e) {
    startBtn.disabled = false;
    setDiag('Error: ' + (e?.message || e));
    console.error(e);
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  scanning = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = 'Pulsa “Activar cámara”';
  lastMatch = null;
  candidateMatch = null;
  candidateHits = 0;
  missHits = 0;
  result.classList.add('hidden');
}

function sceneFromVideo() {
  if (!video.videoWidth || !video.videoHeight) return null;
  const maxW = 640;
  const w = Math.min(maxW, video.videoWidth);
  const h = Math.round(w * video.videoHeight / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);
  const rgba = cv.imread(c);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

function verifyGeometry(target, scene, goodMatches) {
  if (goodMatches.length < 8) return 0;
  const src = cv.matFromArray(goodMatches.length, 1, cv.CV_32FC2, goodMatches.flatMap(m => {
    const p = target.keypoints.get(m.queryIdx).pt;
    return [p.x, p.y];
  }));
  const dst = cv.matFromArray(goodMatches.length, 1, cv.CV_32FC2, goodMatches.flatMap(m => {
    const p = scene._keypoints.get(m.trainIdx).pt;
    return [p.x, p.y];
  }));
  const mask = new cv.Mat();
  let inliers = 0;
  try {
    cv.findHomography(src, dst, cv.RANSAC, 5, mask, 2000, 0.995);
    for (let i = 0; i < mask.rows; i++) if (mask.ucharAt(i, 0)) inliers++;
  } catch (e) {
    console.warn('Homography', e);
  }
  src.delete(); dst.delete(); mask.delete();
  return inliers;
}

function scan() {
  if (scanning || !stream || video.readyState < 2 || !targets.length || !window.cv) return;
  scanning = true;
  let scene = null, kp2 = null, des2 = null, orb = null;
  try {
    scene = sceneFromVideo();
    if (!scene) return;
    orb = createORB(1000);
    kp2 = new cv.KeyPointVector();
    des2 = new cv.Mat();
    orb.detectAndCompute(scene, new cv.Mat(), kp2, des2);
    if (des2.empty() || kp2.size() < 10) {
      statusEl.textContent = 'Buscando imagen…';
      return;
    }

    // Attach scene keypoints temporarily for geometric verification.
    scene._keypoints = kp2;
    let best = null;
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);

    for (const target of targets) {
      const matches = new cv.DMatchVectorVector();
      try {
        bf.knnMatch(target.descriptors, des2, matches, 2);
        const good = [];
        for (let i = 0; i < matches.size(); i++) {
          const pair = matches.get(i);
          if (pair.size() >= 2) {
            const m1 = pair.get(0), m2 = pair.get(1);
            if (m1.distance < 0.72 * m2.distance && m1.distance < 75) good.push(m1);
          }
        }
        let inliers = 0;
        if (good.length >= 8) inliers = verifyGeometry(target, scene, good);
        const score = inliers * 3 + good.length;
        if (!best || score > best.score) best = { b: target.b, good: good.length, inliers, score };
      } finally {
        matches.delete();
      }
    }

    // No mostramos la ficha ante una sola coincidencia. Exigimos que el mismo
    // objetivo sea detectado de forma consistente en varias capturas consecutivas.
    const strong = best && best.inliers >= 10 && best.good >= 14;
    if (strong) {
      missHits = 0;
      if (candidateMatch === best.b.id) candidateHits++;
      else {
        candidateMatch = best.b.id;
        candidateHits = 1;
      }

      if (candidateHits >= 3) {
        if (lastMatch !== best.b.id) {
          lastMatch = best.b.id;
          showBusiness(best.b);
        }
        statusEl.textContent = `Imagen reconocida · ${best.b.name}`;
        setDiag(`Reconocimiento confirmado · ${best.good} coincidencias · ${best.inliers} geométricas`);
      } else {
        statusEl.textContent = 'Verificando imagen…';
        setDiag(`Verificando… ${candidateHits}/3 capturas válidas`);
      }
    } else {
      candidateMatch = null;
      candidateHits = 0;
      missHits++;
      statusEl.textContent = 'Buscando imagen…';
      if (missHits >= 2 && lastMatch !== null) {
        lastMatch = null;
        result.classList.add('hidden');
      }
      if (best) setDiag(`Buscando… mejor resultado descartado (${best.good} coincidencias / ${best.inliers} geométricas)`);
    }
  } catch (e) {
    console.warn('scan', e);
    setDiag('Error durante reconocimiento: ' + (e?.message || e));
  } finally {
    if (scene) { delete scene._keypoints; scene.delete(); }
    if (kp2) kp2.delete();
    if (des2) des2.delete();
    if (orb) orb.delete();
    scanning = false;
  }
}

async function showBusiness(b) {
  result.classList.remove('hidden');
  result.innerHTML = `<h2>${esc(b.name)}</h2><div class="small">${esc(b.category || '')}</div><p>${esc(b.description || '')}</p>${b.offer ? `<p><strong>${esc(b.offer)}</strong></p>` : ''}<div>${b.phone ? `<a href="tel:${escAttr(b.phone)}">☎ Teléfono</a>` : ''}${b.whatsapp ? `<a href="https://wa.me/${escAttr(b.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${b.website ? `<a href="${safeUrl(b.website)}" target="_blank" rel="noopener">Web</a>` : ''}${b.instagram ? `<a href="${safeUrl(b.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ''}${b.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}" target="_blank" rel="noopener">Cómo llegar</a>` : ''}</div>${b.sponsor_name ? `<hr><div class="small">Patrocinado por ${esc(b.sponsor_name)}</div>` : ''}<div id="mediaPublic" class="public-media"><p class="small">Cargando contenido…</p></div>`;
  const {data,error}=await sb.from('business_media').select('*').eq('business_id',b.id).eq('active',true).order('sort_order').order('created_at');
  if(error || !data?.length){const el=document.getElementById('mediaPublic');if(el)el.innerHTML='';return}
  const el=document.getElementById('mediaPublic');if(!el)return;
  const images=data.filter(x=>x.media_type==='image');const audios=data.filter(x=>x.media_type==='audio');const videos=data.filter(x=>x.media_type==='video');
  const mediaUrl=m=>sb.storage.from(m.media_type==='image'?'media-images':m.media_type==='audio'?'media-audio':'media-video').getPublicUrl(m.storage_path).data.publicUrl;
  let html='';
  if(images.length) html+=`<section><h3>Galería</h3><div class="public-gallery">${images.map(m=>`<figure><img src="${escAttr(mediaUrl(m))}" alt="${escAttr(m.title||b.name)}"><figcaption>${esc(m.title||'')}</figcaption></figure>`).join('')}</div></section>`;
  if(videos.length) html+=`<section><h3>Vídeos</h3><div class="public-videos">${videos.map(m=>`<article><video controls playsinline preload="metadata" src="${escAttr(mediaUrl(m))}"></video><strong>${esc(m.title||'')}</strong>${m.description?`<p>${esc(m.description)}</p>`:''}</article>`).join('')}</div></section>`;
  if(audios.length) html+=`<section><h3>Audios</h3><div class="public-audios">${audios.map(m=>`<article><strong>${esc(m.title||'Audio')}</strong>${m.description?`<p>${esc(m.description)}</p>`:''}<audio controls preload="metadata" src="${escAttr(mediaUrl(m))}"></audio></article>`).join('')}</div></section>`;
  el.innerHTML=html;
}

function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[m])); }
function escAttr(s) { return esc(s); }
function safeUrl(s) { const x = String(s || ''); return /^https?:\/\//i.test(x) ? x : '#'; }

startBtn?.addEventListener('click', start);
stopBtn?.addEventListener('click', stop);
window.addEventListener('beforeunload', stop);

(() => {
  const canvas = document.getElementById('torus-canvas');
  if (!canvas) return;

  // Cheap, one-time device-tier heuristic: few CPU cores or a coarse
  // (touch) pointer usually means a weaker GPU too. Everything below that
  // reads LOW_POWER trims fill-rate/ALU cost (the blur + grain passes are
  // far more expensive than the torus geometry itself, since they touch
  // every pixel of the canvas rather than just the ~60% the torus covers).
  const LOW_POWER = (navigator.hardwareConcurrency || 4) <= 4
    || window.matchMedia('(pointer: coarse)').matches;

  // touch/coarse-pointer devices are treated as "mobile" -- grain is
  // dropped entirely on these regardless of core count
  const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

  const gl = canvas.getContext('webgl', { antialias: !LOW_POWER, alpha: false })
    || canvas.getContext('experimental-webgl', { antialias: !LOW_POWER, alpha: false });
  if (!gl) return;

  const BG_COLOR = [0.1725, 0.2941, 0.9490]; // #2c4bf2, matches --bg-blue
  const BLUR_SPREAD = 6.0; // texel multiplier per blur pass
  const GRAIN_AMOUNT = 0.145;
  const GRAIN_SCALE = 2.2; // texels per grain cell -- higher = chunkier/larger grain

  // ---------- scene shaders (torus) ----------

  const SCENE_VERT_SRC = `
    attribute vec3 aPosition;

    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;

    varying vec3 vObjPos;

    void main() {
      vObjPos = aPosition;
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      gl_Position = uProjection * uView * worldPos;
    }
  `;

  // Simplex noise core: Ian McEwan / Ashima Arts (MIT License)
  const SCENE_FRAG_SRC = `
    precision mediump float;

    varying vec3 vObjPos;

    uniform float uTime;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);

      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);

      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;

      i = mod289(i);
      vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));

      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;

      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);

      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);

      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);

      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));

      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);

      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;

      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }

    void main() {
      // spatial frequency of the noise field -- higher = smaller/busier
      // blobs, lower = bigger/calmer blobs
      vec3 p = vObjPos * 1.05;

      // primary noise field: shapes the overall blob layout.
      // uTime * 0.16 is its animation speed (the lava-lamp drift) --
      // lower this to make blobs (including pink peaks) morph more slowly
      // and linger longer, raise it to speed the whole texture up
      float n1 = snoise(p + vec3(0.0, 0.0, uTime * 0.16));

      // secondary noise field: adds finer detail on top of n1.
      // its own frequency (1.3) and speed (-0.128) can differ from n1's
      float n2 = snoise(p * 1.3 + vec3(5.2, 1.3, -uTime * 0.128));

      // blend weight between the two fields -- raise n2's share (currently
      // 0.15) for a busier/noisier look, lower it for a smoother/more
      // uniform one
      float n = n1 * 0.85 + n2 * 0.15;

      // remap noise from -1..1 to 0..1 so it can drive the color ramp below
      float t = clamp(n * 0.5 + 0.5, 0.0, 1.0);

      // the three stops of the color ramp: resting color, the brighter
      // highlight just before a peak, and the peak color itself
      vec3 cyanBase = vec3(0.22, 0.75, 0.86);
      vec3 cyanBright = vec3(0.72, 0.97, 1.0);
      vec3 pink = vec3(0.95, 0.35, 0.82);

      // cyanBase -> cyanBright transition. smoothstep(start, end, t):
      // this band sits right up against the pink threshold below (0.68) so
      // the bright highlight only shows leading into a peak, not spread
      // across most of the surface. widening the gap (currently 0.40-0.68)
      // makes that falloff bigger/softer; narrowing it makes it a sharper edge
      vec3 color = mix(cyanBase, cyanBright, smoothstep(0.40, 0.68, t));

      // cyanBright -> pink transition (the peaks). raising "start" makes
      // peaks rarer (only the highest noise values reach pink); widening
      // the gap between start/end makes each peak bloom out softer/bigger
      color = mix(color, pink, smoothstep(0.68, 0.93, t));

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  // ---------- post-process shaders (separable blur + grain) ----------

  const POST_VERT_SRC = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // Shared preamble (uniforms + hash/noise helpers) for both quality tiers.
  const POST_FRAG_PREAMBLE = `
    precision highp float;

    varying vec2 vUv;

    uniform sampler2D uScene;
    uniform vec2 uTexel;
    uniform vec2 uDirection;
    uniform float uSpread;
    uniform float uGrainAmount;
    uniform float uGrainScale;
    uniform float uTime;

    // multiplication-based hash (no sin/trig) -- avoids the precision-loss
    // banding/moire that sin()-based hashes produce once their input grows
    // large (e.g. from an ever-increasing time uniform)
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // smooth (interpolated) value noise -- gives soft grain "clumps"
    // instead of isolated single-pixel static
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
  `;

  // Full quality: 9-tap blur, rotated + dual-octave grain (avoids moire,
  // richer detail). This is the more expensive of the two variants since
  // it runs across the entire canvas resolution, twice per frame (once per
  // blur direction).
  const POST_FRAG_SRC_HIGH = POST_FRAG_PREAMBLE + `
    vec2 rotate(vec2 p, float a) {
      float s = sin(a);
      float c = cos(a);
      return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    }

    void main() {
      float w0 = 0.2270270270;
      float w1 = 0.1945945946;
      float w2 = 0.1216216216;
      float w3 = 0.0540540541;
      float w4 = 0.0162162162;

      vec2 step = uTexel * uDirection * uSpread;
      vec3 color = texture2D(uScene, vUv).rgb * w0;
      color += texture2D(uScene, vUv + step * 1.0).rgb * w1;
      color += texture2D(uScene, vUv - step * 1.0).rgb * w1;
      color += texture2D(uScene, vUv + step * 2.0).rgb * w2;
      color += texture2D(uScene, vUv - step * 2.0).rgb * w2;
      color += texture2D(uScene, vUv + step * 3.0).rgb * w3;
      color += texture2D(uScene, vUv - step * 3.0).rgb * w3;
      color += texture2D(uScene, vUv + step * 4.0).rgb * w4;
      color += texture2D(uScene, vUv - step * 4.0).rgb * w4;

      // large pseudo-random jump per frame re-randomizes the grain pattern
      // (like a new film frame) instead of visibly sliding/panning it.
      // uTime is wrapped so it stays numerically well-behaved over long sessions
      float t = mod(uTime, 1000.0);
      vec2 timeJump = vec2(hash(vec2(t, 1.0)), hash(vec2(3.0, t))) * 500.0;

      // rotated + blended with a second offset octave so the underlying
      // lattice never lines up with the screen's pixel grid (avoids moire)
      vec2 gp = rotate(gl_FragCoord.xy, 0.4636) / uGrainScale + timeJump;
      float g1 = valueNoise(gp);
      float g2 = valueNoise(gp * 1.7 + 11.3);
      float grain = mix(g1, g2, 0.5) - 0.5;

      // grain reads strongest in midtones and fades near black/white,
      // matching how photographic grain actually behaves
      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      float midtoneFalloff = clamp(1.0 - abs(luma - 0.5) * 1.6, 0.0, 1.0);

      color += grain * uGrainAmount * midtoneFalloff * 2.2;

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  // Low power: 5-tap blur (10 total texture reads/frame instead of 18) and
  // a single, unrotated noise octave for grain (skips 4 extra hash() calls
  // and the sin/cos rotation per pixel). Visually close to the high-quality
  // version at typical GRAIN_AMOUNT/BLUR_SPREAD values, at roughly half the
  // per-pixel cost -- the right trade on weaker GPUs since these two passes
  // touch every pixel of the canvas, unlike the torus draw itself.
  const POST_FRAG_SRC_LOW = POST_FRAG_PREAMBLE + `
    void main() {
      float w0 = 0.375;
      float w1 = 0.25;
      float w2 = 0.0625;

      vec2 step = uTexel * uDirection * uSpread;
      vec3 color = texture2D(uScene, vUv).rgb * w0;
      color += texture2D(uScene, vUv + step * 1.0).rgb * w1;
      color += texture2D(uScene, vUv - step * 1.0).rgb * w1;
      color += texture2D(uScene, vUv + step * 2.0).rgb * w2;
      color += texture2D(uScene, vUv - step * 2.0).rgb * w2;

      float t = mod(uTime, 1000.0);
      vec2 timeJump = vec2(hash(vec2(t, 1.0)), hash(vec2(3.0, t))) * 500.0;
      float grain = valueNoise(gl_FragCoord.xy / uGrainScale + timeJump) - 0.5;

      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      float midtoneFalloff = clamp(1.0 - abs(luma - 0.5) * 1.6, 0.0, 1.0);

      color += grain * uGrainAmount * midtoneFalloff * 2.2;

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  // phones always get the full 9-tap blur (better quality) even when
  // LOW_POWER is true from the coarse-pointer check -- only non-touch
  // low-core-count devices (e.g. an old laptop) fall back to the cheap
  // 5-tap version
  const POST_FRAG_SRC = (LOW_POWER && !IS_MOBILE) ? POST_FRAG_SRC_LOW : POST_FRAG_SRC_HIGH;

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(vertSrc, fragSrc) {
    const vertShader = compileShader(gl.VERTEX_SHADER, vertSrc);
    const fragShader = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vertShader || !fragShader) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vertShader);
    gl.attachShader(prog, fragShader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  const sceneProgram = createProgram(SCENE_VERT_SRC, SCENE_FRAG_SRC);
  const postProgram = createProgram(POST_VERT_SRC, POST_FRAG_SRC);
  if (!sceneProgram || !postProgram) return;

  // ---------- torus geometry ----------

  function createTorus(R, r, segsU, segsV) {
    const positions = [];
    const indices = [];

    for (let i = 0; i <= segsU; i++) {
      const u = (i / segsU) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (let j = 0; j <= segsV; j++) {
        const v = (j / segsV) * Math.PI * 2;
        const cv = Math.cos(v), sv = Math.sin(v);
        positions.push((R + r * cv) * cu, (R + r * cv) * su, r * sv);
      }
    }

    const rowLen = segsV + 1;
    for (let i = 0; i < segsU; i++) {
      for (let j = 0; j < segsV; j++) {
        const a = i * rowLen + j;
        const b = a + rowLen;
        const c = a + 1;
        const d = b + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    return {
      positions: new Float32Array(positions),
      indices: new Uint16Array(indices),
    };
  }

  const geo = LOW_POWER ? createTorus(0.68, 0.24, 40, 20) : createTorus(0.68, 0.24, 64, 32);

  const posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geo.positions, gl.STATIC_DRAW);

  const idxBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.indices, gl.STATIC_DRAW);

  const aPosition = gl.getAttribLocation(sceneProgram, 'aPosition');

  const uModel = gl.getUniformLocation(sceneProgram, 'uModel');
  const uView = gl.getUniformLocation(sceneProgram, 'uView');
  const uProjection = gl.getUniformLocation(sceneProgram, 'uProjection');
  const uSceneTime = gl.getUniformLocation(sceneProgram, 'uTime');

  // ---------- fullscreen quad ----------

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(postProgram, 'aPos');
  const uScene = gl.getUniformLocation(postProgram, 'uScene');
  const uTexel = gl.getUniformLocation(postProgram, 'uTexel');
  const uDirection = gl.getUniformLocation(postProgram, 'uDirection');
  const uSpread = gl.getUniformLocation(postProgram, 'uSpread');
  const uGrainAmount = gl.getUniformLocation(postProgram, 'uGrainAmount');
  const uGrainScale = gl.getUniformLocation(postProgram, 'uGrainScale');
  const uPostTime = gl.getUniformLocation(postProgram, 'uTime');

  // ---------- offscreen framebuffers (scene render + blur ping-pong) ----------

  function createFBO(width, height, withDepth) {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let depthBuffer = null;
    if (withDepth) {
      depthBuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture, depthBuffer, width, height };
  }

  function destroyFBO(fbo) {
    if (!fbo) return;
    gl.deleteFramebuffer(fbo.framebuffer);
    gl.deleteTexture(fbo.texture);
    if (fbo.depthBuffer) gl.deleteRenderbuffer(fbo.depthBuffer);
  }

  let fboScene = null;
  let fboBlur = null;

  // ---------- matrices (no dependency, minimal helpers) ----------

  function perspective(fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, (2 * far * near) * nf, 0,
    ]);
  }

  function lookAt(eye, center, up) {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let len = Math.hypot(z0, z1, z2);
    z0 /= len; z1 /= len; z2 /= len;

    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len) { x0 /= len; x1 /= len; x2 /= len; }

    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;

    return new Float32Array([
      x0, y0, z0, 0,
      x1, y1, z1, 0,
      x2, y2, z2, 0,
      -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
      -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
      -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
      1,
    ]);
  }

  const EYE = [0, 0, 3];
  const viewMatrix = lookAt(EYE, [0, 0, 0], [0, 1, 0]);
  const modelMatrix = new Float32Array(16);

  // ---------- reduced motion ----------

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedMotionQuery.matches;
  reducedMotionQuery.addEventListener('change', (e) => {
    reducedMotion = e.matches;
  });

  // ---------- cursor parallax: pendulum around a fixed pivot ----------

  // the pivot sits ORBIT_RADIUS world units behind the torus's resting spot
  // (further from the camera, since the camera looks from +Z toward the
  // origin). the torus is "parented" to it at a fixed local offset of the
  // same length, so it always stays exactly ORBIT_RADIUS away from the
  // pivot -- rotating the pivot swings the torus along that fixed-radius
  // arc (and spins the torus itself along with it) instead of translating it
  const ORBIT_RADIUS = IS_MOBILE ? 0.1 : 0.1;
  const PIVOT = [0, 0, -ORBIT_RADIUS];

  const MAX_YAW = IS_MOBILE ? 0.9 : 0.9; // radians, left/right swing limit (cursor X)
  const MAX_PITCH = 0.3; // radians, up/down swing limit (cursor Y)
  const SPRING_STIFFNESS = 0.002; // how strongly it's pulled toward the cursor
  const SPRING_DAMPING = 0.9; // higher = less friction = more momentum/float
  let targetYaw = 0, targetPitch = 0, curYaw = 0, curPitch = 0, velYaw = 0, velPitch = 0;

  function setTargetFromPoint(clientX, clientY) {
    const nx = (clientX / window.innerWidth) - 0.5;
    const ny = (clientY / window.innerHeight) - 0.5;
    targetYaw = nx * MAX_YAW * 2;
    targetPitch = ny * MAX_PITCH * 2;
  }

  function onPointerMove(e) {
    if (reducedMotion) return;
    setTargetFromPoint(e.clientX, e.clientY);
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  // touch devices don't hover, so pointermove alone never fires from a tap --
  // pointerdown covers the tap-to-move interaction on mobile (harmless/
  // redundant alongside pointermove on desktop, since a mouse click also
  // fires pointerdown at the same position pointermove already tracked)
  function onPointerDown(e) {
    if (reducedMotion) return;
    setTargetFromPoint(e.clientX, e.clientY);
  }
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  // ---------- resize ----------

  const BASE_SCALE = 0.62;
  let objectScale = BASE_SCALE;

  function resize() {
    // capping the backing-store resolution is the single biggest lever here:
    // the blur/grain passes cost scales directly with total pixel count.
    // phones keep full DPR (like the blur shader tier above) -- capping to 1
    // on a high-density phone screen means the canvas gets upscaled after
    // rendering, which reads as blocky/soft regardless of blur quality
    const dpr = Math.min(window.devicePixelRatio || 1, (LOW_POWER && !IS_MOBILE) ? 1 : 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    objectScale = BASE_SCALE * (rect.width < 700 ? 0.6 : 1);

    destroyFBO(fboScene);
    destroyFBO(fboBlur);
    fboScene = createFBO(canvas.width, canvas.height, true);
    fboBlur = createFBO(canvas.width, canvas.height, false);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // ---------- render loop ----------

  const startTime = performance.now();
  let rafId = null;

  function render() {
    velYaw = (velYaw + (targetYaw - curYaw) * SPRING_STIFFNESS) * SPRING_DAMPING;
    velPitch = (velPitch + (targetPitch - curPitch) * SPRING_STIFFNESS) * SPRING_DAMPING;
    curYaw += velYaw;
    curPitch += velPitch;

    // rotate the pivot by (curYaw, curPitch) and place the torus at the
    // fixed-radius local offset (0, 0, ORBIT_RADIUS) that rotation carries
    // it to -- both the swing position and the torus's own tilt come from
    // the same rotation, since it's rigidly parented to the pivot
    const cy = Math.cos(curYaw), sy = Math.sin(curYaw);
    const cx = Math.cos(curPitch), sx = Math.sin(curPitch);

    // combined rotation R = RotationY(yaw) * RotationX(pitch), as columns
    const col0 = [cy, 0, -sy];
    const col1 = [sy * sx, cx, cy * sx];
    const col2 = [sy * cx, -sx, cy * cx];

    modelMatrix.fill(0);
    modelMatrix[0] = col0[0] * objectScale; modelMatrix[1] = col0[1] * objectScale; modelMatrix[2] = col0[2] * objectScale;
    modelMatrix[4] = col1[0] * objectScale; modelMatrix[5] = col1[1] * objectScale; modelMatrix[6] = col1[2] * objectScale;
    modelMatrix[8] = col2[0] * objectScale; modelMatrix[9] = col2[1] * objectScale; modelMatrix[10] = col2[2] * objectScale;
    modelMatrix[15] = 1;

    // world position = pivot + R * (0, 0, ORBIT_RADIUS) = pivot + col2 * ORBIT_RADIUS
    modelMatrix[12] = PIVOT[0] + col2[0] * ORBIT_RADIUS;
    modelMatrix[13] = PIVOT[1] + col2[1] * ORBIT_RADIUS;
    modelMatrix[14] = PIVOT[2] + col2[2] * ORBIT_RADIUS;

    const aspect = canvas.width / canvas.height;
    const projMatrix = perspective(Math.PI / 5.5, aspect, 0.1, 10);
    const elapsed = reducedMotion ? 0 : (performance.now() - startTime) / 1000;

    // pass 1: render torus scene into an offscreen texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene.framebuffer);
    gl.viewport(0, 0, fboScene.width, fboScene.height);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(sceneProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);

    gl.clearColor(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.uniformMatrix4fv(uModel, false, modelMatrix);
    gl.uniformMatrix4fv(uView, false, viewMatrix);
    gl.uniformMatrix4fv(uProjection, false, projMatrix);
    gl.uniform1f(uSceneTime, elapsed);

    gl.drawElements(gl.TRIANGLES, geo.indices.length, gl.UNSIGNED_SHORT, 0);

    // pass 2 + 3: separable blur (horizontal then vertical), grain added on the final pass
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(postProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(uScene, 0);
    gl.uniform1f(uSpread, BLUR_SPREAD);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlur.framebuffer);
    gl.viewport(0, 0, fboBlur.width, fboBlur.height);
    gl.bindTexture(gl.TEXTURE_2D, fboScene.texture);
    gl.uniform2f(uTexel, 1 / fboScene.width, 1 / fboScene.height);
    gl.uniform2f(uDirection, 1, 0);
    gl.uniform1f(uGrainAmount, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, fboBlur.texture);
    gl.uniform2f(uDirection, 0, 1);
    gl.uniform1f(uGrainAmount, IS_MOBILE ? 0 : GRAIN_AMOUNT);
    gl.uniform1f(uGrainScale, GRAIN_SCALE);
    gl.uniform1f(uPostTime, elapsed);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    rafId = requestAnimationFrame(render);
  }

  function start() {
    if (rafId === null) rafId = requestAnimationFrame(render);
  }
  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  start();
})();

import * as THREE from 'three';

/* ───────────────── CONFIG ───────────────── */
const LOGO_PARTICLES = 5000;
const TEXT_PARTICLES = 1200;
const BALL_RADIUS = 0.25;

/* ──────── PHASE TIMING (seconds) ──────── */
const FALL_DUR = 1.5;
const EXPLODE_DUR = 0.9;
const FORM_DUR = 2.5;
const LOADING_DUR = 3.0;
const HOLD_DUR = 1.0;
const SCATTER_DUR = 1.2;

const HOLD_START = FALL_DUR + EXPLODE_DUR + FORM_DUR;
const SCATTER_START = HOLD_START + HOLD_DUR;
const SCATTER_END = SCATTER_START + SCATTER_DUR;

/* ───────────── EASING HELPERS ─────────── */
const easeInQuad = t => t * t;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeInCubic = t => t * t * t;

/* ──────────── SVG PIXEL SAMPLING ──────── */
async function loadSVGData(svgPath) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = svgPath;
    });
    const scale = Math.min(512 / img.width, 512 / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const cvs = document.createElement('canvas');
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function sampleRegion(imgData, w, h, count, yStart, yEnd, forceWhite) {
    const candidates = [];
    const y0 = Math.round(yStart * h);
    const y1 = Math.round(yEnd * h);
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2], a = imgData[i + 3];
            if (a > 128 && (r + g + b) > 30) {
                candidates.push({ x, y, r, g, b });
            }
        }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const aspect = w / h;
    const scaleW = 6;
    return candidates.slice(0, count).map(p => ({
        x: (p.x / w - 0.5) * scaleW * aspect,
        y: -(p.y / h - 0.5) * scaleW,
        r: forceWhite ? 1 : p.r / 255,
        g: forceWhite ? 1 : p.g / 255,
        b: forceWhite ? 1 : p.b / 255,
    }));
}

/* ───────────── SHADERS ───────────── */
const vertexShader = `
    attribute float size;
    varying vec3 vColor;
    uniform float uPixelRatio;
    void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
    }
`;

const fragmentShader = `
    varying vec3 vColor;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, smoothstep(0.5, 0.35, d));
    }
`;

/* ───────────────── MAIN ────────────────── */
/**
 * Initialises the logo intro animation.
 * @param {Object} options
 * @param {string} options.svgPath        – path/URL to the SVG logo
 * @param {string} options.overlayId      – id of the overlay container div
 * @param {string} options.loadingId      – id of the "Loading…" div
 * @param {string} options.loadBarWrapId  – id of the loading bar wrapper
 * @param {string} options.loadBarId      – id of the inner loading bar fill
 * @param {Function} [options.onComplete] – called when the animation finishes and the overlay is removed
 */
export async function initLogoAnimation({
    svgPath = 'cclogo.svg',
    overlayId = 'intro-overlay',
    loadingId = 'loading',
    onComplete = null,
} = {}) {
    const { data: imgData, w, h } = await loadSVGData(svgPath);

    const isMobile = window.innerWidth < 768;
    const LOGO_P = isMobile ? 3000 : LOGO_PARTICLES;
    const TEXT_P = isMobile ? 800 : TEXT_PARTICLES;
    const TOTAL = LOGO_P + TEXT_P;

    const logoPts = sampleRegion(imgData, w, h, LOGO_P, 0, 0.72, false);
    const textPts = sampleRegion(imgData, w, h, TEXT_P, 0.72, 1.0, true);
    const logoPositions = [...logoPts, ...textPts];

    const loadingEl = document.getElementById(loadingId);
    const overlay = document.getElementById(overlayId);

    if (loadingEl) loadingEl.classList.add('hide');

    /* ---- Renderer / Scene / Camera ---- */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000);
    overlay.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);

    function getCameraZ() {
        const aspect = window.innerWidth / window.innerHeight;
        return aspect >= 1 ? 8 : 8 + (1 - aspect) * 6;
    }
    camera.position.z = getCameraZ();

    const onResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.position.z = getCameraZ();
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    /* ---- Perfect circle ball (sprite) ---- */
    const circleCanvas = document.createElement('canvas');
    circleCanvas.width = 128;
    circleCanvas.height = 128;
    const cCtx = circleCanvas.getContext('2d');
    cCtx.beginPath();
    cCtx.arc(64, 64, 62, 0, Math.PI * 2);
    cCtx.fillStyle = '#ffffff';
    cCtx.fill();
    const circleTexture = new THREE.CanvasTexture(circleCanvas);

    const ballMat = new THREE.SpriteMaterial({ map: circleTexture, color: 0xffffff });
    const ball = new THREE.Sprite(ballMat);
    ball.scale.set(BALL_RADIUS * 2, BALL_RADIUS * 2, 1);
    ball.position.y = 6;
    scene.add(ball);

    /* ---- Particle data ---- */
    const positions = new Float32Array(TOTAL * 3);
    const colors = new Float32Array(TOTAL * 3);
    const sizes = new Float32Array(TOTAL);
    const explosionVelocities = [];
    const targetPositions = [];
    const scatterVelocities = [];

    for (let i = 0; i < TOTAL; i++) {
        positions[i * 3] = 0;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = 0;

        const lp = logoPositions[i % logoPositions.length];
        colors[i * 3] = lp.r;
        colors[i * 3 + 1] = lp.g;
        colors[i * 3 + 2] = lp.b;
        sizes[i] = 0;

        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const speed = 2 + Math.random() * 5;
        explosionVelocities.push(new THREE.Vector3(
            Math.sin(phi) * Math.cos(theta) * speed,
            Math.sin(phi) * Math.sin(theta) * speed,
            Math.cos(phi) * speed * 0.3,
        ));
        targetPositions.push(new THREE.Vector3(lp.x, lp.y, 0));

        const sx = (lp.x > 0 ? 1 : -1) * (4 + Math.random() * 8);
        const sy = (Math.random() - 0.5) * 6;
        scatterVelocities.push(new THREE.Vector3(sx, sy, 0));
    }

    /* ---- Particle geometry + material ---- */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: { uPixelRatio: { value: renderer.getPixelRatio() } },
        vertexShader,
        fragmentShader,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.visible = false;
    scene.add(pts);

    /* ---- Animation state ---- */
    const explodeOrigin = new THREE.Vector3();
    const explodedPositions = [];
    let dismissed = false;
    const clock = new THREE.Clock();

    /* ---- Animation loop ---- */
    function animate() {
        requestAnimationFrame(animate);
        const t = clock.getElapsedTime();
        const posA = geo.getAttribute('position');
        const sizeA = geo.getAttribute('size');

        /* Phase 1: Ball falling */
        if (t < FALL_DUR) {
            ball.position.y = 6 - 6 * easeInQuad(t / FALL_DUR);
            ball.visible = true;
            pts.visible = false;
        }

        /* Phase 2: Explosion */
        else if (t < FALL_DUR + EXPLODE_DUR) {
            if (ball.visible) {
                ball.visible = false;
                pts.visible = true;
                explodeOrigin.copy(ball.position);
            }
            const et = easeOutCubic((t - FALL_DUR) / EXPLODE_DUR);
            for (let i = 0; i < TOTAL; i++) {
                const v = explosionVelocities[i];
                posA.array[i * 3] = explodeOrigin.x + v.x * et;
                posA.array[i * 3 + 1] = explodeOrigin.y + v.y * et;
                posA.array[i * 3 + 2] = explodeOrigin.z + v.z * et;
                const isText = i >= LOGO_P;
                sizeA.array[i] = isText ? 0.02 : (0.06 + 0.04 * et);
            }
            posA.needsUpdate = sizeA.needsUpdate = true;
        }

        /* Phase 3: Formation → logo */
        else if (t < HOLD_START) {
            if (!explodedPositions.length) {
                for (let i = 0; i < TOTAL; i++) {
                    explodedPositions.push(new THREE.Vector3(
                        posA.array[i * 3], posA.array[i * 3 + 1], posA.array[i * 3 + 2]
                    ));
                }
            }
            const ft = easeInOutCubic((t - FALL_DUR - EXPLODE_DUR) / FORM_DUR);
            for (let i = 0; i < TOTAL; i++) {
                const s = explodedPositions[i], tg = targetPositions[i];
                posA.array[i * 3] = s.x + (tg.x - s.x) * ft;
                posA.array[i * 3 + 1] = s.y + (tg.y - s.y) * ft;
                posA.array[i * 3 + 2] = s.z + (tg.z - s.z) * ft;
                const isText = i >= LOGO_P;
                sizeA.array[i] = isText ? (0.02 + 0.04 * ft) : (0.10 - 0.04 * ft);
            }
            posA.needsUpdate = sizeA.needsUpdate = true;
        }

        /* Phase 4: Brief hold */
        else if (t < SCATTER_START) {
            const ht = t - HOLD_START;
            for (let i = 0; i < TOTAL; i++) {
                const tg = targetPositions[i];
                posA.array[i * 3] = tg.x + Math.sin(ht * 1.2 + i * 0.01) * 0.015;
                posA.array[i * 3 + 1] = tg.y + Math.cos(ht * 1.0 + i * 0.013) * 0.015;
                posA.array[i * 3 + 2] = tg.z;
                sizeA.array[i] = 0.06 + Math.sin(ht * 2 + i * 0.05) * 0.008;
            }
            posA.needsUpdate = sizeA.needsUpdate = true;
        }

        /* Phase 5: Scatter out + fade overlay */
        else if (t < SCATTER_END) {
            const st = easeInCubic((t - SCATTER_START) / SCATTER_DUR);
            for (let i = 0; i < TOTAL; i++) {
                const tg = targetPositions[i];
                const sv = scatterVelocities[i];
                posA.array[i * 3] = tg.x + sv.x * st;
                posA.array[i * 3 + 1] = tg.y + sv.y * st;
                posA.array[i * 3 + 2] = 0;
                sizeA.array[i] = 0.06 * (1 - st);
            }
            posA.needsUpdate = sizeA.needsUpdate = true;
            overlay.style.opacity = 1 - st;
        }

        /* Phase 6: Done — cleanup */
        else if (!dismissed) {
            dismissed = true;
            overlay.style.display = 'none';
            window.removeEventListener('resize', onResize);
            renderer.dispose();
            if (onComplete) onComplete();
            return;
        }

        renderer.render(scene, camera);
    }

    animate();
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

// Layers:
//  - Gaussian splat (Brush, 30k steps) draws the pixels. The bike ships as one file with the wheels removed,
//    plus one file per tyre, so "remove the tyre" is a visibility toggle, not a shader-side region test.
//  - The photogrammetry mesh stays invisible: it is the raycast surface for clicks and the "clay" view.
//  - Replacement parts are GLBs placed on each wheel's measured axle pose; the owner can nudge them.

type View = { pos: [number, number, number]; target: [number, number, number] };
const VIEWS: Record<string, View> = {
    home: { pos: [1.95, 0.95, 1.8], target: [0, 0.55, 0] },
    tyre: { pos: [1.35, 0.45, 0.9], target: [0.75, 0.34, 0] },
    rear: { pos: [-1.35, 0.5, 0.95], target: [-0.69, 0.33, 0] },
    lamp: { pos: [1.75, 1.0, 0.25], target: [0.62, 0.92, 0] },
    tank: { pos: [0.55, 1.55, 0.95], target: [0.25, 0.88, -0.05] },
};

// The splat was trained in RealityScan's raw frame; this is the raw→metric transform the mesh went through,
// applied as the object matrix so spherical-harmonic view directions stay correct.
const RAW_TO_METRIC = new THREE.Matrix4().set(
    -0.05911555, 0.00173394, -0.00253654, -0.06668329,
    -0.00237424, 0.00524017, 0.05891513, -0.18341214,
    0.00195027, 0.05893745, -0.00516356, 0.09723672,
    0, 0, 0, 1,
);

export type WheelKey = 'front' | 'rear';
export type PartKey = string;
type PartDef = { label: string; small: string; file: string };
type WheelDef = {
    title: string; sub: string;
    c: THREE.Vector3; n: THREE.Vector3;        // axle centre and direction (bike on centre stand: no lean)
    rIn: number; rOut: number; halfW: number;  // envelope of the tyre being removed, for hit-testing
    splat: string;                             // the scan's own tyre, as its own splat file
    parts: Record<PartKey, PartDef>;
};
// Measured from the scan: centre from a tread-edge circle fit, mid-plane from tread/mudguard edges (never the
// splat centroid), plane from the spoke disc. Both wheels' mid-planes land at z ≈ -0.04: the bike's centre-plane.
export const WHEELS: Record<WheelKey, WheelDef> = {
    front: {
        title: 'Front tyre', sub: '19" · the scan\'s tyre is its own splat · parts sit on the measured axle',
        c: new THREE.Vector3(0.7137, 0.326, -0.038), n: new THREE.Vector3(-0.05, 0, -0.9987).normalize(),
        rIn: 0.245, rOut: 0.346, halfW: 0.066, splat: '/models/rahul2-meteor-fronttyre.spz',
        parts: {
            ceat: { label: 'CEAT Zoom Plus 100/90‑19', small: 'built from four catalogue renders', file: '/models/ceat-zoom-plus-100-90-19.glb' },
            block: { label: 'Block tread 100/90‑19', small: 'placeholder · generated', file: '/models/tyre-block-100-90-19.glb' },
        },
    },
    rear: {
        title: 'Rear tyre', sub: '17" · the scan\'s tyre is its own splat · parts sit on the measured axle',
        c: new THREE.Vector3(-0.689, 0.3265, -0.042), n: new THREE.Vector3(0, 0, -1),
        rIn: 0.235, rOut: 0.338, halfW: 0.09, splat: '/models/rahul2-meteor-reartyre.spz',
        parts: {
            ceat: { label: 'CEAT Zoom Plus 140/70‑17', small: 'same renders, rear size', file: '/models/ceat-zoom-plus-140-70-17.glb' },
        },
    },
};

const Z = new THREE.Vector3(0, 0, 1);

export function mountBike(canvas: HTMLCanvasElement, onProgress?: (label: string, pct: number) => void) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14110D');

    const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 50);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = 0.25;
    controls.maxDistance = 8;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.autoRotateSpeed = 1.2;

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 96), new THREE.MeshBasicMaterial({ color: '#1A160F' }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.016; // measured ground height under the front wheel
    scene.add(floor);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 1.5);
    scene.add(key);

    const go = (name: keyof typeof VIEWS) => {
        camera.position.set(...VIEWS[name].pos);
        controls.target.set(...VIEWS[name].target);
        controls.update();
    };
    go('home');

    // ---- splats ----
    const makeSplat = (url: string, label: string) => {
        const m = new SplatMesh({ url, onLoad: () => onProgress?.(label, 100) });
        m.matrixAutoUpdate = false;
        m.matrix.copy(RAW_TO_METRIC);
        scene.add(m);
        return m;
    };
    const splat = makeSplat('/models/rahul2-meteor.spz', 'splat');
    const tyreSplats: Record<WheelKey, SplatMesh> = {
        front: makeSplat(WHEELS.front.splat, 'front tyre'),
        rear: makeSplat(WHEELS.rear.splat, 'rear tyre'),
    };
    const ready = Promise.all([splat.initialized, tyreSplats.front.initialized, tyreSplats.rear.initialized]).then(() => undefined);

    // ---- mesh: hidden hit-test layer and clay view ----
    const meshes: THREE.Mesh[] = [];
    const scanMaterials: THREE.Material[] = [];
    const clay = new THREE.MeshStandardMaterial({ color: '#b9b4aa', roughness: 0.85, side: THREE.DoubleSide });
    let meshRoot: THREE.Group | null = null;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const meshReady = ready.then(() =>
        loader.loadAsync('/models/rahul2-meteor.glb', (e) => {
            if (e.total) onProgress?.('mesh', Math.round((e.loaded / e.total) * 100));
        }),
    ).then((gltf) => {
        gltf.scene.traverse((o) => {
            if (!(o as THREE.Mesh).isMesh) return;
            const mesh = o as THREE.Mesh;
            mesh.geometry.computeVertexNormals();
            meshes.push(mesh);
            scanMaterials.push(mesh.material as THREE.Material);
        });
        meshRoot = gltf.scene;
        meshRoot.visible = false;
        scene.add(meshRoot);
    });

    // ---- parts ----
    const fitted: Record<WheelKey, PartKey> = { front: 'scan', rear: 'scan' };
    const loaded: Record<WheelKey, Record<PartKey, THREE.Group>> = { front: {}, rear: {} };
    const adjust: Record<WheelKey, THREE.Vector3> = { front: new THREE.Vector3(), rear: new THREE.Vector3() }; // owner's correction: x fore/aft, y up, z along axle (m)
    let splatOn = true;

    const adjustedCentre = (wk: WheelKey) => {
        const W = WHEELS[wk], a = adjust[wk];
        return W.c.clone().addScaledVector(W.n, a.z).add(new THREE.Vector3(a.x, a.y, 0));
    };
    const loadPart = async (wk: WheelKey, pk: PartKey) => {
        const have = loaded[wk][pk];
        if (have) return have;
        const gltf = await loader.loadAsync(WHEELS[wk].parts[pk].file);
        const part = gltf.scene;
        part.traverse((o) => { if ((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material).side = THREE.DoubleSide; });
        part.quaternion.setFromUnitVectors(Z, WHEELS[wk].n);
        part.position.copy(adjustedCentre(wk));
        part.visible = false;
        scene.add(part);
        loaded[wk][pk] = part;
        return part;
    };

    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.29, 0.05, 8, 64),
        new THREE.MeshBasicMaterial({ color: '#C9A24A', wireframe: true, transparent: true, opacity: 0.45 }),
    );
    ring.visible = false;
    scene.add(ring);

    const wheelAt = (p: THREE.Vector3): WheelKey | null => {
        for (const wk of Object.keys(WHEELS) as WheelKey[]) {
            const W = WHEELS[wk];
            const d = p.clone().sub(W.c);
            const w = d.dot(W.n);
            const r = Math.sqrt(Math.max(0, d.lengthSq() - w * w));
            if (Math.abs(w) < W.halfW + 0.02 && r > W.rIn - 0.02 && r < W.rOut + 0.02) return wk;
        }
        return null;
    };

    // Click → raycast the hidden mesh for a 3D point → which wheel's envelope contains it.
    const ray = new THREE.Raycaster();
    let down: [number, number] | null = null;
    let onPick: ((wheel: WheelKey | null) => void) | undefined;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !meshRoot) return;
        down = null;
        const r = canvas.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const hits = ray.intersectObjects(meshes, false);
        onPick?.(hits.length ? wheelAt(hits[0].point) : null);
    });

    const resize = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.fov = w < h ? 50 : 35;
        camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();

    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });

    return {
        ready,
        meshReady,
        go,
        wheels: WHEELS,
        fittedOn: (wk: WheelKey) => fitted[wk],
        adjustment: (wk: WheelKey) => adjust[wk].clone(),
        setSplat(on: boolean) {
            splatOn = on;
            splat.visible = on;
            for (const wk of Object.keys(tyreSplats) as WheelKey[]) tyreSplats[wk].visible = on && fitted[wk] === 'scan';
        },
        setMesh(on: boolean) { if (meshRoot) meshRoot.visible = on; },
        setClay(on: boolean) { meshes.forEach((m, i) => (m.material = on ? clay : scanMaterials[i])); },
        toggleSpin() { controls.autoRotate = !controls.autoRotate; return controls.autoRotate; },
        select(wk: WheelKey | null) {
            ring.visible = wk !== null;
            if (wk) {
                const W = WHEELS[wk];
                ring.position.copy(adjustedCentre(wk));
                ring.quaternion.setFromUnitVectors(Z, W.n);
                ring.scale.setScalar((W.rIn + W.rOut) / 2 / 0.29);
            }
        },
        async fit(wk: WheelKey, pk: PartKey) {
            fitted[wk] = pk;
            Object.values(loaded[wk]).forEach((p) => (p.visible = false));
            tyreSplats[wk].visible = pk === 'scan' && splatOn;
            if (pk !== 'scan') {
                const part = await loadPart(wk, pk);
                if (fitted[wk] === pk) { Object.values(loaded[wk]).forEach((p) => (p.visible = false)); part.visible = true; }
            }
        },
        /** Owner's manual correction in millimetres: x fore/aft, y up/down, z along the axle. */
        nudge(wk: WheelKey, mm: { x?: number; y?: number; z?: number }) {
            const a = adjust[wk];
            if (mm.x !== undefined) a.x = mm.x / 1000;
            if (mm.y !== undefined) a.y = mm.y / 1000;
            if (mm.z !== undefined) a.z = mm.z / 1000;
            const c = adjustedCentre(wk);
            Object.values(loaded[wk]).forEach((p) => p.position.copy(c));
            if (ring.visible) ring.position.copy(c);
        },
        onPick(cb: (wheel: WheelKey | null) => void) { onPick = cb; },
    };
}

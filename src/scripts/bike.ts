import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode,
} from '@sparkjsdev/spark';

// Two layers, one bike.
//  - The Gaussian splat (Brush, 30k steps, ~980k splats) draws the pixels. It was trained
//    from the same phone frames as the mesh and reproduces chrome, gloss and the tank logo.
//  - The photogrammetry mesh stays invisible and does the geometry work: real-world scale,
//    click hit-testing, and the measurements that place replacement parts.
// Parts are swapped by zeroing splat opacity inside a region (Spark SDF edit) and dropping a GLB in.

type View = { pos: [number, number, number]; target: [number, number, number] };
const VIEWS: Record<string, View> = {
    home: { pos: [1.95, 0.95, 1.8], target: [0, 0.55, 0] },
    tyre: { pos: [1.35, 0.45, 0.9], target: [0.75, 0.34, 0] },
    lamp: { pos: [1.75, 1.0, 0.25], target: [0.62, 0.92, 0] },
    tank: { pos: [0.55, 1.55, 0.95], target: [0.25, 0.88, -0.05] },
};

// The splat was trained in RealityScan's raw frame. This is the same raw→metric transform
// the mesh went through (rotation, origin shift, 0.0592 m/unit), applied as the object matrix
// so spherical-harmonic view directions stay correct.
const RAW_TO_METRIC = new THREE.Matrix4().set(
    -0.05911555, 0.00173394, -0.00253654, -0.06668329,
    -0.00237424, 0.00524017, 0.05891513, -0.18341214,
    0.00195027, 0.05893745, -0.00516356, 0.09723672,
    0, 0, 0, 1,
);

// Front wheel, measured from the scaled mesh: centre, axle direction, rim lip and tyre outer radius (m).
const WHEEL = {
    c: new THREE.Vector3(0.698, 0.348, -0.02),
    n: new THREE.Vector3(-0.033, 0.029, -0.999).normalize(),
    rIn: 0.245,
    rOut: 0.355,
    halfW: 0.075,
};

export type TyreOption = 'scan' | 'block';

export function mountBike(canvas: HTMLCanvasElement, onProgress?: (label: string, pct: number) => void) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14110D'); // --bg from Layout

    const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 50);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = 0.25;
    controls.maxDistance = 8;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.autoRotateSpeed = 1.2;

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    // The splat carries its own patch of paving; this disc sits just under it to catch the edge.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 96), new THREE.MeshBasicMaterial({ color: '#1A160F' }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.03;
    scene.add(floor);

    // Lights only affect the mesh (clay view) and the inserted parts; the splat is unlit by nature.
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

    // ---- splat (visible layer) ----
    const splat = new SplatMesh({
        url: '/models/rahul2-meteor.spz',
        onLoad: () => onProgress?.('splat', 100),
    });
    splat.matrixAutoUpdate = false;
    splat.matrix.copy(RAW_TO_METRIC);
    scene.add(splat);
    const ready = splat.initialized.then(() => undefined);

    // ---- mesh (hidden hit-test layer, also the "clay" view) ----
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

    // ---- part swap: front tyre ----
    // Spark SDFs union only, so the tyre annulus is a ring of 32 rotated boxes (rim-edge error ≈ 1 mm).
    const hideTyre = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.004 });
    {
        const N = 32, rMid = (WHEEL.rIn + WHEEL.rOut) / 2, halfR = (WHEEL.rOut - WHEEL.rIn) / 2, halfT = (Math.PI * rMid / N) * 1.04;
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), WHEEL.n);
        for (let i = 0; i < N; i++) {
            const a = (2 * Math.PI * i) / N;
            const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
            sdf.position.set(Math.cos(a) * rMid, Math.sin(a) * rMid, 0).applyQuaternion(q).add(WHEEL.c);
            sdf.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a));
            sdf.scale.set(halfR, halfT, WHEEL.halfW); // half extents: radial, tangential, across the tyre
            hideTyre.add(sdf);
        }
        hideTyre.visible = false;
        scene.add(hideTyre);
    }

    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.3, 0.055, 8, 64),
        new THREE.MeshBasicMaterial({ color: '#C9A24A', wireframe: true, transparent: true, opacity: 0.45 }),
    );
    ring.position.copy(WHEEL.c);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), WHEEL.n);
    ring.visible = false;
    scene.add(ring);

    let tyrePart: THREE.Group | null = null;
    const loadTyre = async () => {
        if (tyrePart) return tyrePart;
        const gltf = await loader.loadAsync('/models/tyre-block-100-90-19.glb');
        tyrePart = gltf.scene;
        tyrePart.position.copy(WHEEL.c);
        tyrePart.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), WHEEL.n);
        scene.add(tyrePart);
        return tyrePart;
    };

    const inTyre = (p: THREE.Vector3) => {
        const d = p.clone().sub(WHEEL.c);
        const w = d.dot(WHEEL.n);
        const r = Math.sqrt(Math.max(0, d.lengthSq() - w * w));
        return Math.abs(w) < WHEEL.halfW + 0.02 && r > WHEEL.rIn - 0.02 && r < WHEEL.rOut + 0.02;
    };

    // Click → raycast the hidden mesh; the splat only draws pixels.
    const ray = new THREE.Raycaster();
    let down: [number, number] | null = null;
    let onPick: ((part: 'tyre' | null) => void) | undefined;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !meshRoot) return;
        down = null;
        const r = canvas.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const hits = ray.intersectObjects(meshes, false);
        const hit = hits.length > 0 && inTyre(hits[0].point);
        ring.visible = hit;
        onPick?.(hit ? 'tyre' : null);
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
        splats: () => splat.numSplats,
        setSplat(on: boolean) { splat.visible = on; },
        setMesh(on: boolean) { if (meshRoot) meshRoot.visible = on; },
        setClay(on: boolean) { meshes.forEach((m, i) => (m.material = on ? clay : scanMaterials[i])); },
        toggleSpin() { controls.autoRotate = !controls.autoRotate; return controls.autoRotate; },
        async fitTyre(which: TyreOption) {
            const block = which === 'block';
            hideTyre.visible = block;
            if (block) (await loadTyre()).visible = true;
            else if (tyrePart) tyrePart.visible = false;
        },
        deselect() { ring.visible = false; },
        onPick(cb: (part: 'tyre' | null) => void) { onPick = cb; },
    };
}

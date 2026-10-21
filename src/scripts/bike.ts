import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// A photogrammetry scan already has its lighting baked into the texture, so the
// GLB uses KHR_materials_unlit (GLTFLoader turns that into MeshBasicMaterial).
// Adding scene lights would light it twice. The lights below only matter for
// the "clay" view, which swaps in a lit grey material to show the raw shape.

type View = { pos: [number, number, number]; target: [number, number, number] };
const VIEWS: Record<string, View> = {
    home: { pos: [1.95, 0.95, 1.8], target: [0, 0.55, 0] },
    tyre: { pos: [1.35, 0.45, 0.9], target: [0.75, 0.34, 0] },
    lamp: { pos: [1.75, 1.0, 0.25], target: [0.62, 0.92, 0] },
};

export function mountBike(canvas: HTMLCanvasElement, onProgress?: (pct: number) => void) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14110D'); // --bg from Layout

    // Model units are metres: +X is the front of the bike, Y is up, ground at y = 0.
    const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 50);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = 0.25;
    controls.maxDistance = 8;
    controls.maxPolarAngle = Math.PI * 0.52; // stop the camera going under the floor
    controls.autoRotateSpeed = 1.2;

    const floor = new THREE.Mesh(
        new THREE.CircleGeometry(2.2, 96),
        new THREE.MeshBasicMaterial({ color: '#1A160F' }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.004;
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

    const meshes: THREE.Mesh[] = [];
    const scanMaterials: THREE.Material[] = [];
    const clay = new THREE.MeshStandardMaterial({ color: '#b9b4aa', roughness: 0.85, side: THREE.DoubleSide });

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const ready = loader.loadAsync('/models/rahul2-meteor.glb', (e) => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100));
    }).then((gltf) => {
        gltf.scene.traverse((o) => {
            if (!(o as THREE.Mesh).isMesh) return;
            const mesh = o as THREE.Mesh;
            const mat = mesh.material as THREE.MeshBasicMaterial;
            if (mat.map) mat.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
            mesh.geometry.computeVertexNormals(); // only needed for the clay view
            meshes.push(mesh);
            scanMaterials.push(mat);
        });
        scene.add(gltf.scene);
    });

    const resize = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.fov = w < h ? 50 : 35; // portrait phones need a wider lens to fit the bike
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
        go,
        setClay(on: boolean) { meshes.forEach((m, i) => (m.material = on ? clay : scanMaterials[i])); },
        toggleSpin() { controls.autoRotate = !controls.autoRotate; return controls.autoRotate; },
    };
}

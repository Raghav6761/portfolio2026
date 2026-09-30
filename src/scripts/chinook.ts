import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export async function mountChinook(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    //   what for is this ? If i remove this code, it still renders the model correctly.
    const sun = new THREE.DirectionalLight(0xfff3dc, 2.2);
    sun.position.set(3, 5, 2);
    scene.add(sun);

    //   The camera is for rendering the scene. It defines the perspective from which the scene is viewed.
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
    camera.position.set(5, 4.5, 15);
    camera.lookAt(0, 0, 0);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync('/models/chinook-lite.glb');
    const craft = gltf.scene;

    // the model is ~2623 units long and off-centre; fit it into a 10-unit box at the origin
    const box = new THREE.Box3().setFromObject(craft);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const s = 10 / Math.max(size.x, size.y, size.z);
    craft.scale.setScalar(s);
    craft.position.copy(centre).multiplyScalar(-s);

    const pivot = new THREE.Group();
    pivot.add(craft);
    scene.add(pivot);

    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
    }
    console.log(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight, camera.aspect);
    new ResizeObserver(resize).observe(canvas);
    resize();

    //   add a second pivot to rotate the model around its centre, rather than the scene origin
    const spin = new THREE.Group();
    spin.add(craft);
    pivot.add(spin);
    scene.add(pivot);

    //   rotate the model slowly around the Y axis and render the scene
    //   renderer.setAnimationLoop(() => {
    //     pivot.rotation.y += 0.002;
    //     renderer.render(scene, camera);
    //   });

    // hover the aircraft in place
    const timer = new THREE.Timer();
    timer.connect(document);

    renderer.setAnimationLoop((timestamp: any) => {
        timer.update(timestamp);
        const t = timer.getElapsed();

        pivot.position.y = Math.sin(t * 1.10) * 0.18;
        pivot.rotation.x = Math.sin(t * 0.70) * 0.012;
        pivot.rotation.z = Math.sin(t * 0.90 + 1.3) * 0.008;

        const dt = timer.getDelta();
        hubs.forEach((h, i) => { h.rotation.y += dt * 8 * (i ? -1 : 1); });

        renderer.render(scene, camera);
    })

    // just a single render of the model, no animation
    // renderer.render(scene, camera);

    let dragging = false;
    let lastX = 0, lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        spin.rotation.y += dx * 0.006;
        spin.rotation.x = THREE.MathUtils.clamp(spin.rotation.x + dy * 0.006, -1.2, 1.2);
    });

    function endDrag(e: PointerEvent) {
        dragging = false;
        canvas.releasePointerCapture(e.pointerId);
        canvas.style.cursor = 'grab';
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // center the rotors of the aircraft so that they spin around their own axes rather than around the model origin
    scene.updateMatrixWorld(true);

    function makeHub(rotor: THREE.Mesh) {
        const parent = rotor.parent!;
        const pos = rotor.geometry.attributes.position;

        const c = new THREE.Vector3();
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) c.add(v.fromBufferAttribute(pos, i));
        c.divideScalar(pos.count);
        rotor.localToWorld(c);

        const hub = new THREE.Group();
        parent.add(hub);
        hub.position.copy(parent.worldToLocal(c.clone()));
        hub.attach(rotor);
        return hub;
    }

    const hubs = ['Cylinder004', 'Cylinder009']
        .map((n) => craft.getObjectByName(n) as THREE.Mesh)
        .filter(Boolean)
        .map(makeHub);
}
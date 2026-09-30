import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
// import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// import { Sky } from 'three/addons/objects/Sky.js';
// import { makeGrassTuft, makeGrassMaterial } from './grassTuft';

export async function mountWorld(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.5;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();

    // const pmrem = new THREE.PMREMGenerator(renderer);
    // scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // RoomEnvironment is a white studio box — right for a product, wrong for a
    // landscape. Turn it down to a fill light so the sun actually does the work.
    // scene.environmentIntensity = 7.0;

    // The single source of truth. Light and sky disc both read this, so the shadow
    // direction and the thing you see in the sky can never drift apart.
    const SUN_DIR = new THREE.Vector3(-50, 9.5, 55).normalize();

    const sun = new THREE.DirectionalLight(0xfff0d2, 14);
    sun.position.copy(SUN_DIR).multiplyScalar(300);

    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    // sun.intensity = 14;

    // A directional light casts through an ORTHOGRAPHIC camera that defaults to
    // ±5 units. Your terrain is 186 across — without this you get shadows in a
    // tiny patch at the origin and nowhere else.
    const extent = 120;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 600;
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);

    // A physical sky is solving a problem you don't have. You want a specific colour
    // behind a dark landscape; Preetham gives you a physically-correct one you can't
    // choose — and at this camera angle that's always near-white. Two stops instead.
    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
            top: { value: new THREE.Color(0x3a4c6b) },   // zenith
            bottom: { value: new THREE.Color(0xa87f52) },   // horizon
            discSize: { value: 0.9998 },                       // how big the sun disc is
            discPower: { value: 14 },                       // how bright the sun disc is
            sunDir: { value: SUN_DIR.clone() },
            sunCol: { value: new THREE.Color(0xffe6bd) },
            lo: { value: -0.02 },                       // where the blend starts
            hi: { value: 0.18 },                       // where it ends
        },
        vertexShader: `
        varying vec3 vPos;
        void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position.z = gl_Position.w;   // force to the far plane — never clipped
        }`,
        fragmentShader: `
        uniform vec3 top; uniform vec3 bottom;
        uniform float lo; uniform float hi;
        uniform vec3 sunDir; uniform vec3 sunCol;
        uniform float discSize; uniform float discPower;
        varying vec3 vPos;
        void main() {
            vec3 dir = normalize(vPos);

            // normalize(vPos).y is the sine of the elevation angle: 0 at the
            // horizon, 1 straight up. The whole sky you can see is roughly
            // y = 0 to 0.2, so the blend has to happen in THAT band.
            vec3 col = mix(bottom, top, smoothstep(lo, hi, dir.y));

            // dot() of two unit vectors is the cosine of the angle between them,
            // so d is 1 dead at the sun and falls off with angular distance.
            float d = max(dot(dir, normalize(sunDir)), 0.0);

            float disc = smoothstep(discSize, discSize + 0.0004, d);
            float glow = pow(d, 900.0) * 0.55 + pow(d, 60.0) * 0.10;

            col += sunCol * (disc * discPower + glow);
            gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), skyMat);
    scene.add(sky);

    // Same trick as before — a copy in a throwaway scene, blurred into an environment.
    const skyScene = new THREE.Scene();
    skyScene.add(new THREE.Mesh(sky.geometry, skyMat));
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(skyScene, 0, 0.1, 5000).texture;
    scene.environmentIntensity = 7.0;

    //   The camera is for rendering the scene. It defines the perspective from which the scene is viewed.
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
    camera.position.set(0, 13, -23);
    // camera.lookAt(0, 5, 0);

    // allows the user to rotate the model with the mouse, and zoom in/out
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 8, 0); //controls the point around which the camera orbits
    controls.enableDamping = true; // enables smooth camera movement when the user rotates the model
    controls.dampingFactor = 0.05; // enables smooth camera movement when the user rotates the model

    controls.maxPolarAngle = Math.PI / 2 - 0.08; // Prevent camera from going below the ground
    controls.minDistance = 12; // Minimum distance from the target
    controls.maxDistance = 34; // Maximum distance from the target

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    // const gltf = await loader.loadAsync('/models/terrain-full.glb');
    // const gltf = await loader.loadAsync('/models/terrain-textured-notree.glb');
    // const gltf = await loader.loadAsync('/models/terrain-unique.glb');
    const [gltf, craftGltf] = await Promise.all([
        loader.loadAsync('/models/terrain-unique.glb'),
        loader.loadAsync('/models/chinook-lite.glb')
    ]);
    const terrain = gltf.scene;

    // ── sky + fog ────────────────────────────────────────────────────
    // Both MUST be the same colour. Fog fades geometry toward its own colour,
    // never toward what's behind it — mismatch them and you see a band at the
    // horizon. This is also what makes the terrain's square edge dissolve.
    // const HAZE = 0x232028;
    // scene.background = new THREE.Color(HAZE);
    // scene.fog = new THREE.FogExp2(0xa87f52, 0.0035);
    // scene.fog = null;
    // scene.fog = new THREE.FogExp2(0x9fb0c4, 0.0012);

    // Replace the grassParts block entirely:
    // const grassGeo = makeGrassTuft({ height: 1 });   // ~2 units tall on a 186-unit terrain
    // const grassMat = makeGrassMaterial();

    // // the model is ~2623 units long and off-centre; fit it into a 10-unit box at the origin
    // const box = new THREE.Box3().setFromObject(terrain);
    // const size = box.getSize(new THREE.Vector3());
    // const centre = box.getCenter(new THREE.Vector3());
    // const s = 10 / Math.max(size.x, size.y, size.z);
    // terrain.scale.setScalar(s);
    // terrain.position.copy(centre).multiplyScalar(-s);

    // const pivot = new THREE.Group();
    // pivot.add(terrain);
    scene.add(terrain);

    // ── map scale ────────────────────────────────────────────────────────
    // One number. Every limit below derives from the terrain's bounding box
    // rather than a magic constant, so changing this doesn't send you hunting.
    const MAP_SCALE = 10;          // 186 units across → 558
    const HEIGHT_SCALE = 3;       // 40 units tall → 40
    // terrain.scale.setScalar(MAP_SCALE, HEIGHT_SCALE, MAP_SCALE);
    terrain.scale.set(MAP_SCALE, HEIGHT_SCALE, MAP_SCALE);

    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    console.log(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight, camera.aspect);
    new ResizeObserver(resize).observe(canvas);
    resize();

    // setAnimationLoop runs this before every frame the browser paints.
    // Mutating the scene draws nothing on its own — the render call is what draws.
    renderer.setAnimationLoop(() => {
        controls.update();               // applies damping; without this, no glide
        renderer.render(scene, camera);
    });

    // Paints a mesh's vertices by how steep the surface is there.
    // Cheap, needs no texture, and gives natural variation because the terrain's
    // own shape decides the colours — grass settles in the flats, rock shows on
    // the faces, exactly as it would in life.
    function paintBySlope(mesh: THREE.Mesh) {
        const geo = mesh.geometry;
        const pos = geo.attributes.position;
        const nrm = geo.attributes.normal;

        // These are sRGB hex values. THREE.Color converts them to the linear working
        // space on construction, which is what the colour attribute must hold.
        const GRASS = new THREE.Color(0x4f6129);
        const ROCK = new THREE.Color(0x6f6659);
        const SCREE = new THREE.Color(0x877e6e);

        const DRY = new THREE.Color(0x6e7a34);   // yellower, drier grass

        // Find the height range so the "higher = barer" term is relative to this
        // terrain rather than a magic number that breaks on a different model.
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < pos.count; i++) {
            const y = pos.getY(i);
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        const colours = new Float32Array(pos.count * 3);
        const c = new THREE.Color();

        for (let i = 0; i < pos.count; i++) {
            // The vertex normal points away from the surface. Its Y component is 1 on
            // perfectly flat ground and 0 on a vertical wall — so it IS the slope,
            // already computed for you. No trigonometry needed.
            //
            // (getY denormalises automatically: this geometry is quantised to i8, and
            // BufferAttribute's getters undo that when the attribute is `normalized`.)
            const flat = nrm.getY(i);

            // smoothstep(x, edge0, edge1) → 0..1 with eased ends, so the grass/rock
            // boundary blends instead of drawing a hard line across the hillside.
            const grassiness = THREE.MathUtils.smoothstep(flat, 0.62, 0.88);
            c.copy(ROCK).lerp(GRASS, grassiness);

            // Two sine waves at different frequencies = smooth patchiness with no
            // texture and no noise library. Varies lush green toward dry, so the
            // ground stops being one flat colour.
            const px = pos.getX(i), pz = pos.getZ(i);
            const patch =
                Math.sin(px * 0.09) * Math.cos(pz * 0.11) * 0.5 +
                Math.sin(px * 0.031 + 1.7) * Math.cos(pz * 0.027 - 0.9) * 0.5;
            c.lerp(DRY, THREE.MathUtils.clamp(patch * 0.5 + 0.5, 0, 1) * 0.55);

            // Second pass: wash toward pale scree near the peaks.
            const height = (pos.getY(i) - minY) / (maxY - minY);
            c.lerp(SCREE, THREE.MathUtils.smoothstep(height, 0.78, 1.0) * 0.35);

            colours[i * 3 + 0] = c.r;
            colours[i * 3 + 1] = c.g;
            colours[i * 3 + 2] = c.b;
        }

        geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

        // Clone the material — terrain and rocks share `aiStandardSurface5`, and a
        // material with vertexColors:true renders black on any mesh that has no
        // colour attribute. Cloning keeps the rocks working.
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.vertexColors = false;

        // THIS LINE MATTERS. Vertex colour MULTIPLIES material.color. Right now that's
        // my dark brown placeholder (0.115), so your greens would come out near-black.
        // White is the identity for a multiply.
        mat.color.set(0xffffff);

        mesh.material = mat;


        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach((k) => {
            const t = (mat as any)[k];
            if (!t) return;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;   // without this, repeat is clamped and ignored
            // t.repeat.set(14, 14);
            t.needsUpdate = true;
        });
    }

    scene.updateMatrixWorld(true);   // raycasting and world matrices need this

    // Derive the limits from the terrain itself, so changing MAP_SCALE or
    // HEIGHT_SCALE carries them along instead of leaving them silently wrong.
    const terrainBox = new THREE.Box3().setFromObject(terrain);
    const BOUND_X = terrainBox.max.x - 30 * MAP_SCALE;
    const BOUND_Z = terrainBox.max.z - 30 * MAP_SCALE;
    const CEILING = terrainBox.max.y + 50;

    // Start above the ridgeline. This can't live with the camera construction at
    // line 110 — the terrain isn't loaded yet there, so its height is unknown.
    const START_Y = terrainBox.max.y * 0.55;
    controls.target.set(0, START_Y, 0);
    camera.position.set(0, START_Y + 5, -23);

    const ground = terrain.getObjectByName('pPlane1') as THREE.Mesh;
    terrain.traverse((o: any) => {
        if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    paintBySlope(ground);

    // The rocks inherit the terrain's textured material at repeat 1×1 — one photo
    // stretched over each slab while the ground beside them tiles 14×. They don't
    // need a texture at all; what they need is to sit in the same colour family
    // and stop catching specular light like wet plastic.
    // function dressRocks(names: string[]) {
    //     const STONE = new THREE.Color(0x585449);   // mid stone, a shade under the terrain's rock tone
    //     const SHADE = new THREE.Color(0x36342e);   // undersides and crevices
    //     const MOSS = new THREE.Color(0x4a5a2c);   // near the terrain's GRASS — this is the tie-in

    //     // ONE material for all three: same geometry, same material, one draw call.
    //     const mat = new THREE.MeshStandardMaterial({
    //         color: 0xffffff,      // white — the vertex colours carry the actual colour
    //         vertexColors: false,
    //         roughness: 1.0,       // stone has no sheen; the pale gloss was half the problem
    //         metalness: 0,
    //     });

    //     for (const n of names) {
    //         const mesh = terrain.getObjectByName(n) as THREE.Mesh;
    //         if (!mesh) continue;

    //         // The three rocks SHARE one BufferGeometry but are rotated differently.
    //         // Without a clone, painting one paints all three — and since we tint by
    //         // which way a face points, two of them would get moss on their undersides.
    //         mesh.geometry = mesh.geometry.clone();

    //         const geo = mesh.geometry;
    //         const nrm = geo.attributes.normal;

    //         // Local normals aren't world normals once a node is rotated. Same
    //         // inverse-transpose rule as the grass scatter.
    //         const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    //         const v = new THREE.Vector3();
    //         const colours = new Float32Array(nrm.count * 3);
    //         const c = new THREE.Color();

    //         for (let i = 0; i < nrm.count; i++) {
    //             v.fromBufferAttribute(nrm, i).applyNormalMatrix(nm).normalize();
    //             const up = v.y;   // +1 faces the sky, 0 vertical, −1 underside

    //             c.copy(SHADE).lerp(STONE, THREE.MathUtils.smoothstep(up, -0.4, 0.5));
    //             // Moss only where the sky can reach. This is the line that stops them
    //             // looking dropped on — they pick up the hillside's own colour on top.
    //             c.lerp(MOSS, THREE.MathUtils.smoothstep(up, 0.72, 1.0) * 0.55);

    //             colours[i * 3 + 0] = c.r;
    //             colours[i * 3 + 1] = c.g;
    //             colours[i * 3 + 2] = c.b;
    //         }

    //         geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    //         mesh.material = mat;
    //         mesh.castShadow = true;
    //         mesh.receiveShadow = true;
    //     }
    // }

    // dressRocks(['rock_face_02', 'rock_face_03', 'rock_face_04']);

    // Scatters copies of ONE geometry across `ground` by raycasting straight down.
    // Takes a geometry+material pair rather than source meshes, because the grass
    // is now generated rather than pulled out of the GLB — there's no source node
    // to inherit a transform from, which is why the decompose step is gone.
    // function scatterGeometry(
    //     geometry: THREE.BufferGeometry,
    //     material: THREE.Material,
    //     ground: THREE.Mesh,
    //     count: number,
    // ) {
    //     const ray = new THREE.Raycaster();
    //     const DOWN = new THREE.Vector3(0, -1, 0);
    //     const from = new THREE.Vector3();
    //     const box = new THREE.Box3().setFromObject(ground);

    //     const spots: { point: THREE.Vector3; yaw: number; scale: number }[] = [];

    //     let attempts = 0;
    //     while (spots.length < count && attempts < count * 20) {
    //         attempts++;

    //         const x = THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random());
    //         const z = THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random());
    //         from.set(x, box.max.y + 10, z);
    //         ray.set(from, DOWN);

    //         const hit = ray.intersectObject(ground, false)[0];
    //         if (!hit || !hit.face) continue;

    //         const worldNormal = hit.face.normal.clone().applyNormalMatrix(
    //             new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)
    //         );
    //         if (worldNormal.y < 0.82) continue;   // too steep — grass wouldn't hold

    //         spots.push({
    //             point: hit.point.clone(),
    //             yaw: Math.random() * Math.PI * 2,
    //             scale: 1.6 + Math.random() * 1.0,
    //         });
    //     }

    //     // If the slope test is too strict you hit the attempts cap and silently get
    //     // fewer than you asked for. Say so rather than wondering why it looks thin.
    //     if (spots.length < count) {
    //         console.warn(`grass: wanted ${count}, placed ${spots.length}`);
    //     }

    //     const up = new THREE.Vector3(0, 1, 0);
    //     const m = new THREE.Matrix4();
    //     const q = new THREE.Quaternion();
    //     const s = new THREE.Vector3();

    //     const inst = new THREE.InstancedMesh(geometry, material, spots.length);

    //     // ── THIS IS THE PART THAT WENT MISSING ──
    //     // An InstancedMesh starts with every matrix at identity, so without this
    //     // loop all N copies sit on top of each other at the origin.
    //     spots.forEach((spot, i) => {
    //         q.setFromAxisAngle(up, spot.yaw);
    //         s.setScalar(spot.scale);
    //         m.compose(spot.point, q, s);   // compose(position, rotation, scale)
    //         inst.setMatrixAt(i, m);
    //     });

    //     inst.instanceMatrix.needsUpdate = true;   // tells the GPU the buffer changed

    //     inst.receiveShadow = true;
    //     inst.castShadow = false;

    //     // Bounds that actually cover all the instances, so frustum culling works
    //     // instead of having to be switched off.
    //     inst.computeBoundingSphere();

    //     scene.add(inst);
    //     return inst;
    // }

    // scatterGeometry(grassGeo, grassMat, ground, 1500);

    // Hide Mandeep's grass. It stays in the GLB but costs nothing while invisible.
    ['grassBermuda1Main', 'grassBermuda1Leaf'].forEach((n) => {
        const m = terrain.getObjectByName(n);
        if (m) m.visible = false;
    });

    // ── the aircraft ─────────────────────────────────────────────────────
    const CRAFT_LENGTH = 10;   // world units, nose to tail INCLUDING rotor sweep

    const craft = craftGltf.scene;

    // The nose runs along the model's local +X. three.js's convention is that an
    // object faces -Z, and every heading formula you'll find assumes it. Turn the
    // model once here rather than carrying a quarter-turn through the maths forever.
    craft.rotation.y = -Math.PI / 2;          // nose now points along +Z
    craft.updateMatrixWorld(true);

    // Measure AFTER the rotation, not before — Box3.setFromObject reads world
    // transforms, so the long axis is Z now, not X.
    const cSize = new THREE.Box3().setFromObject(craft).getSize(new THREE.Vector3());
    craft.scale.setScalar(CRAFT_LENGTH / cSize.z);
    craft.updateMatrixWorld(true);

    // ...and centre it only once the scale is applied, or you'd be cancelling an
    // offset measured at the wrong size.
    const cCentre = new THREE.Box3().setFromObject(craft).getCenter(new THREE.Vector3());
    craft.position.sub(cCentre);

    craft.traverse((o: any) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    // Two groups, because they do different jobs and must not overwrite each other:
    //   craftRig  — where the aircraft IS and which way it points
    //   craftTilt — how it leans, expressed in heading space, so "roll about z"
    //               genuinely means roll about the direction of travel
    const craftTilt = new THREE.Group();
    craftTilt.add(craft);
    const craftRig = new THREE.Group();
    craftRig.add(craftTilt);
    scene.add(craftRig);

    // ── nav lights ───────────────────────────────────────────────────────
    // The GLB ships none of its own — no KHR_lights_punctual, no emissive
    // textures. These are ours.

    // A SpriteMaterial with no map draws a flat square. Paint a radial falloff
    // onto a canvas once and every light becomes a round glow, for about 1 KB.
    function glowTexture() {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d')!;
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0.00, 'rgba(255,255,255,1)');
        g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
        g.addColorStop(1.00, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    }
    const GLOW = glowTexture();

    // Measure the FUSELAGE, not the whole bounding box. The full box includes the
    // rotor sweep, so "halfway up the aircraft" lands in open air above the roof.
    const fuseBox = new THREE.Box3().setFromObject(
        craft.getObjectByName('Retopo_Cube013') as THREE.Mesh);
    const fuseSize = fuseBox.getSize(new THREE.Vector3());

    function beacon(color: number, pos: THREE.Vector3, size: number) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: GLOW,
            color,
            // THE line that makes this work. With sizeAttenuation false the sprite
            // shader does `scale *= -mvPosition.z`, cancelling the perspective
            // divide — so the light holds a constant PIXEL size at any distance.
            // That's why you see an aircraft's beacon long after the aircraft
            // itself has shrunk below one pixel.
            sizeAttenuation: false,
            transparent: true,
            blending: THREE.AdditiveBlending,  // light adds to what's behind it
            depthWrite: false,                 // ...but still depth-TESTS, so the
        }));                                   // fuselage correctly hides the far side
        s.scale.setScalar(size);
        s.position.copy(pos);
        craftTilt.add(s);
        return s;
    }

    // const lightY = fuseBox.min.y + fuseSize.y * 0.30;
    // const navZ = fuseBox.max.z - fuseSize.z * 0.30;
    // // Port is red, starboard green. With the nose on +Z and up on +Y, right is
    // // forward × up = Z × Y = −X — so starboard is the MIN x side, not the max.
    // beacon(0x2aff5a, new THREE.Vector3(fuseBox.min.x, lightY, navZ), 0.006);  // starboard
    // beacon(0xff2a2a, new THREE.Vector3(fuseBox.max.x, lightY, navZ), 0.006);  // port
    // beacon(0xffffff, new THREE.Vector3(0, lightY, fuseBox.min.z + fuseSize.z * 0.02), 0.005);

    // const strobe = beacon(0xff3020,
    //     new THREE.Vector3(0, fuseBox.min.y + fuseSize.y * 0.52,
    //         fuseBox.min.z + fuseSize.z * 0.30), 0.010);

    const strobe = beacon(0xff3020,
        new THREE.Vector3(0, fuseBox.min.y + fuseSize.y * 0.52,
            fuseBox.min.z + fuseSize.z * 0.30), 0.010);

    scene.updateMatrixWorld(true);   // makeHub walks world matrices — they must be current

    function makeHub(rotor: THREE.Mesh) {
        const parent = rotor.parent!;
        const pos = rotor.geometry.attributes.position;
        const c = new THREE.Vector3(), v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) c.add(v.fromBufferAttribute(pos, i));
        c.divideScalar(pos.count);
        rotor.localToWorld(c);

        const hub = new THREE.Group();
        parent.add(hub);
        hub.position.copy(parent.worldToLocal(c.clone()));
        hub.attach(rotor);     // attach, not add — keeps the rotor's world transform
        return hub;
    }

    // Cylinder004 is the aft rotor, Cylinder009 the forward one. A Chinook's
    // rotors counter-rotate; that's what cancels the torque a tail rotor handles
    // on a conventional helicopter.
    const hubs = ['Cylinder004', 'Cylinder009']
        .map((n) => craft.getObjectByName(n) as THREE.Mesh)
        .filter(Boolean)
        .map(makeHub);

    // ## Fly
    // Track held keys rather than acting on keydown: keydown repeats at the OS's
    // rate, which makes movement stutter and depend on keyboard settings.
    const keys = new Set<string>();
    const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    addEventListener('keydown', (e) => {
        if (MOVE_KEYS.has(e.code)) e.preventDefault();   // stop space/arrows scrolling
        keys.add(e.code);
    });
    addEventListener('keyup', (e) => keys.delete(e.code));

    const fwd = new THREE.Vector3();
    // const rgt = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const move = new THREE.Vector3();
    const offset = new THREE.Vector3();

    const TURN_RATE = 1.2;   // rad/s — 180° takes about 2.6s
    let turn = 0;   // -1 left, +1 right, 0 none — set by keys, used in fly()
    let bank = 0;   // current roll angle, in radians — updated in fly(), applied to craftTilt
    let clockT = 0;   // seconds, used to flash the strobe
    let throttle = 0;        // -1, 0 or +1 — fore/aft stick
    let heading = 0;         // the airframe's own facing, which LAGS the flight path
    const BANK_ANGLE = 0.42;      // ~24° at full deflection
    const BANK_RESPONSE = 5.0;    // roll reacts first...
    const HEADING_RESPONSE = 18.0; // ...and the nose follows
    let keyYaw = 0;           // radians the STICK turned us this frame
    let prevWant = 0;         // last frame's flight-path direction
    let orbitBank = 0;        // lean induced by dragging the camera
    const ORBIT_BANK = 0.15;  // radians of lean per rad/s of camera-induced turn

    function fly(dt: number) {
        const agility = 0.5 + 0.82 * Math.abs(throttle);
        // ── turning ──────────────────────────────────────────────────────
        // OrbitControls rewrites camera.quaternion from `target` on every update,
        // so yawing the camera directly gets thrown away. Swing the target around
        // the camera instead and the camera follows it.
        // let yaw = 0;
        // if (keys.has('KeyA') || keys.has('ArrowLeft')) yaw += TURN_RATE * dt;
        // if (keys.has('KeyD') || keys.has('ArrowRight')) yaw -= TURN_RATE * dt;

        turn = 0;
        if (keys.has('KeyA') || keys.has('ArrowLeft')) turn += 1;
        if (keys.has('KeyD') || keys.has('ArrowRight')) turn -= 1;
        // const yaw = turn * TURN_RATE * dt;
        throttle = 0;
        if (keys.has('KeyW') || keys.has('ArrowUp')) throttle += 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) throttle -= 1;

        // A helicopter carves a turn because it's moving. Yawing at full rate while
        // stationary is what makes it read as a turntable rather than an aircraft.
        // The 0.18 floor keeps a slow pedal turn available in the hover.
        // const agility = 0.18 + 0.82 * Math.abs(throttle);
        // const yaw = turn * TURN_RATE * agility * dt;

        // Roll FIRST. The stick commands a bank ANGLE, not a turn rate.
        // Negative because starboard is -X here, so a positive rotation.z would
        // tip the disc the wrong way.
        const targetBank = -turn * BANK_ANGLE * agility;
        bank += (targetBank - bank) * Math.min(1, dt * BANK_RESPONSE);

        // ...and the turn is a CONSEQUENCE of the bank, not a second thing running
        // alongside it. No bank, no turn — which is what makes the roll genuinely
        // lead instead of merely being eased at a different rate.
        // const yaw = (-bank / BANK_ANGLE) * TURN_RATE * agility * dt;
        keyYaw = (-bank / BANK_ANGLE) * TURN_RATE * agility * dt;

        // if (yaw !== 0) {
        if (keyYaw !== 0) {
            offset.subVectors(controls.target, camera.position);
            offset.applyAxisAngle(UP, keyYaw);          // rotate about world up
            controls.target.copy(camera.position).add(offset);
        }

        // ── movement ─────────────────────────────────────────────────────
        // Derive forward from target − position rather than getWorldDirection():
        // the camera's matrix is one frame stale until controls.update() runs, but
        // the target is current, so this stays in sync with the yaw above.
        fwd.subVectors(controls.target, camera.position);
        fwd.y = 0;
        fwd.normalize();
        // rgt.crossVectors(fwd, UP).normalize();

        move.set(0, 0, 0);
        // if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwd);
        // if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwd);
        if (throttle > 0) move.add(fwd);
        if (throttle < 0) move.sub(fwd);
        // if (keys.has('KeyE')) move.add(rgt);          // strafe, still handy
        // if (keys.has('KeyQ')) move.sub(rgt);
        if (keys.has('KeyE')) move.y += 1;
        if (keys.has('KeyQ')) move.y -= 1;
        if (keys.has('Space')) move.y += 1;
        if (keys.has('KeyC')) move.y -= 1;

        if (move.lengthSq() === 0) return;
        move.normalize().multiplyScalar((keys.has('ShiftLeft') ? 120 : 40) * dt);

        // Test where the step would LAND before committing it, and drop only the
        // offending axis — so you slide along the boundary instead of stopping dead.
        if (Math.abs(controls.target.x + move.x) > BOUND_X) move.x = 0;
        if (Math.abs(controls.target.z + move.z) > BOUND_Z) move.z = 0;
        if (controls.target.y + move.y > CEILING) move.y = 0;

        camera.position.add(move);
        controls.target.add(move);   // both, or the camera swings instead of moving
    }

    function flyCraft(dt: number) {
        // The craft lives at the orbit target, which fly() and clampToGround()
        // already move — so it inherits movement and terrain-following for free.
        craftRig.position.copy(controls.target);

        // The textbook heading formula: atan2(x, z) aligns an object's +Z with a
        // direction. It only works because we turned the nose onto +Z above.
        // craftRig.rotation.y = Math.atan2(fwd.x, fwd.z);
        // Ease the airframe toward the direction of travel rather than snapping to
        // it. The gap between the two IS the turn — the aircraft is briefly
        // pointing slightly out of its own flight path, which is what banking
        // through a turn looks like.
        const want = Math.atan2(fwd.x, fwd.z);
        // How far the flight path swung this frame, minus the part the stick caused.
        // Rotating the target around the camera (keys) and orbiting the camera around
        // the target (mouse) both change `want` by exactly their own angle — so
        // subtracting keyYaw leaves precisely the mouse's contribution.
        let dWant = want - prevWant;
        dWant = Math.atan2(Math.sin(dWant), Math.cos(dWant));   // same ±π wrap as below
        prevWant = want;
        const orbitRate = dt > 0 ? (dWant - keyYaw) / dt : 0;

        // Same sign convention as the stick: a left turn is a negative roll.
        const targetOrbitBank = THREE.MathUtils.clamp(
            -orbitRate * ORBIT_BANK, -BANK_ANGLE, BANK_ANGLE);
        orbitBank += (targetOrbitBank - orbitBank) * Math.min(1, dt * BANK_RESPONSE);
        // Wrap the difference into [-π, π]. Without this, a turn across the ±π
        // seam takes the long way round — a 350° spin instead of a 10° correction.
        let dHeading = want - heading;
        dHeading = Math.atan2(Math.sin(dHeading), Math.cos(dHeading));
        heading += dHeading * Math.min(1, dt * HEADING_RESPONSE);
        craftRig.rotation.y = heading;

        // Ease toward the target lean instead of snapping to it, or the aircraft
        // flicks to full bank the instant a key goes down.

        // const targetBank = turn * 0.35;                    // ~20° in a full turn
        // bank += (targetBank - bank) * Math.min(1, dt * 3);

        // BANK_RESPONSE > HEADING_RESPONSE is the whole fix: the roll gets there
        // first and the heading chases it.
        // const targetBank = turn * BANK_ANGLE;
        // bank += (targetBank - bank) * Math.min(1, dt * BANK_RESPONSE);

        craftTilt.rotation.z = bank + orbitBank;

        clockT += dt;
        // Real anti-collision beacons flash around 45/min. Just under 1 Hz reads as
        // "aircraft"; much faster reads as an alarm.
        strobe.material.opacity = (clockT % 1.4) < 0.12 ? 1 : 0;

        // Nose down a touch under power. Subtle on purpose — 3° reads as intent,
        // 15° reads as a crash.
        // const power = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
        // craftTilt.rotation.x += (power * 0.06 - craftTilt.rotation.x) * Math.min(1, dt * 2);

        // Nose down under power, nose up backing off — a tandem-rotor machine
        // pitches quite visibly, so this one's authentic rather than decorative.
        craftTilt.rotation.x += (throttle * 0.07 - craftTilt.rotation.x) * Math.min(1, dt * 2.5);

        hubs.forEach((h, i) => { h.rotation.y += dt * 8 * (i ? -1 : 1); });

        // A ±120 shadow box that covered a 186-unit map covers a ninth of a 558-unit
        // one. Move it with the aircraft rather than growing it — growing spreads the
        // same 2048 texels over 9× the area.
        sun.target.position.copy(controls.target);
        sun.position.copy(SUN_DIR).multiplyScalar(300).add(controls.target);
    }

    // ── ground clamp ─────────────────────────────────────────────────────
    const groundRay = new THREE.Raycaster();
    const DOWN = new THREE.Vector3(0, -1, 0);
    const probe = new THREE.Vector3();
    const CRAFT_CLEARANCE = 6;   // how high the aircraft flies above the ground
    const CAM_CLEARANCE = 4;     // how close the camera may get to the ground

    function groundAt(x: number, z: number): number | null {
        probe.set(x, 500, z);          // start above the terrain, always
        groundRay.set(probe, DOWN);
        const hit = groundRay.intersectObject(ground, false)[0];
        return hit ? hit.point.y : null;   // null = off the edge of the map
    }

    function clampToGround() {
        // The aircraft first. It's the thing being flown, so its altitude has to be
        // decided by the ground under IT — which is the bug you just found.
        const craftFloor = groundAt(controls.target.x, controls.target.z);
        if (craftFloor !== null && controls.target.y < craftFloor + CRAFT_CLEARANCE) {
            controls.target.y = craftFloor + CRAFT_CLEARANCE;
        }

        // The camera separately, against the ground under the camera.
        const camFloor = groundAt(camera.position.x, camera.position.z);
        if (camFloor !== null && camera.position.y < camFloor + CAM_CLEARANCE) {
            camera.position.y = camFloor + CAM_CLEARANCE;
        }
    }

    // Rotar movement
    const timer = new THREE.Timer();
    timer.connect(document);

    renderer.setAnimationLoop((t: any) => {
        timer.update(t);
        const dt = timer.getDelta();

        fly(dt);
        controls.update();
        clampToGround();
        flyCraft(dt);
        renderer.render(scene, camera);
    });
}

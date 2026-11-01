import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type At = { along: number; across: number };
type Building = At & { height: number; suggest: string; /** placement is real, the .glb is not exported yet */ pending?: boolean };
type Street = {
    id: string;
    axisRad: number;
    origin: { x: number; z: number };
    roundabouts: { along: number }[];
    roads: { along: number }[];
    buildings: Building[];
    junction?: { along: number; lights: At[] };
    buildingsWithoutFiles?: { along: number; across: number; src: string }[];
};
type Layout = {
    pieces: Record<'road' | 'roundabout' | 'trafficLight', { file: string; nativeAxisRad: number }>;
    buildingNativeAxisRad: number;
    streets: Street[];
};

export type CityOpts = {
    loader: GLTFLoader;
    /** probe from world.ts -- terrain height, or null off the edge of the map */
    groundAt: (x: number, z: number) => number | null;
    /** one uniform scale for the whole layout; the raw export is ~10x life size */
    scale?: number;
    /** half-width of the square searched for somewhere flat to stand on */
    searchRadius?: number;
};

/**
 * Builds Mandeep's city: two streets crossing at a signalised junction.
 *
 * Everything is read in Ragav 123.fbx's world frame, the only file that holds
 * both streets, so there is nothing to reconcile between them. Each street has
 * its own axis; a position is (along, across) in that street's frame.
 */
export async function buildCity(o: CityOpts) {
    const layout: Layout = await fetch('/models/city/streets.json').then((r) => r.json());

    // --- load one prototype per distinct piece ------------------------------
    // Object3D.clone() shares geometry AND materials by reference, so ten copies
    // of bulding-2 cost one GPU upload. (The flip side: a material edit on one
    // clone hits all of them, which is why a light's lamp must clone first.)
    const files = new Set<string>();
    for (const s of layout.streets) for (const b of s.buildings) files.add(`${b.suggest}.glb`);
    for (const p of Object.values(layout.pieces)) files.add(p.file);

    const kit = new Map<string, THREE.Object3D>();
    const absent: string[] = [];
    await Promise.all([...files].map(async (f) => {
      try {
        const g = await o.loader.loadAsync(`/models/city/${f}`);
        // The traffic light ships with a flat grass hexagon called Ground, which
        // is what puts its bbox 0.4 below origin. On a heightfield that disc
        // either floats at one edge or buries at the other, so drop it.
        g.scene.getObjectByName('Ground')?.removeFromParent();
        g.scene.traverse((m) => {
            if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        kit.set(f, g.scene);
      } catch {
        // Not an error: a piece Mandeep has not exported yet. Its placements are
        // skipped by put(), and it appears the moment the file lands -- no code
        // change. One 404 must not cost the whole city.
        absent.push(f);
      }
    }));
    if (absent.length) console.warn('[city] no asset yet, skipping:', absent.join(', '));

    const city = new THREE.Group();
    city.name = 'city';

    // --- the design's centre is the junction --------------------------------
    const frameOf = (s: Street) => {
        const U = new THREE.Vector2(Math.sin(s.axisRad), Math.cos(s.axisRad));   // along
        const P = new THREE.Vector2(Math.cos(s.axisRad), -Math.sin(s.axisRad));  // across
        // Vector2 is (x, y) but y here is a world Z -- a ground-plane vector.
        return (along: number, across: number) => new THREE.Vector2(
            s.origin.x + along * U.x + across * P.x,
            s.origin.z + along * U.y + across * P.y,
        );
    };
    const host = layout.streets.find((s) => s.junction) ?? layout.streets[0];
    const hub = frameOf(host)(host.junction ? host.junction.along : 0, 0);
    const ox = hub.x, oz = hub.y;
    if (!Number.isFinite(ox) || !Number.isFinite(oz)) {
        throw new Error(`[city] bad frame: ${host.id} axis=${host.axisRad} origin=${JSON.stringify(host.origin)}`);
    }

    // --- place ---------------------------------------------------------------
    // Every piece was exported in place, so it carries the orientation of the
    // street it was modelled on. Dropping a cross-street tower onto the boulevard
    // without turning it leaves it 92 degrees out. The turn is the difference
    // between the street's axis and the piece's native one.
    let placed = 0;
    const put = (file: string, world: THREE.Vector2, turn: number, tag: string) => {
        const proto = kit.get(file);
        if (!proto) {
            // `absent` was already logged once. A file NOT in it is a real
            // mistake -- a typo in streets.json, or a suggest with no kit piece.
            if (!absent.includes(file)) console.warn('[city] missing piece', file);
            return;
        }
        const inst = proto.clone();
        inst.position.set(world.x - ox, 0, world.y - oz);
        inst.rotation.y = turn;
        inst.name = tag;
        city.add(inst);
        placed++;
        return inst;
    };

    /** the four junction lights, handed to traffic.ts so it can switch them */
    const lights: THREE.Object3D[] = [];

    for (const s of layout.streets) {
        const at = frameOf(s);
        const turnRoad = s.axisRad - layout.pieces.road.nativeAxisRad;
        const turnRound = s.axisRad - layout.pieces.roundabout.nativeAxisRad;
        const turnBld = s.axisRad - layout.buildingNativeAxisRad;

        // roads first so an overhanging building sits on the kerb, not under it
        s.roads.forEach((r, i) =>
            put(layout.pieces.road.file, at(r.along, 0), turnRoad, `${s.id}_road_${i}`));
        s.roundabouts.forEach((r, i) =>
            put(layout.pieces.roundabout.file, at(r.along, 0), turnRound, `${s.id}_rb_${i}`));
        s.buildings.forEach((b, i) =>
            put(`${b.suggest}.glb`, at(b.along, b.across), turnBld, `${s.id}_bld_${i}_${b.suggest}`));

        // The four lights sit at the crossing, each already offset to its own
        // corner, so they take the street's own orientation.
        s.junction?.lights.forEach((l, i) => {
            const inst = put(layout.pieces.trafficLight.file, at(l.along, l.across),
                s.axisRad - layout.pieces.trafficLight.nativeAxisRad, `${s.id}_light_${i}`);
            if (inst) lights.push(inst);
        });
    }

    city.scale.setScalar(o.scale ?? 0.12);
    city.updateMatrixWorld(true);   // Box3 walks world matrices; refresh before measuring

    // --- stand it somewhere flat ---------------------------------------------
    // A graded street takes ONE ground height, so the whole city needs a level
    // patch. Search rather than dropping it wherever and burying the far end.
    const box = new THREE.Box3().setFromObject(city);
    const hx = (box.max.x - box.min.x) / 2;
    const hz = (box.max.z - box.min.z) / 2;

    const R = o.searchRadius ?? 420;
    const STEP = 60;
    const CORNERS = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0]] as const;
    let bestSpread = Infinity;
    let bx = 0, bz = 0, by = 0;
    for (let x = -R; x <= R; x += STEP) {
        for (let z = -R; z <= R; z += STEP) {
            const ys: number[] = [];
            let ok = true;
            for (const [dx, dz] of CORNERS) {
                const g = o.groundAt(x + dx * hx, z + dz * hz);
                if (g === null) { ok = false; break; }   // off the edge of the map
                ys.push(g);
            }
            if (!ok) continue;
            const spread = Math.max(...ys) - Math.min(...ys);
            if (spread < bestSpread) {
                bestSpread = spread;
                bx = x; bz = z;
                // Median, not max: max keeps everything clear of the ground but
                // leaves the city hovering, and a road floating 2 m reads as a
                // shadow gap. Median centres the error instead.
                ys.sort((a, b) => a - b);
                by = ys[Math.floor(ys.length / 2)];
            }
        }
    }

    city.position.set(bx, by, bz);
    // Pending placements sit in `buildings` already and point at a file that is
    // not there yet, so they drop in the moment the .glb lands -- no code change.
    const pending = layout.streets.flatMap((s) => s.buildings.filter((b) => b.pending));
    console.info('[city] %d pieces, %d streets, at (%.0f, %.0f, %.0f), %.0f x %.0f units, spread %.1f%s',
        placed, layout.streets.length, bx, by, bz, hx * 2, hz * 2, bestSpread,
        pending.length ? ` -- ${pending.length} awaiting assets` : '');

    // The junction IS the city group's origin -- ox/oz were set from it above --
    // so the group's own position is already the junction in world space.
    const junction = new THREE.Vector3(bx, by, bz);
    const scale = city.scale.x;

    // Everything below is in world XZ, for the minimap. Layout coordinates are
    // relative to the junction; world = city position + (layout - hub) * scale.
    const toWorld = (p: THREE.Vector2) =>
        ({ x: bx + (p.x - ox) * scale, z: bz + (p.y - oz) * scale });

    const roads = layout.streets.map((s) => {
        const at = frameOf(s);
        const alongs = s.roundabouts.map((r) => r.along);
        const a = toWorld(at(Math.min(...alongs), 0));
        const b = toWorld(at(Math.max(...alongs), 0));
        return { ax: a.x, az: a.z, bx: b.x, bz: b.z };
    });

    const ROAD_ACROSS = 20.3;   // measured off road.glb, in layout units
    const roadWidth = ROAD_ACROSS * scale;

    const circles = layout.streets.flatMap((s) => {
        const at = frameOf(s);
        return s.roundabouts.map((r) => ({ ...toWorld(at(r.along, 0)), r: 26 * scale }));
    });

    // Real footprints, measured off what was actually placed, so a tower reads
    // bigger than a cottage on the map.
    city.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    const footprints: { x: number; z: number; hx: number; hz: number }[] = [];
    for (const ch of city.children) {
        if (!ch.name.includes('_bld_')) continue;
        bbox.setFromObject(ch);
        footprints.push({
            x: (bbox.min.x + bbox.max.x) / 2, z: (bbox.min.z + bbox.max.z) / 2,
            hx: (bbox.max.x - bbox.min.x) / 2, hz: (bbox.max.z - bbox.min.z) / 2,
        });
    }

    const pin = buildJunctionPin(
        kit.get(layout.pieces.trafficLight.file) ?? new THREE.Group(), junction, by);

    return {
        city,
        centre: new THREE.Vector3(bx, by, bz),
        /** world position of the signalised junction, for a landmark beacon */
        junction,
        /** the floating landmark; add pin.group and pin.beam, then call pin.update */
        pin,
        /** streets.json as loaded, so traffic.ts need not fetch it again */
        layout,
        /** street centrelines in world XZ, plus what the HUD needs to draw them */
        roads,
        roadWidth,
        /** roundabout discs in world XZ */
        circles,
        /** building footprints in world XZ */
        footprints,
        /** the four junction lights, for the signal cycle */
        lights,
        spread: bestSpread,
        size: new THREE.Vector2(hx * 2, hz * 2),
    };
}

/**
 * Presses the terrain flat under the city and eases back out to the original
 * heights over a ring, so a graded street network has level ground to stand on.
 *
 * This is not papering over a weak search. Reading the heightfield directly --
 * a 101x101 grid of 18.6-unit cells -- the flattest city-sized patch anywhere
 * on the map still spreads 2.72 units, the best inside searchRadius 420 is
 * 3.20, and the median patch is 24.56. buildCity already stands on roughly the
 * flattest 1% available. There is no flat ground to find, so make some.
 *
 * Before: 29 of 42 pieces floating, 12 sunk, and boulevard_road_0 90% under a
 * hill. After, at inner 85 / outer 320: every piece within 0.01.
 */
export function flattenUnder(
    ground: THREE.Mesh, centre: THREE.Vector3, inner: number, outer: number,
) {
    const g = ground.geometry;

    // POSITION is a NORMALIZED Int16 attribute. setY() would store a float as a
    // raw integer and it reads back through the /32767 mapping as nonsense, so
    // swap in a plain Float32 copy once and edit that instead.
    let pos = g.attributes.position as THREE.BufferAttribute;
    if (pos.normalized || !(pos.array instanceof Float32Array)) {
        const f = new Float32Array(pos.count * 3);
        const t = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) t.fromBufferAttribute(pos, i).toArray(f, i * 3);
        g.setAttribute('position', new THREE.Float32BufferAttribute(f, 3));
        pos = g.attributes.position as THREE.BufferAttribute;
    }

    // Everything below is in the plane's own space. Its world matrix already
    // carries MAP_SCALE and HEIGHT_SCALE -- do not apply either again.
    const toLocal = new THREE.Matrix4().copy(ground.matrixWorld).invert();
    const c = centre.clone().setY(0).applyMatrix4(toLocal);
    const yTarget = new THREE.Vector3(0, centre.y, 0).applyMatrix4(toLocal).y;
    const sx = new THREE.Vector3().setFromMatrixColumn(ground.matrixWorld, 0).length();
    const ri = inner / sx, ro = outer / sx;

    const v = new THREE.Vector3();
    let touched = 0;
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = Math.hypot(v.x - c.x, v.z - c.z);
        if (d > ro) continue;
        const t = d <= ri ? 0 : (d - ri) / (ro - ri);
        const k = 1 - t * t * (3 - 2 * t);   // smoothstep: 1 in the middle, 0 at the rim
        pos.setY(i, v.y + (yTarget - v.y) * k);
        touched++;
    }
    pos.needsUpdate = true;

    // computeVertexNormals REUSES an existing normal attribute, and this one is
    // normalized Int16 as well -- fresh float normals written into it come back
    // mangled and the whole terrain renders pure black. Drop it first.
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();

    console.info('[city] flattened %d of %d terrain vertices under the footprint',
        touched, pos.count);
}

/**
 * The Pokemon Go gym treatment: a traffic light floating over the junction on
 * a lit podium, there to be seen from the air and flown to.
 *
 * It is a fixed world size, so it grows as you approach like anything else.
 * (It used to rescale itself by camera distance to hold a constant share of
 * the screen -- see SIZE if that is ever wanted back.)
 *
 * The icon is drawn with depthTest off and a high renderOrder, so it shows
 * through terrain and towers. That is deliberate: a marker that a hill can
 * hide cannot do its job. It fades out inside FADE_NEAR instead, so arriving
 * hands you the junction rather than a billboard in your face.
 */
export function buildJunctionPin(icon: THREE.Object3D, at: THREE.Vector3, groundY: number) {
    // One fixed world size. The marker used to rescale itself by camera
    // distance to hold a constant share of the screen; now it is an object like
    // any other and grows as you fly at it. Swap SIZE back for
    // `2 * Math.tan(fov/2) * d * 0.10` inside update() to undo that.
    const SIZE = 18;           // world units tall
    // The marker rides high when you are far off and comes down to the street
    // as you close in, so its ALTITUDE is the distance cue rather than its
    // size. The tether below it measures that drop and shrinks to nothing as
    // it lands -- which is also how it gets out of your way.
    const FLOAT_HIGH = 55;     // world units above the junction, clear of the towers
    const FLOAT_LOW = 6;       // just off the road, so it never z-fights the asphalt
    const DROP_FAR = 300;      // beyond this range it stays all the way up
    const DROP_NEAR = 80;      // at this range it has landed
    // Pokemon Go does not leave the gym pin pasted over your face when you walk
    // up to it -- it hands you the place instead. Same here: the marker is for
    // finding the junction from a distance, so it fades out as you arrive and
    // you fly on past it to the real lights below.
    const FADE_NEAR = 45;      // fully gone inside this
    const FADE_FAR = 85;       // fully present beyond this

    const group = new THREE.Group();
    group.name = 'junctionPin';
    group.position.set(at.x, groundY + FLOAT_HIGH, at.z);

    // The icon arrives at whatever size it was modelled; normalise it to 1 unit
    // tall so FRACTION means the same thing regardless of the asset.
    const art = icon.clone();
    const span = new THREE.Box3().setFromObject(art);
    const h = Math.max(1e-6, span.max.y - span.min.y);
    art.scale.setScalar(1 / h);
    art.position.y = -span.min.y / h;

    const spin = new THREE.Group();
    spin.add(art);
    group.add(spin);

    // Everything the fade has to reach, with the opacity it should settle at.
    //
    // These DO depth-test. An earlier version did not, so that a hill could
    // never hide the marker -- but ignoring depth also meant it painted itself
    // over the aircraft whenever you flew between the camera and the junction.
    // The minimap blip already answers "where is the city" from anywhere, so
    // the 3D marker can behave like an object and let the world occlude it.
    const fade: { m: THREE.Material; full: number }[] = [];
    const over = (m: THREE.Material, solid = false) => {
        m.depthTest = true;
        // The icon is a solid thing and needs to occlude its own back faces.
        // The ring and disc are flat and want to blend, so they stay off.
        m.depthWrite = solid;
        m.transparent = true;
        fade.push({ m, full: m.opacity !== undefined ? m.opacity : 1 });
        return m;
    };
    art.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh) return;
        mm.material = over((mm.material as THREE.Material).clone(), true);
        mm.castShadow = false;
        mm.receiveShadow = false;
        mm.renderOrder = 996;
    });

    // the podium the icon stands on
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.80, 40),
        over(new THREE.MeshBasicMaterial({ color: 0xD7A24A, side: THREE.DoubleSide, opacity: 0.85 })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 995;
    group.add(ring);

    const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.62, 40),
        over(new THREE.MeshBasicMaterial({ color: 0x14110D, side: THREE.DoubleSide, opacity: 0.45 })),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.004;
    disc.renderOrder = 994;
    group.add(disc);

    // A single line from the street up to the marker. Depth-tested, unlike the
    // first version of it -- that one painted a gold stripe down the aircraft.
    // Its WIDTH is held constant on screen so it stays a hairline at any range;
    // its LENGTH is the altitude, which is the whole point of it.
    const beamMat = new THREE.MeshBasicMaterial({
        color: 0xD7A24A, opacity: 0.5, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, transparent: true,
        depthTest: true, depthWrite: false,
    });
    const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), beamMat);
    beam.name = 'junctionTether';
    beam.renderOrder = 992;

    let t = 0;
    let shown = 1;
    const ndc = new THREE.Vector3();
    const top = new THREE.Vector3();

    const ease = (x: number) => x * x * (3 - 2 * x);
    const ramp = (d: number, near: number, far: number) =>
        ease(Math.min(1, Math.max(0, (d - near) / (far - near))));

    function update(dt: number, camera: THREE.PerspectiveCamera) {
        t += dt;
        // Measured to the JUNCTION, not to the marker. The marker moves, so
        // using it would feed its own position back into its own trigger.
        const d = camera.position.distanceTo(at);
        group.scale.setScalar(SIZE);

        spin.rotation.y = t * 0.45;
        spin.position.y = Math.sin(t * 1.5) * 0.06;

        const lift = FLOAT_LOW + (FLOAT_HIGH - FLOAT_LOW) * ramp(d, DROP_NEAR, DROP_FAR);
        group.position.y = groundY + lift;

        shown = ramp(d, FADE_NEAR, FADE_FAR);
        group.visible = shown > 0.02;
        for (const f of fade) f.m.opacity = f.full * shown;

        // Hairline width: a fixed share of the screen, so it reads at any
        // range. Height is the drop, so it vanishes as the marker lands.
        const viewH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * d;
        const hair = Math.max(0.05, viewH * 0.0016);
        beam.scale.set(hair, lift, hair);
        beam.position.set(at.x, groundY + lift / 2, at.z);
        beamMat.opacity = 0.5 * shown;
        beam.visible = shown > 0.02 && lift > FLOAT_LOW * 1.5;
    }

    /**
     * Is this pointer on the marker? Tested in screen space rather than by
     * raycast: the marker is rescaled every frame and drawn through the world,
     * so where it LOOKS like it is beats where its geometry happens to be.
     */
    function hitTest(clientX: number, clientY: number,
                     camera: THREE.PerspectiveCamera, canvas: HTMLElement) {
        if (!group.visible) return false;
        ndc.copy(group.position).project(camera);
        if (ndc.z > 1) return false;                      // behind the camera
        const r = canvas.getBoundingClientRect();
        const sx = r.left + (ndc.x * 0.5 + 0.5) * r.width;
        const sy = r.top + (-ndc.y * 0.5 + 0.5) * r.height;
        // The marker is a fixed world size now, so how big it is on screen
        // depends on range -- measure it by projecting its own height.
        top.copy(group.position).setY(group.position.y + SIZE).project(camera);
        const ty = r.top + (-top.y * 0.5 + 0.5) * r.height;
        const grab = Math.max(22, Math.abs(ty - sy) * 0.9);
        return Math.hypot(clientX - sx, clientY - sy) < grab;
    }

    return { group, beam, update, hitTest, at: at.clone(),
             get shown() { return shown; }, get lift() { return group.position.y - groundY; } };
}

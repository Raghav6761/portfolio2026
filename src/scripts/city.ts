import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type Slot = { x: number; z: number; baseY: number; footprint: [number, number]; height: number; suggest: string };
type Slots = {
    buildings: Slot[];
    roundabouts: { x: number; z: number; baseY: number; across: number }[];
    roadSegments: { x: number; z: number; baseY: number; size: [number, number] }[];
};

export type CityOpts = {
    loader: GLTFLoader;
    /** probe from world.ts -- returns terrain height, or null off the edge of the map */
    groundAt: (x: number, z: number) => number | null;
    /** one uniform scale for the whole arrangement; the raw export is ~10x life size */
    scale?: number;
    /** half-width of the square searched for somewhere flat enough to stand on */
    searchRadius?: number;
};

/**
 * Builds Mandeep's city from the kit plus the slot list read off his boulevard.
 *
 * The pieces each have their origin at the base centre, so placing one is just an
 * (x, z) -- no per-piece offset maths. The slot coordinates live in the boulevard's
 * own space, so they get recentred onto the group origin and the whole arrangement
 * is then positioned as a single object.
 */
export async function buildCity(o: CityOpts) {
    const slots: Slots = await fetch('/models/city/boulevard-slots.json').then((r) => r.json());

    // One load per distinct piece, cloned per instance. Object3D.clone() shares
    // geometry AND materials by reference, so eight copies of bulding-2 cost one
    // GPU upload rather than eight. (The flip side: a material edit on one clone
    // hits all of them -- which is why wireSignal() has to clone materials.)
    const need = [...new Set(slots.buildings.map((b) => b.suggest))].concat(['roundabout', 'road']);
    const kit = new Map<string, THREE.Object3D>();
    await Promise.all(need.map(async (n) => {
        const g = await o.loader.loadAsync(`/models/city/${n}.glb`);
        g.scene.traverse((m) => {
            if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        kit.set(n, g.scene);
    }));

    const city = new THREE.Group();
    city.name = 'city';

    const xs = slots.buildings.map((b) => b.x);
    const zs = slots.buildings.map((b) => b.z);
    const ox = (Math.min(...xs) + Math.max(...xs)) / 2;
    const oz = (Math.min(...zs) + Math.max(...zs)) / 2;

    const place = (piece: string, x: number, z: number, tag: string) => {
        const proto = kit.get(piece);
        if (!proto) { console.warn('[city] no kit piece named', piece); return; }
        const inst = proto.clone();
        // No rotation. The pieces were exported in place and already carry this
        // layout's orientation: PCA on road.glb's footprint gives a baked
        // direction of 107.6 deg against a boulevard axis of 107.66 deg.
        // Rotating them by the axis double-rotates and the roads disappear.
        inst.position.set(x - ox, 0, z - oz);
        inst.name = tag;
        city.add(inst);
        return inst;
    };

    // roads first, so a building that overhangs sits on top of the kerb rather than under it
    slots.roadSegments.forEach((s, i) => place('road', s.x, s.z, `road_${i}`));
    slots.roundabouts.forEach((s, i) => place('roundabout', s.x, s.z, `roundabout_${i}`));
    slots.buildings.forEach((b, i) => place(b.suggest, b.x, b.z, `bld_${i}_${b.suggest}`));

    city.scale.setScalar(o.scale ?? 0.12);
    city.updateMatrixWorld(true);

    // The baked baseY in the slot list is Mandeep's terrain, not ours, so it is
    // discarded. A boulevard is graded level, which means the whole city takes ONE
    // ground height -- so it needs somewhere flat. Search for the flattest spot
    // rather than dropping it wherever and letting the far end bury itself.
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
                // Median, not max. Max keeps everything clear of the ground but
                // leaves the whole city hovering (measured: +0.22 to +0.77 units,
                // and a road floating 2 m reads as a shadow gap). The median
                // centres the error instead: -0.36 to +0.19, median -0.18.
                ys.sort((a, b) => a - b);
                by = ys[Math.floor(ys.length / 2)];
            }
        }
    }

    city.position.set(bx, by, bz);
    console.info('[city] %d pieces at (%.0f, %.0f, %.0f), %.1f x %.1f units, ground spread %.1f',
        city.children.length, bx, by, bz, hx * 2, hz * 2, bestSpread);

    return { city, centre: new THREE.Vector3(bx, by, bz), spread: bestSpread,
             size: new THREE.Vector2(hx * 2, hz * 2) };
}

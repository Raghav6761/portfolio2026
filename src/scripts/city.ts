import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type Slot = { along: number; across: number; footprint: [number, number]; height: number; suggest: string; gap: number | null };
type Slots = {
    axisRad: number;
    origin: { x: number; z: number };
    spacing: number;
    buildings: Slot[];
    roundabouts: { along: number; across: number }[];
    roadSegments: { along: number; across: number }[];
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

    // The boulevard's own frame. Everything in the layout is regular in THIS basis
    // and looks like noise in XZ: roundabouts land at along = 0/230/460/690 with
    // across within 0.02 of the centreline, roads at the exact midpoints, and the
    // buildings in mirrored pairs.
    const AXIS = slots.axisRad;
    const U = new THREE.Vector2(Math.sin(AXIS), Math.cos(AXIS));  // along
    const P = new THREE.Vector2(Math.cos(AXIS), -Math.sin(AXIS));  // across
    const x0 = slots.origin.x, z0 = slots.origin.z;                              // along = across = 0

    const toAxis = (x: number, z: number) => {
        const dx = x - x0, dz = z - z0;
        return { along: dx * U.x + dz * U.y, across: dx * P.x + dz * P.y };
    };
    const toWorld = (along: number, across: number) => new THREE.Vector2(
        x0 + along * U.x + across * P.x,
        z0 + along * U.y + across * P.y,
    );

    // Centre the group on the middle of the boulevard rather than the mean of the
    // building positions -- the city's middle is a point on the road, not on a lawn.
    const mid = slots.spacing * (slots.roundabouts.length - 1) / 2;
    const centre = toWorld(mid, 0);
    const ox = centre.x, oz = centre.y;

    if (!Number.isFinite(ox) || !Number.isFinite(oz)) {
        throw new Error(`[city] bad frame: axis=${AXIS} origin=${x0},${z0}`);
    }

    const place = (piece: string, along: number, across: number, tag: string) => {
        const proto = kit.get(piece);
        if (!proto) { console.warn('[city] no kit piece named', piece); return; }
        const inst = proto.clone();
        // No rotation. The pieces were exported in place and already carry this
        // layout's orientation: PCA on road.glb's footprint gives a baked
        // direction of 107.6 deg against a boulevard axis of 107.66 deg.
        // Rotating them by the axis double-rotates and the roads disappear.
        const w = toWorld(along, across);
        inst.position.set(w.x - ox, 0, w.y - oz);
        inst.name = tag;
        city.add(inst);
        return inst;
    };

    // roads first, so a building that overhangs sits on top of the kerb rather than under it
    slots.roadSegments.forEach((s, i) => place('road', s.along, s.across, `road_${i}`));
    slots.roundabouts.forEach((s, i) => place('roundabout', s.along, s.across, `roundabout_${i}`));
    slots.buildings.forEach((b, i) => place(b.suggest, b.along, b.across, `bld_${i}_${b.suggest}`));

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

    return {
        city, centre: new THREE.Vector3(bx, by, bz), spread: bestSpread,
        size: new THREE.Vector2(hx * 2, hz * 2)
    };
}

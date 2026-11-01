import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Street = {
    id: string;
    axisRad: number;
    origin: { x: number; z: number };
    roundabouts: { along: number }[];
    junction?: { along: number; lights: { along: number; across: number }[] };
};
type Layout = { streets: Street[] };

export type TrafficOpts = {
    layout: Layout;
    /** the four placed traffic-light instances, so their lamps can be switched */
    lights: THREE.Object3D[];
    /** how many cars in total, split across every lane by length */
    cars?: number;
};

// --- dimensions -------------------------------------------------------------
// Everything here is in LAYOUT units, the same space streets.json uses, because
// the returned group is parented to the city group and inherits its scale. One
// layout unit is 0.2 world units, and a world unit is about 3 m -- so a layout
// unit is roughly 0.6 m. The road measures 20.3 across, which is two lanes.
const LANE = 5.0;           // lane centre, either side of the centreline
const CAR_LEN = 7.5;        // ~4.5 m
const CAR_WIDE = 3.0;       // ~1.8 m
const WHEEL_R = 0.9;
const CRUISE = 20;          // layout units/sec, about 40 km/h
const ACCEL = 26;           // and the same for braking, so stops look deliberate
const GAP = CAR_LEN * 2.1;  // headway a car keeps from the one in front
const STOP_AT = 30;         // distance from the junction centre to the stop line
const SPAWN_FADE = 14;      // scale ramp at each end, so cars grow in rather than pop

// India drives on the left, so a car keeps to the left of its own heading.
// In this frame P (across) is exactly the left of U (along), which makes the
// lane offset simply dir * LANE -- see the note on `across` below.
const LEFT_HAND_TRAFFIC = true;

const PHASES = [
    { green: 'boulevard', hold: 9.0 },
    { green: null, hold: 1.4 },      // all-red, long enough to clear the box
    { green: 'cross', hold: 7.0 },
    { green: null, hold: 1.4 },
] as const;

type Car = {
    street: Street;
    jAlong: number;       // where the junction sits on THIS street
    dir: 1 | -1;
    lo: number; hi: number;
    s: number;            // position along the street
    v: number;
};

/** One flat-shaded car, every part merged into a single geometry. */
function carGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
        const n = g.attributes.position.count;
        const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3));
        return g;
    };
    // The body is left white so instanceColor can tint it per car. Everything
    // else is painted near-black, which stays near-black whatever it is tinted
    // by -- that is the whole trick that keeps this to one draw call.
    const WHITE = new THREE.Color(0xffffff);
    const DARK = new THREE.Color(0x0e0e11);
    const GLASS = new THREE.Color(0x1b2430);

    const body = new THREE.BoxGeometry(CAR_WIDE, 1.6, CAR_LEN);
    body.translate(0, WHEEL_R + 0.8, 0);
    parts.push(paint(body, WHITE));

    const cabin = new THREE.BoxGeometry(CAR_WIDE * 0.86, 1.15, CAR_LEN * 0.42);
    cabin.translate(0, WHEEL_R + 2.1, -CAR_LEN * 0.04);
    parts.push(paint(cabin, GLASS));

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const w = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.7, 8);
        w.rotateZ(Math.PI / 2);
        w.translate(sx * (CAR_WIDE / 2 - 0.1), WHEEL_R, sz * CAR_LEN * 0.32);
        parts.push(paint(w, DARK));
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error('[traffic] could not merge the car geometry');
    for (const p of parts) p.dispose();
    return merged;
}

const PALETTE = [0xd7a24a, 0xb8c0c8, 0x8c3a2e, 0x2f4858, 0xe3ddd2,
                 0x3f6b52, 0x9a9ea6, 0x74301f, 0xc9ccd1, 0x1f2a36];

/**
 * Cars that drive the two streets and stop at the signalised junction.
 *
 * Each street is a straight line in its own (along, across) frame, which is the
 * same frame streets.json stores, so a car only ever needs one number -- how far
 * along it is. That is what makes car-following and a stop line cheap: both are
 * comparisons on a single scalar, not vector geometry.
 */
export function buildTraffic(o: TrafficOpts) {
    const group = new THREE.Group();
    group.name = 'traffic';

    const frameOf = (s: Street) => ({
        U: new THREE.Vector2(Math.sin(s.axisRad), Math.cos(s.axisRad)),
        P: new THREE.Vector2(Math.cos(s.axisRad), -Math.sin(s.axisRad)),
    });

    // The junction is stored on one street only, so find it in world terms once
    // and then ask every street where that lands on ITS axis.
    //
    // This point is also the city group's LOCAL ORIGIN -- city.ts subtracts it
    // from every piece it places. This group is a child of that one, so every
    // car position has to have it subtracted too, or the whole traffic system
    // sits (312.9, -274.1) away from the roads, out on the grass. Mirror the
    // fallback in city.ts exactly, including the no-junction case.
    const host = o.layout.streets.find((s) => s.junction) ?? o.layout.streets[0];
    let jx = 0, jz = 0;
    if (host) {
        const f = frameOf(host);
        const a = host.junction ? host.junction.along : 0;
        jx = host.origin.x + a * f.U.x;
        jz = host.origin.z + a * f.U.y;
    }
    const junctionOn = (s: Street) => {
        const f = frameOf(s);
        return (jx - s.origin.x) * f.U.x + (jz - s.origin.z) * f.U.y;
    };

    // --- lay out the cars ---------------------------------------------------
    const lanes: { street: Street; dir: 1 | -1; lo: number; hi: number; jAlong: number }[] = [];
    for (const s of o.layout.streets) {
        const alongs = s.roundabouts.map((r) => r.along);
        const lo = Math.min(...alongs), hi = Math.max(...alongs);
        if (!Number.isFinite(lo) || hi - lo < CAR_LEN * 4) continue;
        const jAlong = junctionOn(s);
        lanes.push({ street: s, dir: 1, lo, hi, jAlong });
        lanes.push({ street: s, dir: -1, lo, hi, jAlong });
    }

    const total = o.cars ?? 24;
    const totalLen = lanes.reduce((n, l) => n + (l.hi - l.lo), 0);
    const cars: Car[] = [];
    for (const l of lanes) {
        const share = Math.max(2, Math.round(total * (l.hi - l.lo) / totalLen));
        for (let i = 0; i < share; i++) {
            // spread them out, then jitter so they do not look like a parade
            const t = (i + Math.random() * 0.6) / share;
            cars.push({ street: l.street, jAlong: l.jAlong, dir: l.dir,
                        lo: l.lo, hi: l.hi, s: l.lo + t * (l.hi - l.lo), v: CRUISE });
        }
    }

    const geo = carGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geo, mat, cars.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // one mesh spanning the whole city; its own bounds lie
    const tint = new THREE.Color();
    cars.forEach((_, i) => mesh.setColorAt(i, tint.setHex(PALETTE[i % PALETTE.length])));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);

    // --- the lamps ----------------------------------------------------------
    // Object3D.clone() shares materials, so every light would change together.
    // Give each lamp mesh its own material before touching any of them.
    const lamps: THREE.MeshStandardMaterial[] = [];
    for (const lt of o.lights) {
        lt.traverse((m) => {
            const mm = m as THREE.Mesh;
            if (!mm.isMesh) return;
            const src = mm.material as THREE.MeshStandardMaterial;
            const own = src.clone();
            mm.material = own;
            lamps.push(own);
        });
    }
    const RED = new THREE.Color(0xff2a1f);
    const AMBER = new THREE.Color(0xffa42a);
    const GREEN = new THREE.Color(0x2aff5a);
    const setLamps = (c: THREE.Color, on: number) => {
        for (const m of lamps) { m.emissive.copy(c); m.emissiveIntensity = on; }
    };

    // --- per-frame ----------------------------------------------------------
    const dummy = new THREE.Object3D();
    let clock = 0;
    let phase = 0;

    function greenFor(): string | null {
        return PHASES[phase].green;
    }

    function update(dt: number) {
        if (!(dt > 0)) return;
        dt = Math.min(dt, 0.1);   // a backgrounded tab must not teleport the traffic

        clock += dt;
        while (clock > PHASES[phase].hold) {
            clock -= PHASES[phase].hold;
            phase = (phase + 1) % PHASES.length;
        }
        const green = greenFor();
        const amber = green === null;
        setLamps(amber ? AMBER : GREEN, amber ? 0.8 : 0.9);

        // Group by lane so a car can see the one ahead of it. Sorting by travel
        // order (not raw `s`) means the leader is always the next one in the list.
        const byLane = new Map<string, Car[]>();
        for (const c of cars) {
            const k = c.street.id + (c.dir > 0 ? '+' : '-');
            const arr = byLane.get(k); if (arr) arr.push(c); else byLane.set(k, [c]);
        }

        let i = 0;
        for (const [, lane] of byLane) {
            lane.sort((a, b) => (a.s - b.s) * a.dir);
            for (let k = 0; k < lane.length; k++) {
                const c = lane[k];
                const ahead = lane[(k + 1) % lane.length];

                let want = CRUISE;

                // the car in front -- wrap the gap, because the lane is a loop
                let gap = (ahead.s - c.s) * c.dir;
                if (gap < 0) gap += (c.hi - c.lo);
                if (lane.length > 1 && gap < GAP) want = Math.min(want, CRUISE * (gap / GAP) * 0.9);

                // the signal
                if (c.street.id !== green) {
                    const toLine = (c.jAlong - STOP_AT * c.dir - c.s) * c.dir;
                    if (toLine > -CAR_LEN && toLine < STOP_AT * 2.6) {
                        want = Math.min(want, Math.max(0, toLine * 0.9));
                    }
                }

                const d = want - c.v;
                c.v += Math.sign(d) * Math.min(Math.abs(d), ACCEL * dt);
                c.v = Math.max(0, c.v);
                c.s += c.v * c.dir * dt;

                // run off one end, reappear at the other
                const span = c.hi - c.lo;
                if (c.s > c.hi) c.s -= span;
                if (c.s < c.lo) c.s += span;

                const f = frameOf(c.street);
                // P is the LEFT of U, so dir * LANE puts a car on its own left.
                const across = (LEFT_HAND_TRAFFIC ? 1 : -1) * c.dir * LANE;
                dummy.position.set(
                    c.street.origin.x + c.s * f.U.x + across * f.P.x - jx,
                    0,
                    c.street.origin.z + c.s * f.U.y + across * f.P.y - jz,
                );
                dummy.rotation.set(0, c.dir > 0 ? c.street.axisRad : c.street.axisRad + Math.PI, 0);

                const edge = Math.min(c.s - c.lo, c.hi - c.s);
                const k2 = Math.min(1, Math.max(0, edge / SPAWN_FADE));
                dummy.scale.setScalar(k2 * k2 * (3 - 2 * k2));

                dummy.updateMatrix();
                mesh.setMatrixAt(i++, dummy.matrix);
            }
        }
        mesh.instanceMatrix.needsUpdate = true;
    }

    // start on a sensible frame rather than everything stacked at the origin
    update(0.016);

    return { group, update, cars: cars.length, get phase() { return PHASES[phase].green; } };
}

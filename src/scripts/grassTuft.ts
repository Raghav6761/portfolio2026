import * as THREE from 'three';

/**
 * Builds one grass tuft as raw geometry — no file, no texture, no alpha channel.
 * A blade is 5 triangles: a tapered strip that curves and narrows to a point.
 */
export function makeGrassTuft({
    blades = 6,
    height = 1.0,   // in world units — your terrain is 186 across, so scale accordingly
    width = 0.09,
    bend = 0.32,    // how far the tip leans from the base
} = {}) {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];

    // Colour lives in the geometry, so a tuft is dark at the root and bright at
    // the tip with no texture involved. Costs 3 floats per vertex.
    const BASE = new THREE.Color(0x35501c);
    const TIP = new THREE.Color(0x8fae4a);

    for (let b = 0; b < blades; b++) {
        const angle = (b / blades) * Math.PI * 2 + Math.random() * 0.6;  // spread, plus jitter
        const lean = bend * (0.5 + Math.random());
        const h = height * (0.65 + Math.random() * 0.6);
        const w = width * (0.8 + Math.random() * 0.5);
        const radius = 0.05 + Math.random() * 0.12;   // blades start slightly apart, not all at one point

        const ox = Math.cos(angle) * radius, oz = Math.sin(angle) * radius;
        const dx = Math.cos(angle), dz = Math.sin(angle);

        // Four heights up the blade. The x-offset uses t*t, not t — squaring makes
        // the blade CURVE (barely moves at the base, swings hard at the tip)
        // instead of tilting like a stiff stick.
        const levels = [0, 0.45, 0.78, 1.0];
        const widths = [1.0, 0.62, 0.3, 0.0];   // last is 0 → the tip is a point

        const ring = levels.map((t, i) => {
            const y = h * t;
            const off = lean * h * t * t;
            const cx = ox + dx * off;
            const cz = oz + dz * off;
            const hw = (w * widths[i]) / 2;
            // The blade's width runs perpendicular to the direction it leans:
            // (-dz, dx) is (dx, dz) rotated 90° in the XZ plane.
            return {
                l: new THREE.Vector3(cx - dz * hw, y, cz + dx * hw),
                r: new THREE.Vector3(cx + dz * hw, y, cz - dx * hw),
                t,
            };
        });

        const push = (v: THREE.Vector3, t: number) => {
            positions.push(v.x, v.y, v.z);

            // Normals point straight UP, not out of the blade's own face.
            // Lit by true face normals, grass flickers dark and bright as blades turn
            // and the field looks like confetti. Pointing them up makes every blade
            // take the same light as the ground beneath, so a field reads as one
            // surface. This is the standard trick and it is the single biggest
            // difference between grass that looks right and grass that doesn't.
            normals.push(0, 1, 0);

            const c = BASE.clone().lerp(TIP, t);
            colors.push(c.r, c.g, c.b);
        };

        // Two quads (2 triangles each) then a single triangle for the tip = 5.
        for (let i = 0; i < 3; i++) {
            const a = ring[i], c = ring[i + 1];
            if (i === 2) {
                push(a.l, a.t); push(a.r, a.t); push(c.l, c.t);           // tip
            } else {
                push(a.l, a.t); push(a.r, a.t); push(c.r, c.t);           // quad, half 1
                push(a.l, a.t); push(c.r, c.t); push(c.l, c.t);           // quad, half 2
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    // Non-indexed: every triangle carries its own vertices. Normally wasteful,
    // but at 90 vertices the index buffer would cost more than it saves.
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    return geo;
}

export function makeGrassMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        // A blade is a flat sheet with no thickness. Single-sided, you'd see
        // through every blade facing away from you — half the field would vanish.
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0,
    });
}
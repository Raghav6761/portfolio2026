import * as THREE from 'three';

export type MinimapOpts = {
    /** half-width of the terrain in world units -- the edge of the world */
    extent: number;
    /** half-width of the flyable box, drawn as the turn-back line */
    bound: { x: number; z: number };
    /** street centrelines in world XZ */
    roads: { ax: number; az: number; bx: number; bz: number }[];
    /** how wide to draw them, in world units */
    roadWidth: number;
    /** roundabout discs in world XZ */
    circles: { x: number; z: number; r: number }[];
    /** building footprints in world XZ */
    footprints: { x: number; z: number; hx: number; hz: number }[];
    /** the signalised junction, in world XZ */
    junction: { x: number; z: number } | null;
    /** diameter in CSS pixels */
    size?: number;
    /** world units from the centre to the rim -- the zoom */
    range?: number;
    /** true: the map turns so the nose is always up (GTA). false: north is up. */
    headingUp?: boolean;
};

const GOLD = '#D7A24A';
const INK = 'rgba(236,227,212,';

/**
 * A GTA-style radar: centred on the aircraft, zoomed in, and turning so the
 * nose is always up.
 *
 * The earlier version drew the whole 1860-unit terrain at once, which is why
 * the city came out about 7 px wide -- true, and useless. Showing a 250-unit
 * circle around the aircraft instead makes the streets and blocks legible, and
 * the city gets an edge blip so it is still findable when it is off the dial.
 *
 * Still flat vectors on a 2D canvas, so there is no second render pass. Set
 * headingUp:false for a fixed north-up dial.
 */
export function buildMinimap(o: MinimapOpts) {
    const size = o.size ?? 168;
    const range = o.range ?? 250;
    const headingUp = o.headingUp ?? true;

    const el = document.createElement('canvas');
    el.className = 'wmap';
    // Purely a readout. pointer-events:none matters: .wstick owns the left 44%
    // of the screen and the map sits over it, so taps must pass through or the
    // left thumb stops working wherever the two overlap.
    el.style.cssText = `position:fixed;z-index:25;pointer-events:none;
        left:max(12px,env(safe-area-inset-left,0px));
        top:calc(14px + env(safe-area-inset-top,0px));
        width:${size}px;height:${size}px;
        filter:drop-shadow(0 2px 10px rgba(0,0,0,.45))`;
    document.body.appendChild(el);

    const ctx = el.getContext('2d');
    if (!ctx) return { el, update: () => {}, dispose: () => el.remove() };
    const c = ctx;

    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        el.width = Math.round(size * dpr);
        el.height = Math.round(size * dpr);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const R = size / 2;
    const k = (R - 3) / range;      // world units -> map pixels

    const EVERY = 1 / 24;
    let acc = EVERY;

    function draw(px: number, pz: number, heading: number) {
        c.clearRect(0, 0, size, size);
        c.save();
        c.beginPath();
        c.arc(R, R, R - 2, 0, Math.PI * 2);
        c.clip();

        c.fillStyle = 'rgba(16,14,11,.82)';
        c.fillRect(0, 0, size, size);

        // World -> dial. Put the aircraft at the centre, turn the map under it,
        // then scale. Canvas rotates clockwise and up the dial is -Z, which is
        // why the heading goes in negated.
        c.save();
        c.translate(R, R);
        if (headingUp) c.rotate(-heading);
        c.scale(k, k);
        c.translate(-px, -pz);

        // the edge of the terrain, and the line the sim turns you back at
        c.lineWidth = 2 / k;
        c.strokeStyle = INK + '.14)';
        c.strokeRect(-o.extent, -o.extent, o.extent * 2, o.extent * 2);
        c.setLineDash([6 / k, 5 / k]);
        c.strokeStyle = INK + '.20)';
        c.strokeRect(-o.bound.x, -o.bound.z, o.bound.x * 2, o.bound.z * 2);
        c.setLineDash([]);

        // carriageways, drawn at their real width so they read as streets
        c.strokeStyle = 'rgba(214,206,192,.34)';
        c.lineWidth = o.roadWidth;
        c.lineCap = 'round';
        c.beginPath();
        for (const r of o.roads) { c.moveTo(r.ax, r.az); c.lineTo(r.bx, r.bz); }
        c.stroke();

        c.fillStyle = 'rgba(214,206,192,.34)';
        for (const d of o.circles) {
            c.beginPath(); c.arc(d.x, d.z, d.r, 0, Math.PI * 2); c.fill();
        }

        // blocks
        c.fillStyle = 'rgba(150,160,172,.50)';
        for (const b of o.footprints) {
            c.fillRect(b.x - b.hx, b.z - b.hz, b.hx * 2, b.hz * 2);
        }
        c.restore();

        // --- the junction blip, pinned to the rim when it is off the dial ---
        if (o.junction) {
            let dx = o.junction.x - px, dz = o.junction.z - pz;
            if (headingIsUp()) {
                const ca = Math.cos(-heading), sa = Math.sin(-heading);
                const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
                dx = rx; dz = rz;
            }
            const dist = Math.hypot(dx, dz);
            const inside = dist * k < R - 10;
            const s = inside ? k : (R - 10) / Math.max(dist, 1e-6);
            const jx = R + dx * s, jz = R + dz * s;

            c.strokeStyle = GOLD;
            c.lineWidth = 1.4;
            c.beginPath(); c.arc(jx, jz, inside ? 4.5 : 5.5, 0, Math.PI * 2); c.stroke();
            c.fillStyle = GOLD;
            c.beginPath(); c.arc(jx, jz, 2, 0, Math.PI * 2); c.fill();
            if (!inside) {
                // a tick pointing further out, so it reads as "keep going"
                const a = Math.atan2(dz, dx);
                c.beginPath();
                c.moveTo(jx + Math.cos(a) * 7, jz + Math.sin(a) * 7);
                c.lineTo(jx + Math.cos(a + 2.5) * 3.5, jz + Math.sin(a + 2.5) * 3.5);
                c.lineTo(jx + Math.cos(a - 2.5) * 3.5, jz + Math.sin(a - 2.5) * 3.5);
                c.closePath(); c.fill();
            }
        }

        // the aircraft, always dead centre
        c.save();
        c.translate(R, R);
        if (!headingUp) c.rotate(heading);
        c.fillStyle = GOLD;
        c.strokeStyle = 'rgba(20,17,13,.85)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(0, -7.5);
        c.lineTo(5.2, 6);
        c.lineTo(0, 3.2);
        c.lineTo(-5.2, 6);
        c.closePath();
        c.fill(); c.stroke();
        c.restore();

        c.restore();   // out of the clip

        // rim
        c.strokeStyle = INK + '.34)';
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.stroke();

        // north marker: fixed at the top on a north-up dial, orbiting the rim
        // on a heading-up one -- which is how you keep your bearings in GTA.
        const na = headingUp ? -heading - Math.PI / 2 : -Math.PI / 2;
        const nx = R + Math.cos(na) * (R - 9), ny = R + Math.sin(na) * (R - 9);
        c.fillStyle = INK + '.62)';
        c.font = '9px ui-monospace,"JetBrains Mono",monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('N', nx, ny);
    }

    function headingIsUp() { return headingUp; }

    /**
     * @param craft  where the aircraft is, in world space
     * @param facing direction of travel in world XZ; length ignored
     */
    function update(dt: number, craft: THREE.Vector3, facing: THREE.Vector3) {
        acc += dt;
        if (acc < EVERY) return;
        acc = 0;
        const h = (facing.x === 0 && facing.z === 0)
            ? 0 : Math.atan2(facing.x, -facing.z);
        draw(craft.x, craft.z, h);
    }

    function dispose() {
        window.removeEventListener('resize', resize);
        el.remove();
    }

    draw(0, 0, 0);
    return { el, update, dispose };
}

export type LandmarkProject = {
    title: string;
    domain: string;
    description: string;
    stack: string[];
};

export type LandmarkOpts = {
    project: LandmarkProject;
    /** which street id currently has green, or null during the all-red phase */
    phase: () => string | null;
    /**
     * The signals to list. `id` is the internal street id the phase reports;
     * `label` is what the reader sees. Keeping them apart means the card never
     * leaks an internal name like "boulevard" onto the screen.
     */
    signals: { id: string; label: string }[];
};

/**
 * The card that opens when you click the junction marker.
 *
 * Every word in it comes from src/content/projects/trafficlights.md via
 * world.astro -- nothing is written here. Edit the markdown and this changes
 * with it, the same single source the homepage reads.
 *
 * The signal diagram underneath is driven by the live phase of the city you
 * are looking at, not by any figure from the real system. It demonstrates the
 * idea -- a junction cycling under automatic control -- without putting a
 * number on the page that nobody can check. The project is client work, so it
 * is labelled as evidence of capability rather than as something owned.
 */
export function buildLandmarkCard(o: LandmarkOpts) {
    const el = document.createElement('aside');
    el.className = 'wcard';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <style>
        .wcard{position:fixed;z-index:40;left:50%;transform:translate(-50%,14px);
            bottom:max(18px,env(safe-area-inset-bottom,0px));
            width:min(420px,calc(100vw - 28px));
            background:rgba(20,17,13,.93);color:#ECE3D4;
            border:1px solid #322A1F;border-radius:6px;
            font-family:"Hanken Grotesk",system-ui,sans-serif;font-weight:300;
            box-shadow:0 10px 40px rgba(0,0,0,.5);
            opacity:0;pointer-events:none;transition:opacity .35s,transform .35s}
        .wcard.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
        @media (prefers-reduced-motion:reduce){.wcard{transition:none}}
        .wcard .pad{padding:16px 18px 15px}
        .wcard .eyebrow{display:flex;align-items:center;gap:8px;
            font-family:"JetBrains Mono",ui-monospace,monospace;
            font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#A2937D}
        .wcard .eyebrow b{color:#D7A24A;font-weight:500}
        .wcard h3{font-family:"Fraunces",Georgia,serif;font-weight:600;
            font-size:19px;margin:7px 0 0;letter-spacing:-.01em;color:#ECE3D4}
        .wcard p{margin:7px 0 0;font-size:13.5px;line-height:1.55;color:#C9BCA6}
        .wcard .stack{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
        .wcard .stack span{font-family:"JetBrains Mono",ui-monospace,monospace;
            font-size:10px;letter-spacing:.03em;color:#A2937D;
            border:1px solid #322A1F;border-radius:3px;padding:3px 7px}
        .wcard .sig{margin-top:13px;border-top:1px solid #322A1F;padding-top:11px}
        .wcard .sig .lab{display:flex;justify-content:space-between;align-items:baseline;
            font-family:"JetBrains Mono",ui-monospace,monospace;
            font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6E6352}
        .wcard .rows{margin-top:8px;display:flex;flex-direction:column;gap:6px}
        .wcard .row{display:flex;align-items:center;gap:9px;
            font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;color:#A2937D}
        .wcard .row .nm{flex:1;letter-spacing:.06em;text-transform:uppercase}
        .wcard .dot{width:8px;height:8px;border-radius:50%;background:#2A2218;
            border:1px solid #3A3020;transition:background .2s,box-shadow .2s}
        .wcard .dot.go{background:#2AFF5A;border-color:#2AFF5A;box-shadow:0 0 7px rgba(42,255,90,.6)}
        .wcard .dot.stop{background:#FF2A1F;border-color:#FF2A1F;box-shadow:0 0 7px rgba(255,42,31,.5)}
        .wcard .dot.wait{background:#FFA42A;border-color:#FFA42A;box-shadow:0 0 7px rgba(255,164,42,.5)}
        .wcard .foot{margin-top:10px;font-family:"JetBrains Mono",ui-monospace,monospace;
            font-size:9px;letter-spacing:.06em;color:#6E6352;line-height:1.5}
        .wcard .x{position:absolute;top:8px;right:9px;width:26px;height:26px;
            display:grid;place-items:center;border:0;border-radius:4px;cursor:pointer;
            background:transparent;color:#6E6352;font-size:16px;line-height:1;
            font-family:"JetBrains Mono",ui-monospace,monospace}
        .wcard .x:hover{color:#ECE3D4;background:#201B14}
        .wcard .x:focus-visible{outline:2px solid #D7A24A;outline-offset:1px}
      </style>
      <button class="x" type="button" aria-label="Close">&times;</button>
      <div class="pad">
        <div class="eyebrow"><b>${esc(o.project.domain)}</b><span>&middot;</span>
          <span>client work &mdash; proof of capability</span></div>
        <h3>${esc(o.project.title)}</h3>
        <p>${esc(o.project.description)}</p>
        <div class="stack">${o.project.stack.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
        <div class="sig">
          <div class="lab"><span>Junctions, cycling</span><span class="st">&mdash;</span></div>
          <div class="rows">${o.signals.map((g) => `
            <div class="row" data-street="${esc(g.id)}">
              <span class="dot"></span><span class="nm">${esc(g.label)}</span>
              <span class="gw">&mdash;</span>
            </div>`).join('')}</div>
          <p class="foot">Live state of the model city on screen &mdash; a demonstration of
             the idea, not data from the deployed system.</p>
        </div>
      </div>`;
    document.body.appendChild(el);

    const close = el.querySelector('.x') as HTMLButtonElement;
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.row'));
    const state = el.querySelector('.st') as HTMLElement;

    let open = false;
    let onClose: (() => void) | null = null;
    close.addEventListener('click', () => hide());

    // Clicks inside the card must not reach the canvas, or opening it would
    // immediately cancel the flight it was opened by.
    for (const t of ['pointerdown', 'pointerup', 'click'] as const) {
        el.addEventListener(t, (e) => e.stopPropagation());
    }

    function show(whenClosed?: () => void) {
        onClose = whenClosed ?? null;
        open = true;
        el.classList.add('on');
        el.setAttribute('aria-hidden', 'false');
    }

    function hide() {
        if (!open) return;
        open = false;
        el.classList.remove('on');
        el.setAttribute('aria-hidden', 'true');
        const f = onClose; onClose = null;
        if (f) f();
    }

    let last = '\u0000';
    function update() {
        if (!open) return;
        const green = o.phase();
        const key = String(green);
        if (key === last) return;      // only touch the DOM when it actually changes
        last = key;
        state.textContent = green ? 'auto' : 'all-red';
        for (const r of rows) {
            const dot = r.querySelector('.dot') as HTMLElement;
            const gw = r.querySelector('.gw') as HTMLElement;
            const mine = r.dataset.street === green;
            dot.className = 'dot ' + (green === null ? 'wait' : mine ? 'go' : 'stop');
            gw.textContent = green === null ? 'hold' : mine ? 'go' : 'stop';
        }
    }

    return { el, show, hide, update, get isOpen() { return open; } };
}

function esc(s: string) {
    return s.replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

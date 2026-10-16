/* MATTER//HUB web UI — vanilla JS, no dependencies. */

// ------------------------------------------------------------------ state

const state = {
    page: "dashboard",
    nodes: [],
    entities: {}, // nodeId → [entity]
    groups: [],
    automations: [],
    settings: { otbrHost: "localhost", otbrPort: 8081, bleEnabled: false },
    thread: null,
    discovered: [],
    scanning: false,
    commissioningFeed: [],
    log: [],
    drawerNodeId: null,
    windowInfo: null,
    sseConnected: false,
};

let renderScheduled = false;

const $page = document.getElementById("page");
const $title = document.getElementById("page-title");

// ------------------------------------------------------------------ utilities

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function api(path, body, method = "POST") {
    const response = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
    return data;
}

function toast(message, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = message;
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        render();
    });
}

function fmtTime(t) {
    return new Date(t).toLocaleTimeString([], { hour12: false });
}

function nodeById(id) {
    return state.nodes.find(n => n.id === id);
}

// centi-°C → display
function fmtTemp(c) {
    if (c === null || c === undefined) return "--";
    return (c / 100).toFixed(1);
}

// ------------------------------------------------------------------ SSE

function connectSse() {
    const es = new EventSource("/api/events");

    es.onopen = () => {
        state.sseConnected = true;
        updateStatusChips();
    };
    es.onerror = () => {
        state.sseConnected = false;
        updateStatusChips();
    };
    es.addEventListener("nodes", e => {
        state.nodes = JSON.parse(e.data).nodes;
        if (state.page === "dashboard" || state.page === "devices") scheduleRender();
    });
    es.addEventListener("entities", e => {
        const { nodeId, entities } = JSON.parse(e.data);
        state.entities[nodeId] = entities;
        if (state.page === "dashboard" || state.page === "devices") scheduleRender();
    });
    es.addEventListener("thread", e => {
        state.thread = JSON.parse(e.data).thread;
        updateStatusChips();
        updateThreadHint();
        if (state.page === "thread") scheduleRender();
    });
    es.addEventListener("commissioning", e => {
        const entry = JSON.parse(e.data);
        state.commissioningFeed.push({ t: Date.now(), ...entry });
        if (state.commissioningFeed.length > 200) state.commissioningFeed.shift();
        if (entry.phase === "done") toast(`Commissioned node ${entry.nodeId ?? ""}`, "ok");
        appendFeedLine(entry);
    });
    es.addEventListener("discovered", e => {
        state.discovered = JSON.parse(e.data).entries;
        updateScanList();
    });
    es.addEventListener("scan", e => {
        state.scanning = JSON.parse(e.data).running;
        updateScanButton();
    });
    es.addEventListener("groups", e => {
        state.groups = JSON.parse(e.data).groups;
        if (state.page === "groups") scheduleRender();
    });
    es.addEventListener("automations", e => {
        state.automations = JSON.parse(e.data).automations;
        if (state.page === "automations") scheduleRender();
    });
    es.addEventListener("log", e => {
        state.log.push(JSON.parse(e.data));
        if (state.log.length > 1000) state.log.shift();
        if (state.page === "log") appendLogLine(JSON.parse(e.data));
    });
}

function updateStatusChips() {
    const sseDot = document.getElementById("sse-dot");
    const sseLabel = document.getElementById("sse-label");
    sseDot.className = "dot " + (state.sseConnected ? "on" : "err");
    sseLabel.textContent = state.sseConnected ? "LINK ONLINE" : "LINK DOWN";

    const threadDot = document.getElementById("thread-dot");
    const threadLabel = document.getElementById("thread-label");
    const t = state.thread;
    if (t?.online) {
        threadDot.className = "dot on";
        threadLabel.textContent = `OTBR ${t.node?.networkName ?? "ONLINE"}`;
    } else if (t?.configured) {
        threadDot.className = "dot err";
        threadLabel.textContent = "OTBR OFFLINE";
    } else {
        threadDot.className = "dot warn";
        threadLabel.textContent = "OTBR UNCONFIGURED";
    }
}

/** Live-update the Thread hint on the commission page without re-rendering the form. */
function updateThreadHint() {
    const hint = document.getElementById("thread-hint");
    if (hint === null) return;
    const t = state.thread;
    hint.textContent =
        t?.online === true && t.dataset
            ? `dataset from OTBR: ${t.dataset.networkName} ch${t.dataset.channel}`
            : "OTBR dataset unavailable — will fail unless a manual dataset is provided";
}

function updateScanButton() {
    const button = document.getElementById("scan-start");
    if (button === null) return;
    button.disabled = state.scanning;
    button.textContent = state.scanning ? "SCANNING…" : "SCAN";
    for (const candidate of document.querySelectorAll("[data-commission-discovered]")) {
        candidate.disabled = state.scanning;
    }
}

function updateScanList() {
    const list = document.getElementById("scan-list");
    if (list === null) return;
    list.innerHTML = state.discovered.length > 0 ? scanListHtml() : "";
}

function appendFeedLine(entry) {
    const feed = document.getElementById("commission-feed");
    if (feed === null) return;
    if (feed.querySelector(".faint")) feed.innerHTML = "";
    const cls = entry.phase === "error" ? "err" : entry.phase === "done" ? "ok" : "";
    feed.insertAdjacentHTML(
        "beforeend",
        `<div class="pf-line">
            <span class="pf-time">${fmtTime(entry.t ?? Date.now())}</span>
            <span class="pf-phase ${cls}">${esc(entry.phase).toUpperCase()}</span>
            <span>${esc(entry.message)}</span>
        </div>`,
    );
    feed.scrollTop = feed.scrollHeight;
}

// ------------------------------------------------------------------ router

const PAGES = {
    dashboard: "DASHBOARD",
    devices: "DEVICES",
    groups: "GROUPS",
    automations: "AUTOMATIONS",
    commission: "COMMISSION",
    thread: "THREAD",
    settings: "SETTINGS",
    log: "LOG",
};

function currentPage() {
    const hash = location.hash.replace(/^#\//, "");
    return PAGES[hash] !== undefined ? hash : "dashboard";
}

function render() {
    state.page = currentPage();
    for (const link of document.querySelectorAll("#nav a")) {
        link.classList.toggle("active", link.dataset.page === state.page);
    }
    $title.textContent = PAGES[state.page];

    switch (state.page) {
        case "dashboard":
            $page.innerHTML = renderDashboard();
            break;
        case "devices":
            $page.innerHTML = renderDevices();
            renderDrawer();
            break;
        case "groups":
            $page.innerHTML = renderGroups();
            break;
        case "automations":
            $page.innerHTML = renderAutomations();
            rebuildTriggerMode();
            rebuildTriggerFields();
            rebuildActionOptions();
            break;
        case "commission":
            $page.innerHTML = renderCommission();
            break;
        case "thread":
            $page.innerHTML = renderThread();
            break;
        case "settings":
            $page.innerHTML = renderSettings();
            break;
        case "log":
            $page.innerHTML = renderLog();
            const view = document.getElementById("log-view");
            if (view) view.scrollTop = view.scrollHeight;
            break;
    }
}

// ------------------------------------------------------------------ dashboard

function renderDashboard() {
    if (state.nodes.length === 0) {
        return `<div class="empty-state">
            NO COMMISSIONED DEVICES<br><br>
            <a href="#/commission">→ GO TO COMMISSIONING</a>
        </div>`;
    }

    const cards = [];
    for (const node of state.nodes) {
        for (const entity of state.entities[node.id] ?? []) {
            cards.push(entityCard(entity));
        }
    }
    if (cards.length === 0) {
        return `<div class="empty-state">NO ENTITY DATA YET — DEVICES MAY STILL BE CONNECTING</div>`;
    }
    return `<div class="entity-grid">${cards.join("")}</div>`;
}

function entityCard(entity) {
    const kindClass = `k-${entity.kind}`;
    const node = nodeById(entity.nodeId);
    const connDot = node === undefined ? "warn" : node.connected ? "on" : node.online ? "warn" : "err";
    // Single-entity nodes (one bulb per node, the usual case) take the node's name as title.
    const title = node !== undefined && (state.entities[entity.nodeId] ?? []).length === 1
        ? node.label
        : entity.label;
    const head = `<div class="entity-head">
        <span class="entity-name">${esc(title)}</span>
        <span class="entity-kind">${esc(entity.kind).toUpperCase()}</span>
    </div>
    ${node !== undefined ? `<div class="entity-node"><span class="dot ${connDot}"></span> ${esc(node.connectionState).toUpperCase()}</div>` : ""}`;

    let body = "";
    switch (entity.kind) {
        case "light":
        case "plug":
            body = toggleBody(entity) + dimmerBody(entity) + colorBody(entity);
            break;
        case "lock":
            body = lockBody(entity);
            break;
        case "thermostat":
            body = thermostatBody(entity);
            break;
        case "cover":
            body = coverBody(entity);
            break;
        case "fan":
            body = fanBody(entity);
            break;
        default:
            body = sensorBody(entity);
    }
    return `<div class="entity-card ${kindClass}" data-entity="${esc(entity.key)}">${head}${body}</div>`;
}

function toggleBody(entity) {
    const on = entity.state.on === true;
    return `<div class="toggle-row">
        <button class="toggle-btn ${on ? "on" : ""}" title="toggle"
            data-cmd="toggle" data-entity="${esc(entity.key)}"></button>
        <span class="toggle-state">${on ? "ON" : "OFF"}</span>
    </div>`;
}

function dimmerBody(entity) {
    if (!entity.features?.level) return "";
    const brightness = entity.state.brightness;
    const pct = brightness === null || brightness === undefined ? null : Math.round((brightness / 254) * 100);
    return `<div class="entity-controls">
        <div class="control-label"><span>LEVEL</span><span data-brightness-label>${pct ?? "--"}%</span></div>
        <input type="range" min="0" max="254" step="1" value="${brightness ?? 0}"
            data-cmd="level" data-entity="${esc(entity.key)}" ${brightness === null ? "disabled" : ""} />
    </div>`;
}

function colorBody(entity) {
    const parts = [];
    if (entity.features?.color) {
        const hex = hueSatToHex(effectiveHue(entity.state), effectiveSaturation(entity.state));
        parts.push(`<input type="color" value="${hex}" data-cmd="hueSat" data-entity="${esc(entity.key)}" title="color" />`);
    }
    if (entity.features?.colorTemp && entity.state.colorTempRange) {
        const [minM, maxM] = entity.state.colorTempRange;
        if (entity.state.colorTempMireds !== null && entity.state.colorTempMireds !== undefined) {
            ctOverrides.delete(entity.key);
        }
        const mireds = entity.state.colorTempMireds ?? ctOverrides.get(entity.key) ?? Math.round((minM + maxM) / 2);
        const kelvin = Math.round(miredsToKelvin(mireds) / 25) * 25;
        const kMin = Math.round(1e6 / maxM);
        const kMax = Math.round(1e6 / minM);
        const pct = ((kelvin - kMin) / (kMax - kMin)) * 100;
        parts.push(`<div class="control-label"><span>CT ${kelvin}K</span><span></span></div>
            <div class="ct-track" data-entity="${esc(entity.key)}" data-min="${kMin}" data-max="${kMax}" data-step="25">
                <div class="ct-thumb" style="left:${pct}%"></div>
            </div>`);
    }
    return parts.length > 0 ? `<div class="entity-controls">${parts.join("")}</div>` : "";
}

function lockBody(entity) {
    const s = entity.state.lockState;
    const label = s === 1 ? "LOCKED" : s === 2 ? "UNLOCKED" : s === 0 ? "NOT FULLY" : s === null || s === undefined ? "--" : String(s).toUpperCase();
    const cls = s === 1 ? "locked" : s === 2 ? "unlocked" : "";
    return `<div class="lock-state ${cls}">${label}</div>
    <div class="btn-row">
        <button class="ghost" data-cmd="lock" data-entity="${esc(entity.key)}">LOCK</button>
        <button class="ghost" data-cmd="unlock" data-entity="${esc(entity.key)}">UNLOCK</button>
    </div>`;
}

function thermostatBody(entity) {
    const s = entity.state;
    const mode = s.systemMode ?? "";
    const modes = `<select class="mode-select" data-cmd="mode" data-entity="${esc(entity.key)}">
        <option value="0" ${mode === 0 ? "selected" : ""}>OFF</option>
        <option value="4" ${mode === 4 ? "selected" : ""}>HEAT</option>
        <option value="3" ${mode === 3 ? "selected" : ""}>COOL</option>
        <option value="1" ${mode === 1 ? "selected" : ""}>AUTO</option>
        <option value="7" ${mode === 7 ? "selected" : ""}>FAN</option>
    </select>`;
    return `<div class="entity-value">${fmtTemp(s.localTemperature)}<span class="unit">°C LOCAL</span></div>
    <div class="setpoint-row">
        <button class="ghost" data-cmd="setpoint-dn" data-entity="${esc(entity.key)}">−</button>
        <div class="setpoint-display">${fmtTemp(s.occupiedHeatingSetpoint)}<span class="unit">°C SET</span></div>
        <button class="ghost" data-cmd="setpoint-up" data-entity="${esc(entity.key)}">+</button>
    </div>
    ${modes}`;
}

function coverBody(entity) {
    const pos = entity.state.position;
    const target = entity.state.target;
    return `<div class="entity-value">${pos ?? "--"}<span class="unit">% ${target !== null && target !== undefined ? `→ ${target}` : ""}</span></div>
    <input type="range" min="0" max="100" step="1" value="${pos ?? 0}"
        data-cmd="position" data-entity="${esc(entity.key)}" />
    <div class="btn-row">
        <button class="ghost" data-cmd="cover-open" data-entity="${esc(entity.key)}">OPEN</button>
        <button class="ghost" data-cmd="cover-close" data-entity="${esc(entity.key)}">CLOSE</button>
    </div>`;
}

function fanBody(entity) {
    const setting = entity.state.percentSetting ?? entity.state.percentCurrent ?? 0;
    return `<div class="entity-value">${setting}<span class="unit">%</span></div>
    <input type="range" min="0" max="100" step="1" value="${setting}"
        data-cmd="fan" data-entity="${esc(entity.key)}" />`;
}

const SENSOR_UNITS = {
    temperature: "°C",
    humidity: "%RH",
    pressure: "kPa",
    illuminance: "lx",
    flow: "m³/h",
};

const SENSOR_BOOL = {
    occupancy: v => (v ? "OCCUPIED" : "CLEAR"),
    contact: v => (v ? "CLOSED" : "OPEN"),
};

function sensorBody(entity) {
    if (SENSOR_BOOL[entity.kind] !== undefined) {
        const label = SENSOR_BOOL[entity.kind](entity.state.value);
        return `<div class="entity-value" style="font-size:22px">${label}</div>`;
    }
    if (entity.kind === "power") {
        const p = entity.state.activePower;
        const v = entity.state.voltage;
        const parts = [];
        if (p !== null && p !== undefined) parts.push(`${(p / 1000).toFixed(1)}<span class="unit">W</span>`);
        if (v !== null && v !== undefined) parts.push(`${(v / 1000).toFixed(0)}<span class="unit">V</span>`);
        return `<div class="entity-value">${parts.join(" ") || "--"}</div>`;
    }
    if (entity.kind === "energy") {
        const wh = entity.state.cumulativeImported;
        return `<div class="entity-value">${wh === null || wh === undefined ? "--" : (wh / 1e6).toFixed(2)}<span class="unit">kWh</span></div>`;
    }
    const value = entity.state.value;
    return `<div class="entity-value">${value ?? "--"}<span class="unit">${SENSOR_UNITS[entity.kind] ?? ""}</span></div>`;
}

/** Enhanced hue (0-65535) fallback for devices that only report it. */
function effectiveHue(state) {
    if (state.hue !== undefined && state.hue !== null) return state.hue;
    if (state.enhancedHue !== undefined && state.enhancedHue !== null) return Math.round(state.enhancedHue / 257);
    return null;
}

function effectiveSaturation(state) {
    return state.saturation ?? null;
}

function hueSatToHex(hue, saturation) {
    // Matter hue 0-254 / saturation 0-254 → #rrggbb
    if (hue === null || hue === undefined || saturation === null || saturation === undefined) return "#ffffff";
    const h = (hue / 254) * 360;
    const s = saturation / 254;
    const l = 0.5;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const to2 = n => Math.round((n + m) * 255).toString(16).padStart(2, "0");
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function hexToHueSat(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    const d = max - min;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: Math.round(s * 100) };
}

function miredsToKelvin(m) {
    if (m === null || m === undefined || m === 0) return null;
    return 1e6 / m;
}

function findEntity(key) {
    const [nodeId, endpointId, kind] = key.split("/");
    return (state.entities[nodeId] ?? []).find(e => e.endpointId === Number(endpointId) && e.kind === kind);
}

// Bulbs that report currentColorTempMireds as null never confirm a commanded CT;
// the last commanded value is kept here so the slider does not snap back to the middle.
const ctOverrides = new Map();

async function sendCommand(entityKey, action, value) {
    const entity = findEntity(entityKey);
    if (!entity) return;
    try {
        await api("/api/command", { nodeId: entity.nodeId, endpointId: entity.endpointId, action, value });
    } catch (error) {
        toast(`${action}: ${error.message}`, "err");
    }
}

// ------------------------------------------------------------------ groups + automations

function allEntities() {
    const out = [];
    for (const node of state.nodes) {
        for (const entity of state.entities[node.id] ?? []) out.push(entity);
    }
    return out;
}

function entityDisplayName(entity) {
    if (entity === undefined || entity === null) return "unknown entity";
    const node = nodeById(entity.nodeId);
    return `${node ? node.label : entity.nodeId} — ${entity.label}`;
}

async function sendGroupCommand(groupId, action, value) {
    try {
        const result = await api(`/api/groups/${encodeURIComponent(groupId)}/command`, { action, value });
        toast(`${action} → ${result.applied} member(s)`, "ok");
    } catch (error) {
        toast(`${action}: ${error.message}`, "err");
    }
}

function renderGroups() {
    const lightish = allEntities().filter(e => e.kind === "light" || e.kind === "plug");
    const memberOptions = lightish
        .map(e => `<label class="member-row">
            <input type="checkbox" data-group-member="${esc(e.key)}" />
            <span>${esc(entityDisplayName(e))}</span>
        </label>`)
        .join("");

    const cards = state.groups
        .map(group => {
            const members = group.entityKeys.map(key => findEntity(key)).filter(Boolean);
            const allOn = members.length > 0 && members.every(m => m.state.on === true);
            const anyLevel = members.some(m => m.features?.level);
            const anyColor = members.some(m => m.features?.color);
            const tempMember = members.find(m => m.features?.colorTemp && m.state.colorTempRange);
            const tempRange = tempMember?.state.colorTempRange ?? [147, 500];
            const groupTempMireds = tempMember?.state.colorTempMireds
                ?? ctOverrides.get(`group:${group.id}`)
                ?? Math.round((tempRange[0] + tempRange[1]) / 2);
            const groupTempKelvin = Math.round(1e6 / groupTempMireds / 25) * 25;

            const editRows = lightish
                .map(e => `<label class="member-row">
                    <input type="checkbox" data-edit-member="${esc(e.key)}" ${group.entityKeys.includes(e.key) ? "checked" : ""} />
                    <span>${esc(entityDisplayName(e))}</span>
                </label>`)
                .join("");

            return `<div class="panel group-card" style="padding:14px" data-group-id="${esc(group.id)}">
                <div class="panel-title">
                    <span>${esc(group.name).toUpperCase()}</span>
                    <span class="faint">${members.length}/${group.entityKeys.length} ONLINE</span>
                </div>
                <div class="panel-body">
                    <div class="chip-row">
                        ${members.map(m => `<span class="chip">${esc(entityDisplayName(m))}</span>`).join("")}
                    </div>
                    <div class="toggle-row">
                        <button class="toggle-btn ${allOn ? "on" : ""}" data-group-cmd="toggle" data-group="${esc(group.id)}"></button>
                        <span class="toggle-state">${allOn ? "ON" : "OFF"}</span>
                        <div class="btn-row" style="margin-left:auto">
                            <button class="ghost" data-group-cmd="on" data-group="${esc(group.id)}">ON</button>
                            <button class="ghost" data-group-cmd="off" data-group="${esc(group.id)}">OFF</button>
                        </div>
                    </div>
                    ${anyLevel ? `<div class="entity-controls">
                        <div class="control-label"><span>LEVEL (ALL)</span><span></span></div>
                        <input type="range" min="0" max="254" step="1" value="${members.find(m => m.state.brightness !== null && m.state.brightness !== undefined)?.state.brightness ?? 254}"
                            data-group-cmd="level" data-group="${esc(group.id)}" />
                    </div>` : ""}
                    ${anyColor ? `<div class="entity-controls">
                        <input type="color" value="${hueSatToHex(effectiveHue(members[0].state), effectiveSaturation(members[0].state))}"
                            data-group-cmd="hueSat" data-group="${esc(group.id)}" title="color" />
                    </div>` : ""}
                    ${tempMember !== undefined ? `<div class="entity-controls">
                        <div class="control-label"><span>CT (ALL)</span><span></span></div>
                        <div class="ct-track" data-group="${esc(group.id)}" data-min="${Math.round(1e6 / tempRange[1])}" data-max="${Math.round(1e6 / tempRange[0])}" data-step="25">
                            <div class="ct-thumb" style="left:${((groupTempKelvin - Math.round(1e6 / tempRange[1])) / (Math.round(1e6 / tempRange[0]) - Math.round(1e6 / tempRange[1]))) * 100}%"></div>
                        </div>
                    </div>` : ""}
                    <details class="group-editor">
                        <summary class="dim">EDIT NAME / MEMBERS</summary>
                        <label class="field" style="margin-top:10px">
                            <span class="field-label">NAME</span>
                            <input type="text" data-edit-name="${esc(group.id)}" value="${esc(group.name)}" />
                        </label>
                        <div class="member-list">${editRows}</div>
                        <button data-group-save="${esc(group.id)}" style="margin-top:10px">SAVE GROUP</button>
                    </details>
                    <div class="btn-row">
                        <button class="ghost danger" data-group-delete="${esc(group.id)}">DELETE GROUP</button>
                    </div>
                </div>
            </div>`;
        })
        .join("");

    return `<div class="two-col">
        <div class="panel">
            <div class="panel-title"><span>NEW GROUP</span></div>
            <div class="panel-body">
                <label class="field">
                    <span class="field-label">NAME</span>
                    <input type="text" id="new-group-name" placeholder="ceiling lights" />
                </label>
                <div class="control-label" style="margin:10px 0 6px"><span>MEMBERS</span><span></span></div>
                <div class="member-list">${memberOptions || '<span class="dim">no lights or plugs commissioned yet</span>'}</div>
                <button data-add-group style="width:100%;margin-top:12px">CREATE GROUP</button>
            </div>
        </div>
        <div>${cards || '<div class="empty-state">NO GROUPS — group lights to control them as one</div>'}</div>
    </div>`;
}

const TRIGGER_FIELDS = {
    light: [["on", "on/off"], ["brightness", "brightness (0-254)"], ["colorTempMireds", "color temp (mireds)"]],
    plug: [["on", "on/off"], ["brightness", "brightness (0-254)"]],
    lock: [["lockState", "lock state (1 locked, 2 unlocked)"]],
    cover: [["position", "position %"]],
    fan: [["percentCurrent", "speed %"]],
    thermostat: [["localTemperature", "temperature (centi-°C, 2100 = 21.0°)"]],
    contact: [["value", "state"]],
    occupancy: [["value", "occupied"]],
    power: [["activePower", "power (mW)"]],
};

const ACTION_OPTIONS = {
    light: [["on", "turn on"], ["off", "turn off"], ["toggle", "toggle"], ["level", "set level (0-254)"], ["hueSat", "set color"], ["colorTemp", "set color temp (mireds)"]],
    plug: [["on", "turn on"], ["off", "turn off"], ["toggle", "toggle"], ["level", "set level (0-254)"]],
    lock: [["lock", "lock"], ["unlock", "unlock"]],
    cover: [["position", "set position (0-100)"]],
    fan: [["fan", "set speed (0-100)"]],
    thermostat: [["setpoint", "set heating setpoint (°C)"]],
};

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function triggerFieldsFor(kind) {
    return TRIGGER_FIELDS[kind] ?? [["value", "value"]];
}

function isBooleanField(kind, field) {
    if (field === "on") return true;
    if (field === "value" && (kind === "contact" || kind === "occupancy")) return true;
    return false;
}

function renderAutomations() {
    const triggerEntities = allEntities();
    const actionEntities = triggerEntities.filter(e => ACTION_OPTIONS[e.kind] !== undefined);
    const entityOptions = entities => entities
        .map(e => `<option value="${esc(e.key)}">${esc(entityDisplayName(e))}</option>`)
        .join("");

    const cards = state.automations
        .map(a => {
            const actionEntity = findEntity(a.action.key);
            return `<div class="panel ${a.enabled === true ? "" : "disabled-card"}" style="padding:14px">
                <div class="panel-title">
                    <span>${esc(a.name).toUpperCase()}</span>
                    <span class="faint">${a.enabled === true ? "ENABLED" : "DISABLED"}</span>
                </div>
                <div class="panel-body">
                    <div class="automation-line">${automationTriggerLine(a)}</div>
                    <div class="automation-line">
                        <span class="auto-key">THEN</span> ${esc(entityDisplayName(actionEntity))}
                        <span class="auto-key">${esc(a.action.action)}</span>
                        ${a.action.value !== undefined && a.action.value !== null ? `<span class="auto-val">${esc(formatAutomationValue(a.action.action, a.action.value))}</span>` : ""}
                    </div>
                    <div class="btn-row" style="margin-top:10px">
                        <button class="ghost" data-automation-toggle="${esc(a.id)}">${a.enabled === true ? "DISABLE" : "ENABLE"}</button>
                        <button class="ghost" data-automation-run="${esc(a.id)}">RUN NOW</button>
                        <button class="ghost danger" data-automation-delete="${esc(a.id)}">DELETE</button>
                    </div>
                </div>
            </div>`;
        })
        .join("");

    return `<div class="two-col">
        <div class="panel">
            <div class="panel-title"><span>NEW AUTOMATION</span></div>
            <div class="panel-body">
                <label class="field">
                    <span class="field-label">NAME</span>
                    <input type="text" id="new-automation-name" placeholder="hallway motion → lights on" />
                </label>
                <div class="control-label" style="margin:12px 0 6px"><span>WHEN (TRIGGER)</span><span></span></div>
                <label class="field">
                    <span class="field-label">TRIGGER TYPE</span>
                    <select class="mode-select" id="auto-trigger-type">
                        <option value="state">ENTITY STATE</option>
                        <option value="time">TIME OF DAY</option>
                    </select>
                </label>
                <div id="trigger-state-box">
                    <label class="field">
                        <span class="field-label">ENTITY</span>
                        <select class="mode-select" id="auto-trigger-entity">${entityOptions(triggerEntities)}</select>
                    </label>
                    <div class="form-grid">
                        <label class="field">
                            <span class="field-label">FIELD</span>
                            <select class="mode-select" id="auto-trigger-field"></select>
                        </label>
                        <label class="field">
                            <span class="field-label">IS</span>
                            <select class="mode-select" id="auto-trigger-op">
                                <option value="==">==</option>
                                <option value="!=">!=</option>
                                <option value=">">&gt;</option>
                                <option value="<">&lt;</option>
                                <option value=">=">&ge;</option>
                                <option value="<=">&le;</option>
                            </select>
                        </label>
                    </div>
                    <div id="auto-trigger-value"></div>
                </div>
                <div id="trigger-time-box" style="display:none">
                    <label class="field">
                        <span class="field-label">TIME</span>
                        <input type="time" id="auto-trigger-time" value="07:30" />
                    </label>
                    <div class="control-label" style="margin:8px 0 6px"><span>DAYS — NONE CHECKED = EVERY DAY</span><span></span></div>
                    <div class="day-row">
                        ${[1, 2, 3, 4, 5, 6, 0]
                            .map(d => `<label class="member-row"><input type="checkbox" data-trigger-day="${d}" /><span>${DAY_NAMES[d]}</span></label>`)
                            .join("")}
                    </div>
                </div>
                <div class="control-label" style="margin:12px 0 6px"><span>THEN (ACTION)</span><span></span></div>
                <label class="field">
                    <span class="field-label">ENTITY</span>
                    <select class="mode-select" id="auto-action-entity">${entityOptions(actionEntities)}</select>
                </label>
                <label class="field">
                    <span class="field-label">ACTION</span>
                    <select class="mode-select" id="auto-action-action"></select>
                </label>
                <div id="auto-action-value"></div>
                <button data-add-automation style="width:100%;margin-top:12px">CREATE AUTOMATION</button>
                <p class="dim" style="margin-top:10px;font-size:10px">
                    Level-triggered with a 15s cooldown: while the condition holds, the action repeats at most every 15s.
                </p>
            </div>
        </div>
        <div>${cards || '<div class="empty-state">NO AUTOMATIONS — e.g. contact sensor opens → turn a group on</div>'}</div>
    </div>`;
}

function rebuildTriggerMode() {
    const typeSelect = document.getElementById("auto-trigger-type");
    const stateBox = document.getElementById("trigger-state-box");
    const timeBox = document.getElementById("trigger-time-box");
    if (typeSelect === null || stateBox === null || timeBox === null) return;
    const isTime = typeSelect.value === "time";
    stateBox.style.display = isTime ? "none" : "";
    timeBox.style.display = isTime ? "" : "none";
}

function rebuildTriggerFields() {
    const entitySelect = document.getElementById("auto-trigger-entity");
    const fieldSelect = document.getElementById("auto-trigger-field");
    if (entitySelect === null || fieldSelect === null) return;
    const entity = findEntity(entitySelect.value);
    if (entity === undefined) return;
    fieldSelect.innerHTML = triggerFieldsFor(entity.kind)
        .map(([field, label]) => `<option value="${esc(field)}">${esc(label)}</option>`)
        .join("");
    rebuildTriggerValue();
}

function rebuildTriggerValue() {
    const entitySelect = document.getElementById("auto-trigger-entity");
    const fieldSelect = document.getElementById("auto-trigger-field");
    const valueBox = document.getElementById("auto-trigger-value");
    if (entitySelect === null || fieldSelect === null || valueBox === null) return;
    const entity = findEntity(entitySelect.value);
    if (entity === undefined) return;
    if (isBooleanField(entity.kind, fieldSelect.value)) {
        valueBox.innerHTML = `<label class="field">
            <span class="field-label">VALUE</span>
            <select class="mode-select" id="auto-trigger-value-input">
                <option value="true">TRUE</option>
                <option value="false">FALSE</option>
            </select>
        </label>`;
    } else {
        valueBox.innerHTML = `<label class="field">
            <span class="field-label">VALUE</span>
            <input type="number" step="any" id="auto-trigger-value-input" placeholder="value" />
        </label>`;
    }
}

function rebuildActionOptions() {
    const entitySelect = document.getElementById("auto-action-entity");
    const actionSelect = document.getElementById("auto-action-action");
    if (entitySelect === null || actionSelect === null) return;
    const entity = findEntity(entitySelect.value);
    if (entity === undefined) return;
    actionSelect.innerHTML = (ACTION_OPTIONS[entity.kind] ?? [])
        .map(([action, label]) => `<option value="${esc(action)}">${esc(label)}</option>`)
        .join("");
    rebuildActionValue();
}

function rebuildActionValue() {
    const actionSelect = document.getElementById("auto-action-action");
    const valueBox = document.getElementById("auto-action-value");
    if (actionSelect === null || valueBox === null) return;
    switch (actionSelect.value) {
        case "hueSat":
            valueBox.innerHTML = `<label class="field">
                <span class="field-label">COLOR</span>
                <input type="color" id="auto-action-value-input" value="#ff8000" />
            </label>`;
            break;
        case "level":
        case "colorTemp":
        case "position":
        case "fan":
        case "setpoint": {
            const specs = {
                level: [0, 254, 1, 254],
                colorTemp: [147, 500, 10, 300],
                position: [0, 100, 1, 50],
                fan: [0, 100, 1, 50],
                setpoint: [5, 30, 0.5, 21],
            };
            const [min, max, step, def] = specs[actionSelect.value];
            valueBox.innerHTML = `<label class="field">
                <span class="field-label">VALUE</span>
                <input type="number" min="${min}" max="${max}" step="${step}" value="${def}" id="auto-action-value-input" />
            </label>`;
            break;
        }
        default:
            valueBox.innerHTML = "";
    }
}

function automationTriggerLine(a) {
    if (a.trigger.type === "time") {
        const days = a.trigger.days?.length > 0 ? a.trigger.days.map(d => DAY_NAMES[d] ?? d).join(" ") : "EVERY DAY";
        return `<span class="auto-key">AT</span> <span class="auto-val">${esc(a.trigger.time)}</span> <span class="auto-key">${esc(days)}</span>`;
    }
    return `<span class="auto-key">WHEN</span> ${esc(entityDisplayName(findEntity(a.trigger.key)))} <span class="auto-key">${esc(a.trigger.field)}</span> ${esc(a.trigger.op)} <span class="auto-val">${esc(formatAutomationValue(a.trigger.field, a.trigger.value))}</span>`;
}

function formatAutomationValue(fieldOrAction, value) {
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (fieldOrAction === "hueSat" && value !== null && typeof value === "object") {
        return `h=${value.h}° s=${value.s}%`;
    }
    return String(value);
}

// ------------------------------------------------------------------ devices

function renderDevices() {
    if (state.nodes.length === 0) {
        return `<div class="empty-state">NO COMMISSIONED DEVICES — <a href="#/commission">COMMISSION ONE</a></div>`;
    }
    const cards = state.nodes
        .map(node => {
            const connDot = node.connected ? "on" : node.online ? "warn" : "err";
            const entities = state.entities[node.id] ?? [];
            return `<div class="panel device-card" style="padding:14px">
                <div class="device-head">
                    <span class="device-name">${esc(node.label)}</span>
                    <span class="device-id">#${esc(node.id)}</span>
                </div>
                <div class="device-state">
                    <span class="dot ${connDot}"></span> ${esc(node.connectionState).toUpperCase()}
                    · ${entities.length} ENTIT${entities.length === 1 ? "Y" : "IES"}
                </div>
                <div class="btn-row">
                    <button data-open-detail="${esc(node.id)}">DETAILS</button>
                    <button class="ghost" data-identify="${esc(node.id)}">IDENTIFY</button>
                    <button class="ghost danger" data-remove="${esc(node.id)}">REMOVE</button>
                </div>
            </div>`;
        })
        .join("");
    return `<div class="device-list">${cards}</div>`;
}

let drawerDetail = null;
let drawerRendered = null;

async function openDrawer(nodeId) {
    state.drawerNodeId = nodeId;
    drawerDetail = null;
    renderDrawer();
    try {
        drawerDetail = await api(`/api/nodes/${encodeURIComponent(nodeId)}`, undefined, "GET");
    } catch (error) {
        toast(error.message, "err");
        drawerDetail = { error: error.message };
    }
    renderDrawer();
}

function renderDrawer() {
    const existing = document.getElementById("drawer-root");
    if (state.drawerNodeId === null) {
        existing?.remove();
        return;
    }

    if (!existing) {
        const root = document.createElement("div");
        root.id = "drawer-root";
        root.innerHTML = `<div class="drawer-backdrop" data-close-drawer>
            <div class="drawer"></div>
        </div>`;
        document.body.appendChild(root);
    }

    const drawer = document.querySelector("#drawer-root .drawer");
    if (!drawer) return;

    if (drawerDetail === null) {
        drawer.innerHTML = `<div class="drawer-section"><h3>LOADING NODE ${esc(state.drawerNodeId)}…</h3></div>`;
        return;
    }

    // Skip no-op re-renders: background SSE updates call render() while the user
    // may be typing in the rename field.
    if (drawerRendered === drawerDetail && drawer.innerHTML !== "") return;
    drawerRendered = drawerDetail;

    const detail = drawerDetail;
    if (detail.error) {
        drawer.innerHTML = `<div class="drawer-section"><h3>ERROR</h3>${esc(detail.error)}</div>`;
        return;
    }

    const endpointBlocks = (detail.endpoints ?? [])
        .map(ep => {
            const rows = [];
            if (ep.basic) {
                for (const [k, v] of Object.entries(ep.basic)) {
                    if (v === undefined || v === null) continue;
                    rows.push([k, v]);
                }
            }
            if (ep.thread) {
                for (const [k, v] of Object.entries(ep.thread)) {
                    if (v === undefined || v === null) continue;
                    rows.push([`thread.${k}`, v]);
                }
            }
            const typeChips = (ep.deviceTypes ?? []).map(t => `<span class="chip">${esc(t.name)}</span>`).join("");
            const serverChips = (ep.serverList ?? []).map(id => `<span class="chip">0x${id.toString(16).padStart(4, "0")}</span>`).join("");
            return `<div class="endpoint-block">
                <div class="endpoint-head"><span>ENDPOINT ${ep.id}</span><span class="faint">EP</span></div>
                <div class="endpoint-body">
                    <div class="chip-row" style="margin-bottom:8px">${typeChips || '<span class="chip">untyped</span>'}</div>
                    ${rows.length > 0 ? `<table class="kv-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>` : ""}
                    ${serverChips ? `<div class="control-label" style="margin:8px 0 4px"><span>SERVER CLUSTERS</span></div><div class="chip-row">${serverChips}</div>` : ""}
                </div>
            </div>`;
        })
        .join("");

    const windowInfo = state.windowInfo && state.windowInfo.nodeId === detail.id ? state.windowInfo : null;

    drawer.innerHTML = `
        <div class="drawer-section">
            <h3>NODE ${esc(detail.id)}</h3>
            <div class="device-head">
                <span class="device-name">${esc(detail.label)}</span>
                <span class="dot ${detail.connected ? "on" : "err"}"></span>
                <span class="dim" style="font-size:10px">${esc(detail.connectionState).toUpperCase()}</span>
            </div>
        </div>
        <div class="drawer-section">
            <h3>RENAME</h3>
            <div style="display:flex;gap:8px">
                <input type="text" id="rename-input" value="${esc(detail.label)}" />
                <button data-rename="${esc(detail.id)}">SAVE</button>
            </div>
        </div>
        <div class="drawer-section">
            <h3>STRUCTURE</h3>
            ${endpointBlocks || '<span class="dim">no endpoints read</span>'}
        </div>
        ${windowInfo ? `<div class="drawer-section">
            <h3>COMMISSIONING WINDOW (${windowInfo.timeoutSeconds}s)</h3>
            <table class="kv-table">
                <tr><td>manual code</td><td>${esc(windowInfo.manualPairingCode)}</td></tr>
                <tr><td>qr payload</td><td style="word-break:break-all">${esc(windowInfo.qrPairingCode)}</td></tr>
                <tr><td>qr render</td><td><a href="${esc(windowInfo.qrUrl)}" target="_blank" rel="noreferrer">open QR renderer ↗</a></td></tr>
            </table>
        </div>` : ""}
        <div class="drawer-section">
            <h3>ACTIONS</h3>
            <div class="btn-row">
                <button data-identify="${esc(detail.id)}">IDENTIFY</button>
                <button data-window="${esc(detail.id)}">OPEN PAIRING WINDOW</button>
                <button class="danger" data-remove="${esc(detail.id)}">DECOMMISSION</button>
            </div>
        </div>
    `;
}

function closeDrawer() {
    state.drawerNodeId = null;
    state.windowInfo = null;
    drawerRendered = null;
    document.getElementById("drawer-root")?.remove();
}

// ------------------------------------------------------------------ commission

function scanListHtml() {
    return state.discovered
        .map(entry => `<div class="scan-entry">
            <span class="scan-name">${esc(entry.name)}</span>
            <span class="faint">${esc(entry.addresses?.[0]?.peripheralAddress ?? entry.addresses?.[0]?.ip ?? "")}</span>
            <button data-commission-discovered="${esc(entry.id)}" ${state.scanning ? "disabled" : ""}>COMMISSION</button>
        </div>`)
        .join("");
}

function renderCommission() {
    const feed = state.commissioningFeed
        .map(entry => {
            const cls = entry.phase === "error" ? "err" : entry.phase === "done" ? "ok" : "";
            return `<div class="pf-line">
                <span class="pf-time">${fmtTime(entry.t)}</span>
                <span class="pf-phase ${cls}">${esc(entry.phase).toUpperCase()}</span>
                <span>${esc(entry.message)}</span>
            </div>`;
        })
        .join("");

    const t = state.thread;

    return `
    <div class="two-col">
        <div class="panel">
            <div class="panel-title">ADD DEVICE</div>
            <div class="panel-body">
                <label class="field">
                    <span class="field-label">PAIRING CODE (11-DIGIT MANUAL OR MT: QR PAYLOAD)</span>
                    <input type="text" id="pairing-code" placeholder="34970112332 or MT:Y0..." autocomplete="off" />
                </label>

                <div class="check-row">
                    <input type="checkbox" id="use-thread" checked />
                    <span>USE THREAD
                        <span class="hint" id="thread-hint">${t?.online === true && t.dataset
                            ? `dataset from OTBR: ${esc(t.dataset.networkName)} ch${esc(t.dataset.channel)}`
                            : "OTBR dataset unavailable — will fail unless a manual dataset is provided"}</span>
                    </span>
                </div>

                <div class="check-row">
                    <input type="checkbox" id="use-ble" ${state.settings.bleEnabled ? "checked" : ""} />
                    <span>DISCOVER OVER BLE
                        <span class="hint">for devices not yet on the network (needs a local BLE adapter)</span>
                    </span>
                </div>

                <details style="margin:8px 0 14px">
                    <summary class="dim" style="cursor:pointer;font-size:11px;letter-spacing:.12em">MANUAL / ADVANCED</summary>
                    <div style="margin-top:12px">
                        <label class="field">
                            <span class="field-label">PASSCODE (IF NO PAIRING CODE)</span>
                            <input type="number" id="passcode" placeholder="20202021" />
                        </label>
                        <div class="form-grid">
                            <label class="field">
                                <span class="field-label">LONG DISCRIMINATOR</span>
                                <input type="number" id="discriminator" placeholder="3840" />
                            </label>
                            <label class="field">
                                <span class="field-label">SHORT DISCRIMINATOR</span>
                                <input type="number" id="short-discriminator" />
                            </label>
                        </div>
                        <label class="field">
                            <span class="field-label">THREAD DATASET OVERRIDE (HEX TLV — ot-ctl dataset active -x)</span>
                            <input type="text" id="thread-dataset" placeholder="0e08..." />
                        </label>
                        <div class="check-row">
                            <input type="checkbox" id="use-wifi" />
                            <span>SEND WI-FI CREDENTIALS INSTEAD
                                <span class="hint">for Wi-Fi/Ethernet devices that ble-commission onto the LAN</span>
                            </span>
                        </div>
                        <div class="form-grid">
                            <label class="field">
                                <span class="field-label">WI-FI SSID</span>
                                <input type="text" id="wifi-ssid" autocomplete="off" />
                            </label>
                            <label class="field">
                                <span class="field-label">WI-FI PASSWORD</span>
                                <input type="password" id="wifi-pass" autocomplete="off" />
                            </label>
                        </div>
                    </div>
                </details>

                <button id="commission-start" style="width:100%">INITIATE COMMISSIONING</button>
            </div>
        </div>

        <div>
            <div class="panel">
                <div class="panel-title">
                    <span>NETWORK SCAN</span>
                    <button class="ghost" id="scan-start" ${state.scanning ? "disabled" : ""}>${state.scanning ? "SCANNING…" : "SCAN"}</button>
                </div>
                <div class="panel-body" id="scan-list">
                    ${scanListHtml() || '<span class="dim">run a scan to list commissionable devices on IP (mDNS) and BLE</span>'}
                </div>
            </div>
            <div class="panel section-gap">
                <div class="panel-title">COMMISSIONING FEED</div>
                <div class="panel-body">
                    <div class="progress-feed" id="commission-feed">${feed || '<span class="faint">idle</span>'}</div>
                </div>
            </div>
        </div>
    </div>`;
}

async function startCommission(overrides = {}) {
    const get = id => document.getElementById(id)?.value?.trim() ?? "";
    const code = get("pairing-code");
    const request = {
        pairingCode: code.startsWith("MT:") ? undefined : code || undefined,
        qrCode: code.startsWith("MT:") ? code : undefined,
        passcode: get("passcode") ? Number(get("passcode")) : undefined,
        discriminator: get("discriminator") ? Number(get("discriminator")) : undefined,
        shortDiscriminator: get("short-discriminator") ? Number(get("short-discriminator")) : undefined,
        useThread: document.getElementById("use-thread")?.checked !== false,
        threadDataset: get("thread-dataset") || undefined,
        useBle: document.getElementById("use-ble")?.checked === true,
        useWifi: document.getElementById("use-wifi")?.checked === true,
        wifiSsid: get("wifi-ssid") || undefined,
        wifiPass: get("wifi-pass") || undefined,
        ...overrides,
    };

    const button = document.getElementById("commission-start");
    if (button) {
        button.disabled = true;
        button.textContent = "COMMISSIONING…";
    }
    try {
        await api("/api/commission", request);
    } catch (error) {
        const entry = { t: Date.now(), phase: "error", message: error.message };
        state.commissioningFeed.push(entry);
        appendFeedLine(entry);
        toast(error.message, "err");
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "INITIATE COMMISSIONING";
        }
    }
}

// ------------------------------------------------------------------ thread page

function renderThread() {
    const t = state.thread;
    if (t === null) {
        return `<div class="empty-state">QUERYING BORDER ROUTER…</div>`;
    }
    if (!t.configured) {
        return `<div class="empty-state">OTBR NOT CONFIGURED — SET HOST/PORT IN <a href="#/settings">SETTINGS</a></div>`;
    }
    if (!t.online) {
        return `<div class="empty-state">
            OTBR UNREACHABLE AT ${esc(t.host)}:${esc(t.port)}<br>
            <span class="faint">${esc(t.error ?? "")}</span><br><br>
            Start the container, then <button class="ghost" data-refresh-thread>RETRY</button>
        </div>`;
    }

    const node = t.node ?? {};
    const ds = t.dataset;
    const rows = [
        ["state", node.state],
        ["network name", node.networkName],
        ["channel", node.channel],
        ["rloc", node.rlocAddress],
        ["rloc16", node.rloc16 !== undefined ? `0x${node.rloc16.toString(16)}` : undefined],
        ["routers", node.numOfRouter],
        ["partition id", node.leaderData?.partitionId],
        ["ext pan id", node.extPanId],
        ["coprocessor", t.coprocessorVersion],
        ["commissioner", t.commissionerState],
    ].filter(([, v]) => v !== undefined && v !== null);

    const datasetRows = ds
        ? Object.entries(ds)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
              .join("")
        : "";

    return `<div class="two-col">
        <div class="panel">
            <div class="panel-title">
                <span>BORDER ROUTER</span>
                <button class="ghost" data-refresh-thread>REFRESH</button>
            </div>
            <div class="panel-body">
                <table class="kv-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
            </div>
        </div>
        <div class="panel">
            <div class="panel-title"><span>ACTIVE DATASET (SECRETS REDACTED)</span></div>
            <div class="panel-body">
                ${datasetRows ? `<table class="kv-table">${datasetRows}</table>` : '<span class="dim">no active dataset</span>'}
                <p class="dim" style="margin-top:12px;font-size:11px">
                    The full dataset (with network key + PSKc) is pulled from the OTBR REST API at
                    ${esc(t.host)}:${esc(t.port)} and delivered to devices during Thread commissioning.
                </p>
            </div>
        </div>
    </div>`;
}

// ------------------------------------------------------------------ settings

function renderSettings() {
    const s = state.settings;
    return `<div class="two-col">
        <div class="panel">
            <div class="panel-title"><span>THREAD BORDER ROUTER</span></div>
            <div class="panel-body">
                <div class="form-grid">
                    <label class="field">
                        <span class="field-label">OTBR REST HOST</span>
                        <input type="text" id="set-otbr-host" value="${esc(s.otbrHost)}" />
                    </label>
                    <label class="field">
                        <span class="field-label">OTBR REST PORT</span>
                        <input type="number" id="set-otbr-port" value="${esc(s.otbrPort)}" />
                    </label>
                </div>
                <button data-save-settings>SAVE</button>
            </div>
        </div>
        <div class="panel">
            <div class="panel-title"><span>COMMISSIONING TRANSPORTS</span></div>
            <div class="panel-body">
                <div class="check-row">
                    <input type="checkbox" id="set-ble" ${s.bleEnabled ? "checked" : ""} />
                    <span>ENABLE BLE COMMISSIONING
                        <span class="hint">requires a Bluetooth adapter visible to the hub process (hci0 by default)</span>
                        <span class="hint">Controller scanner: ${s.bleActive ? "registered" : "not registered"}${s.bleRestartRequired ? " — restart the hub to apply the saved BLE setting" : ""}</span>
                        <span class="hint">Adapter: ${esc(s.bleStatus?.adapterState ?? "not initialized")}</span>
                    </span>
                </div>
                <button data-save-settings>SAVE</button>
            </div>
        </div>
    </div>`;
}

// ------------------------------------------------------------------ log

function renderLog() {
    const lines = state.log
        .map(
            entry => `<div class="log-line ${esc(entry.level)}">
                <span class="log-time">${fmtTime(entry.t)}</span>
                <span class="log-level">${esc(entry.level).toUpperCase()}</span>
                <span class="log-source">[${esc(entry.source)}]</span>
                <span>${esc(entry.message)}</span>
            </div>`,
        )
        .join("");
    return `<div class="log-view" id="log-view">${lines || '<span class="faint">no events yet</span>'}</div>`;
}

function appendLogLine(entry) {
    const view = document.getElementById("log-view");
    if (!view) return;
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
    view.insertAdjacentHTML(
        "beforeend",
        `<div class="log-line ${esc(entry.level)}">
            <span class="log-time">${fmtTime(entry.t)}</span>
            <span class="log-level">${esc(entry.level).toUpperCase()}</span>
            <span>[${esc(entry.source)}]</span>
            <span>${esc(entry.message)}</span>
        </div>`,
    );
    if (atBottom) view.scrollTop = view.scrollHeight;
}

// ------------------------------------------------------------------ global events

document.body.addEventListener("click", async event => {
    const target = event.target.closest("[data-cmd], [data-open-detail], [data-identify], [data-remove], [data-window], [data-rename], [data-commission-discovered], [data-refresh-thread], [data-save-settings], [data-add-group], [data-group-cmd], [data-group-save], [data-group-delete], [data-add-automation], [data-automation-toggle], [data-automation-run], [data-automation-delete], #commission-start, #scan-start, [data-close-drawer]");
    if (target === null) return;
    if (target.matches("[data-close-drawer]") && event.target === target) {
        closeDrawer();
        return;
    }

    if (target.id === "commission-start") return startCommission();
    if (target.id === "scan-start") {
        try {
            await api("/api/scan", { seconds: 20 });
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }

    if (target.dataset.cmd !== undefined) {
        const key = target.dataset.entity;
        const action = target.dataset.cmd;
        switch (action) {
            case "toggle":
            case "on":
            case "off":
            case "lock":
            case "unlock":
                return void sendCommand(key, action);
            case "setpoint-up":
            case "setpoint-dn": {
                const entity = findEntity(key);
                const current = entity?.state.occupiedHeatingSetpoint ?? 2000;
                const next = current + (action === "setpoint-up" ? 500 : -500);
                return void sendCommand(key, "setpoint", next / 100);
            }
            case "cover-open":
                return void sendCommand(key, "position", 0);
            case "cover-close":
                return void sendCommand(key, "position", 100);
        }
        return;
    }

    if (target.dataset.openDetail !== undefined) return void openDrawer(target.dataset.openDetail);
    if (target.dataset.identify !== undefined) {
        try {
            await api(`/api/nodes/${encodeURIComponent(target.dataset.identify)}/identify`, { seconds: 10 });
            toast("identify sent", "ok");
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.window !== undefined) {
        try {
            const info = await api(`/api/nodes/${encodeURIComponent(target.dataset.window)}/window`, { timeoutSeconds: 900 });
            state.windowInfo = { ...info, nodeId: target.dataset.window };
            toast("pairing window open (900s)", "ok");
            renderDrawer();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.rename !== undefined) {
        const label = document.getElementById("rename-input")?.value?.trim();
        if (!label) return;
        try {
            await api(`/api/nodes/${encodeURIComponent(target.dataset.rename)}/rename`, { label });
            toast("renamed", "ok");
            closeDrawer();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.remove !== undefined) {
        if (!confirm(`Decommission node ${target.dataset.remove}? It will be removed from the fabric.`)) return;
        try {
            await api(`/api/nodes/${encodeURIComponent(target.dataset.remove)}/decommission`, {});
            toast("decommissioned", "ok");
            closeDrawer();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.commissionDiscovered !== undefined) {
        const passcode = document.getElementById("passcode")?.value?.trim();
        return startCommission({
            discoveredId: target.dataset.commissionDiscovered,
            passcode: passcode ? Number(passcode) : undefined,
        });
    }
    if (target.hasAttribute("data-refresh-thread")) {
        try {
            await api("/api/thread/status", undefined, "GET");
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.hasAttribute("data-save-settings")) {
        try {
            state.settings = await api("/api/settings", {
                otbrHost: document.getElementById("set-otbr-host")?.value?.trim() || undefined,
                otbrPort: Number(document.getElementById("set-otbr-port")?.value) || undefined,
                bleEnabled: document.getElementById("set-ble")?.checked ?? undefined,
            });
            toast(state.settings.bleRestartRequired
                ? "Settings saved. Restart the hub to apply the BLE change."
                : "Settings saved", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.hasAttribute("data-add-group")) {
        const name = document.getElementById("new-group-name")?.value?.trim();
        const entityKeys = Array.from(document.querySelectorAll("[data-group-member]:checked")).map(
            el => el.dataset.groupMember,
        );
        if (!name || entityKeys.length === 0) return toast("group needs a name and at least one member", "err");
        try {
            await api("/api/groups", { name, entityKeys });
            state.groups = (await api("/api/groups", undefined, "GET")).groups;
            toast("group created", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.groupCmd !== undefined && target.tagName === "BUTTON") {
        return void sendGroupCommand(target.dataset.group, target.dataset.groupCmd);
    }
    if (target.dataset.groupSave !== undefined) {
        const card = target.closest("[data-group-id]");
        const name = card?.querySelector("[data-edit-name]")?.value?.trim();
        const entityKeys = Array.from(card?.querySelectorAll("[data-edit-member]:checked") ?? []).map(
            el => el.dataset.editMember,
        );
        if (!name || entityKeys.length === 0) return toast("group needs a name and at least one member", "err");
        try {
            await api(`/api/groups/${encodeURIComponent(target.dataset.groupSave)}`, { name, entityKeys }, "PATCH");
            state.groups = (await api("/api/groups", undefined, "GET")).groups;
            toast("group saved", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.groupDelete !== undefined) {
        if (!confirm("Delete this group? The devices stay commissioned.")) return;
        try {
            await api(`/api/groups/${encodeURIComponent(target.dataset.groupDelete)}`, undefined, "DELETE");
            state.groups = state.groups.filter(g => g.id !== target.dataset.groupDelete);
            toast("group deleted", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.hasAttribute("data-add-automation")) {
        const get = id => document.getElementById(id);
        const actionEntity = findEntity(get("auto-action-entity")?.value ?? "");
        const action = get("auto-action-action")?.value;
        const name = get("new-automation-name")?.value?.trim();
        if (!name) return toast("automation needs a name", "err");
        if (actionEntity === undefined || !action) return toast("select an action", "err");

        let trigger;
        if (get("auto-trigger-type")?.value === "time") {
            const time = get("auto-trigger-time")?.value;
            if (!time) return toast("time required", "err");
            const days = Array.from(document.querySelectorAll("[data-trigger-day]:checked")).map(el =>
                Number(el.dataset.triggerDay),
            );
            trigger = { type: "time", time, days: days.length > 0 ? days : undefined };
        } else {
            const triggerEntity = findEntity(get("auto-trigger-entity")?.value ?? "");
            const field = get("auto-trigger-field")?.value;
            const op = get("auto-trigger-op")?.value;
            if (triggerEntity === undefined || !field || !op) return toast("select a trigger", "err");
            const rawTriggerValue = get("auto-trigger-value-input")?.value;
            if (rawTriggerValue === undefined || rawTriggerValue === "") return toast("trigger value required", "err");
            const triggerValue = isBooleanField(triggerEntity.kind, field)
                ? rawTriggerValue === "true"
                : Number(rawTriggerValue);
            trigger = { key: triggerEntity.key, field, op, value: triggerValue };
        }

        let actionValue;
        if (action === "hueSat") {
            actionValue = hexToHueSat(get("auto-action-value-input")?.value ?? "#ffffff");
        } else if (get("auto-action-value-input") !== null) {
            actionValue = Number(get("auto-action-value-input")?.value);
        }
        try {
            await api("/api/automations", {
                name,
                trigger,
                action: { key: actionEntity.key, action, value: actionValue },
            });
            state.automations = (await api("/api/automations", undefined, "GET")).automations;
            toast("automation created", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.automationToggle !== undefined) {
        const automation = state.automations.find(a => a.id === target.dataset.automationToggle);
        if (automation === undefined) return;
        try {
            await api(
                `/api/automations/${encodeURIComponent(target.dataset.automationToggle)}`,
                { enabled: automation.enabled !== true },
                "PATCH",
            );
            state.automations = (await api("/api/automations", undefined, "GET")).automations;
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.automationRun !== undefined) {
        try {
            await api(`/api/automations/${encodeURIComponent(target.dataset.automationRun)}/run`, {});
            toast("automation ran", "ok");
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
    if (target.dataset.automationDelete !== undefined) {
        if (!confirm("Delete this automation?")) return;
        try {
            await api(`/api/automations/${encodeURIComponent(target.dataset.automationDelete)}`, undefined, "DELETE");
            state.automations = state.automations.filter(a => a.id !== target.dataset.automationDelete);
            toast("automation deleted", "ok");
            scheduleRender();
        } catch (error) {
            toast(error.message, "err");
        }
        return;
    }
});

// range sliders + color pickers commit on "change"
document.body.addEventListener("change", async event => {
    const input = event.target;

    if (input.dataset?.groupCmd !== undefined && input.dataset?.group !== undefined) {
        switch (input.dataset.groupCmd) {
            case "level":
                await sendGroupCommand(input.dataset.group, "level", Number(input.value));
                break;
            case "hueSat": {
                const { h, s } = hexToHueSat(input.value);
                await sendGroupCommand(input.dataset.group, "hueSat", { h, s });
                break;
            }
        }
        return;
    }

    if (input.id === "auto-trigger-type") return rebuildTriggerMode();
    if (input.id === "auto-trigger-entity") return rebuildTriggerFields();
    if (input.id === "auto-trigger-field") return rebuildTriggerValue();
    if (input.id === "auto-action-entity") return rebuildActionOptions();
    if (input.id === "auto-action-action") return rebuildActionValue();

    if (input.dataset?.cmd === undefined || input.dataset?.entity === undefined) return;
    const key = input.dataset.entity;
    switch (input.dataset.cmd) {
        case "level":
            await sendCommand(key, "level", Number(input.value));
            break;
        case "position":
            await sendCommand(key, "position", Number(input.value));
            break;
        case "fan":
            await sendCommand(key, "fan", Number(input.value));
            break;
        case "hueSat": {
            const { h, s } = hexToHueSat(input.value);
            await sendCommand(key, "hueSat", { h, s });
            break;
        }
        case "mode":
            await sendCommand(key, "mode", Number(input.value));
            break;
    }
});

// custom CT track: thumb exists only on 25 K positions, commits on release
document.body.addEventListener("pointerdown", event => {
    const track = event.target.closest(".ct-track");
    if (track === null) return;
    event.preventDefault();
    track.setPointerCapture(event.pointerId);

    const min = Number(track.dataset.min);
    const max = Number(track.dataset.max);
    const step = Number(track.dataset.step);

    const snapFromEvent = e => {
        const rect = track.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const raw = min + frac * (max - min);
        return Math.min(max, Math.max(min, Math.round(raw / step) * step));
    };

    const apply = kelvin => {
        track.dataset.kelvin = String(kelvin);
        track.querySelector(".ct-thumb").style.left = `${((kelvin - min) / (max - min)) * 100}%`;
        const label = track.previousElementSibling?.querySelector("span");
        if (label !== undefined && label !== null && label.textContent.startsWith("CT")) {
            label.textContent = label.textContent.includes("(ALL)") ? `CT ${kelvin}K (ALL)` : `CT ${kelvin}K`;
        }
    };

    const onMove = e => apply(snapFromEvent(e));
    const onUp = () => {
        track.removeEventListener("pointermove", onMove);
        track.removeEventListener("pointerup", onUp);
        track.removeEventListener("pointercancel", onUp);
        const mireds = Math.round(1e6 / Number(track.dataset.kelvin));
        if (track.dataset.entity !== undefined) {
            ctOverrides.set(track.dataset.entity, mireds);
            void sendCommand(track.dataset.entity, "colorTemp", mireds);
        } else if (track.dataset.group !== undefined) {
            ctOverrides.set(`group:${track.dataset.group}`, mireds);
            void sendGroupCommand(track.dataset.group, "colorTemp", mireds);
        }
    };

    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onUp);
    apply(snapFromEvent(event));
});

// live brightness label while dragging
document.body.addEventListener("input", event => {
    const input = event.target;
    if (input.dataset?.cmd === "level") {
        const label = input.closest(".entity-card")?.querySelector("[data-brightness-label]");
        if (label) label.textContent = `${Math.round((Number(input.value) / 254) * 100)}%`;
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeDrawer();
});

// ------------------------------------------------------------------ boot

async function boot() {
    try {
        const snapshot = await api("/api/state", undefined, "GET");
        state.nodes = snapshot.nodes ?? [];
        state.groups = snapshot.groups ?? [];
        state.automations = snapshot.automations ?? [];
        state.settings = snapshot.settings ?? state.settings;
        state.log = snapshot.log ?? [];
    } catch (error) {
        toast(`state fetch failed: ${error.message}`, "err");
    }
    connectSse();
    window.addEventListener("hashchange", render);
    render();

    setInterval(() => {
        document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
    }, 1000);
}

boot();

/**
 * Hub orchestration: owns the controller ServerNode, watches peers, exposes
 * commissioning/control operations, and pushes updates through a broadcaster.
 */

import { ChannelType, Environment, ImplementationError, ObserverGroup, Seconds, StorageService, Time } from "@matter/general";
import {
    ChangeNotificationService,
    ControllerBehavior,
    NodeConnectionState,
    ServerNode,
} from "@matter/node";
import { FabricAuthority, ScannerSet } from "@matter/protocol";
import { ManualPairingCodeCodec, NodeId, QrPairingCodeCodec, VendorId } from "@matter/types";
import { GeneralCommissioning } from "@matter/types/clusters";

import { BasicInformationClient } from "@matter/main/behaviors/basic-information";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { LevelControlClient } from "@matter/main/behaviors/level-control";
import { ColorControlClient } from "@matter/main/behaviors/color-control";
import { DoorLockClient } from "@matter/main/behaviors/door-lock";
import { ThermostatClient } from "@matter/main/behaviors/thermostat";
import { WindowCoveringClient } from "@matter/main/behaviors/window-covering";
import { FanControlClient } from "@matter/main/behaviors/fan-control";
import { IdentifyClient } from "@matter/main/behaviors/identify";

import { extractEntities, extractEndpointInfo } from "./Entities.js";
import { Log } from "./Log.js";
import { Otbr } from "./Otbr.js";
import { BleStatus } from "./BleStatus.js";

const FABRIC_LABEL = "MATTER//HUB";
const SEEDED_TIMEOUT_SECONDS = 60;
const THREAD_POLL_SECONDS = 30;
const AUTOMATION_COOLDOWN_MS = 15000;
const AUTOMATION_OPS = new Set(["==", "!=", ">", "<", ">=", "<="]);

const CONNECTION_STATE_LABELS = {
    [NodeConnectionState.Connected]: "connected",
    [NodeConnectionState.Disconnected]: "disconnected",
    [NodeConnectionState.Reconnecting]: "reconnecting",
    [NodeConnectionState.WaitingForDeviceDiscovery]: "waiting for rediscovery",
};

/** True if `endpoint` belongs to `node`'s endpoint tree (a node is its own root). */
function ownedBy(endpoint, node) {
    for (let e = endpoint; e !== undefined; e = e.owner) {
        if (e === node) return true;
    }
    return false;
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) throw new Error("value must be a number");
    return Math.min(max, Math.max(min, value));
}

/** Entity keys are `nodeId/endpointId/kind`. */
function parseEntityKey(key) {
    const [nodeId, endpointId] = String(key).split("/");
    if (nodeId === undefined || endpointId === undefined || nodeId === "" || endpointId === "") {
        throw new Error(`invalid entity key "${key}"`);
    }
    return { nodeId, endpointId: Number(endpointId) };
}

function randomId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validateAutomation(request) {
    if (typeof request?.name !== "string" || request.name.trim().length === 0) {
        throw new Error("automation name required");
    }
    const { trigger, action } = request;
    if (typeof action?.key !== "string" || typeof action.action !== "string") {
        throw new Error("action requires key and action");
    }
    if (trigger?.type === "time") {
        if (typeof trigger.time !== "string" || !/^\d{2}:\d{2}$/.test(trigger.time)) {
            throw new Error('time trigger requires time as "HH:MM"');
        }
        const days = trigger.days;
        if (
            days !== undefined &&
            (!Array.isArray(days) || days.length === 0 || !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))
        ) {
            throw new Error("time trigger days must be weekday numbers 0-6 (0 = Sunday)");
        }
        return {
            name: request.name.trim(),
            trigger: { type: "time", time: trigger.time, days },
            action: { key: action.key, action: action.action, value: action.value },
        };
    }
    if (typeof trigger?.key !== "string" || typeof trigger.field !== "string" || !AUTOMATION_OPS.has(trigger.op)) {
        throw new Error("trigger requires key, field and one of ==, !=, >, <, >=, <=");
    }
    return {
        name: request.name.trim(),
        trigger: { key: trigger.key, field: trigger.field, op: trigger.op, value: trigger.value },
        action: { key: action.key, action: action.action, value: action.value },
    };
}

function triggerMatches(stateValue, op, value) {
    switch (op) {
        case "==":
            return stateValue === value;
        case "!=":
            return stateValue !== value;
        case ">":
            return Number(stateValue) > Number(value);
        case "<":
            return Number(stateValue) < Number(value);
        case ">=":
            return Number(stateValue) >= Number(value);
        case "<=":
            return Number(stateValue) <= Number(value);
    }
    return false;
}

async function invoke(endpoint, behavior, call) {
    if (!endpoint.behaviors.has(behavior)) {
        throw new Error(`endpoint ${endpoint.number} does not support ${behavior.id}`);
    }
    await call(endpoint.commandsOf(behavior));
    return { ok: true };
}

/**
 * Bounded wait for the peer's structure to be read (BasicInformation seeded and
 * more than just the root endpoint). An offline peer never seeds, so the race
 * against a timeout is required to avoid hanging the caller.
 */
async function awaitSeeded(peer, seconds) {
    if (peer.lifecycle.isSeeded) return true;
    const observers = new ObserverGroup();
    const sleep = Time.sleep("awaitSeeded", Seconds(seconds));
    try {
        const seeded = new Promise(resolve => observers.on(peer.lifecycle.seeded, () => resolve(true)));
        return await Promise.race([seeded, sleep.then(() => false)]);
    } finally {
        sleep.cancel();
        observers.close();
    }
}

export class Hub {
    #rootEnvironment;
    #environment;
    #node;
    #fabric;
    #storageManager;
    #settingsContext;
    #labelContext;
    #log = new Log();
    #observers;
    #broadcast = () => {};
    #otbr;
    #settings = { otbrHost: "localhost", otbrPort: 8081, bleEnabled: false };
    #labels = new Map();
    #scanResults = new Map();
    #scanPeers = new Map();
    #scanning = false;
    #threadTimer;
    #commissioningLock = false;
    #bleStatus;
    #groupContext;
    #automationContext;
    #groups = new Map();
    #automations = new Map();
    #automationFiredAt = new Map();
    #timeFiredAt = new Map();
    #timeTimer;

    constructor(environment, node, fabric, storageManager, settingsContext, labelContext, groupContext, automationContext, rootEnvironment) {
        this.#rootEnvironment = rootEnvironment;
        this.#environment = environment;
        this.#node = node;
        this.#fabric = fabric;
        this.#storageManager = storageManager;
        this.#settingsContext = settingsContext;
        this.#labelContext = labelContext;
        this.#groupContext = groupContext;
        this.#automationContext = automationContext;
        // Otbr reads through this mutable object so settings updates apply immediately.
        this.#otbr = new Otbr(this.#settings);
    }

    static async create(rootEnvironment) {
        const environment = new Environment("hub", rootEnvironment);
        const storageManager = await environment.get(StorageService).open("hub");
        const settingsContext = storageManager.createContext("settings");
        const labelContext = storageManager.createContext("labels");
        const groupContext = storageManager.createContext("groups");
        const automationContext = storageManager.createContext("automations");

        // BLE must be armed before the controller node exists so discovery can use it.
        const bleEnabled = rootEnvironment.vars.boolean("ble.enable") ??
            ((await settingsContext.get("bleEnabled", false)) === true);
        rootEnvironment.vars.set("ble.enable", bleEnabled);
        await settingsContext.set("bleEnabled", bleEnabled);

        const node = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
            environment,
            id: "hub",
            network: {
                // Only controller BLE is needed; device BLE would also start bleno on the same adapter.
                ble: false,
                // A hub should keep every commissioned device live-subscribed.
                autoStartCommissionedPeers: true,
            },
            basicInformation: {
                productName: "Matter Hub",
            },
            controller: {
                adminFabricLabel: FABRIC_LABEL,
                ble: bleEnabled,
            },
            commissioning: {
                enabled: false, // The hub itself is never commissionable.
            },
            subscriptions: {
                persistenceEnabled: false, // Subscription persistence is a device feature.
            },
        });

        const fabricAuthority = await node.env.load(FabricAuthority);
        const fabric = await fabricAuthority.defaultFabric({ adminFabricLabel: FABRIC_LABEL });

        const hub = new Hub(
            environment,
            node,
            fabric,
            storageManager,
            settingsContext,
            labelContext,
            groupContext,
            automationContext,
            rootEnvironment,
        );
        await hub.#start();
        return hub;
    }

    async #start() {
        this.#settings.otbrHost = await this.#settingsContext.get("otbrHost", "localhost");
        this.#settings.otbrPort = await this.#settingsContext.get("otbrPort", 8081);
        this.#settings.bleEnabled = await this.#settingsContext.get("bleEnabled", false);

        if (this.#settings.bleEnabled) {
            this.#bleStatus = new BleStatus(message => {
                if (this.#commissioningLock || this.#scanning) this.#commissioningEvent("ble", message);
                else this.#log.info("ble", message);
            });
        }

        await this.#node.start();

        // ControllerBehavior is lazy; it must register scanners before the hub reports or checks BLE availability.
        await this.#node.act(agent => agent.load(ControllerBehavior));

        this.#observers = new ObserverGroup(this.#environment.runtime);

        // One aggregate change stream covers attribute/event/structure changes for
        // every peer; re-extract the affected peer's entities and push them out.
        this.#observers.on(this.#node.env.get(ChangeNotificationService).change, change => {
            try {
                this.#handleChange(change);
            } catch (error) {
                this.#log.warn("hub", `change processing failed: ${error.message}`);
            }
        });

        // Cache custom labels for synchronous label lookups.
        for (const key of await this.#labelContext.keys?.() ?? []) {
            this.#labels.set(key, await this.#labelContext.get(key));
        }

        for (const key of (await this.#groupContext.keys()) ?? []) {
            const group = await this.#groupContext.get(key);
            if (group !== undefined) this.#groups.set(key, group);
        }
        for (const key of (await this.#automationContext.keys()) ?? []) {
            const automation = await this.#automationContext.get(key);
            if (automation !== undefined) this.#automations.set(key, automation);
        }

        const watchPeer = peer => {
            // peers.added fires from Endpoint's base constructor, before ClientNode private fields exist.
            queueMicrotask(() => {
                this.#observers.on(peer.lifecycle.connectionStateChanged, state => {
                    const nodeId = peer.peerAddress?.nodeId?.toString();
                    if (nodeId === undefined) return;
                    this.#log.info("node", `${this.nodeLabel(peer)} (${nodeId}) ${CONNECTION_STATE_LABELS[state] ?? state}`);
                    this.#pushNodes();
                    this.#pushEntities(peer);
                });
            });
        };
        for (const peer of this.#node.peers.commissioned) {
            watchPeer(peer);
        }
        this.#observers.on(this.#node.peers.added, watchPeer);
        this.#observers.on(this.#node.peers.deleted, () => this.#pushNodes());

        this.#threadTimer = Time.getTimer("hub-thread-poll", Seconds(THREAD_POLL_SECONDS), () =>
            void this.refreshThreadStatus(),
        ).start();

        this.#timeTimer = Time.getTimer("hub-time-automations", Seconds(30), () =>
            this.#evaluateTimeAutomations(),
        ).start();

        const count = this.#node.peers.commissioned.length;
        this.#log.info("hub", `controller online — ${count} commissioned node(s)`);
        void this.refreshThreadStatus();
    }

    // ------------------------------------------------------------------ settings

    async getSettings() {
        const bleActive = this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE);
        return {
            ...this.#settings,
            bleActive,
            bleRestartRequired: bleActive !== this.#settings.bleEnabled,
            bleStatus: this.#bleStatus?.state,
        };
    }

    async updateSettings(patch) {
        if (patch.otbrHost !== undefined) {
            await this.#settingsContext.set("otbrHost", String(patch.otbrHost));
            this.#settings.otbrHost = String(patch.otbrHost);
        }
        if (patch.otbrPort !== undefined) {
            const port = Number(patch.otbrPort);
            if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid OTBR port");
            await this.#settingsContext.set("otbrPort", port);
            this.#settings.otbrPort = port;
        }
        if (patch.bleEnabled !== undefined) {
            const enabled = patch.bleEnabled === true;
            await this.#settingsContext.set("bleEnabled", enabled);
            this.#settings.bleEnabled = enabled;
            // The controller installs its scanner and transport at initialization.
            // Removing the service here would leave those registrations pointing at it.
            const active = this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE);
            this.#log.info("ble", enabled === active
                ? `BLE commissioning ${enabled ? "enabled" : "disabled"}`
                : `BLE setting saved; restart the hub to ${enabled ? "enable" : "disable"} its Bluetooth transport`);
        }
        void this.refreshThreadStatus();
        return this.getSettings();
    }

    // ------------------------------------------------------------------ broadcast

    onBroadcast(broadcaster) {
        this.#broadcast = broadcaster;
    }

    /** Replay the full nodes + entities snapshot (used when a UI client attaches). */
    pushSnapshot() {
        this.#pushNodes();
        this.#pushAllEntities();
        this.#pushGroups();
        this.#pushAutomations();
    }

    #handleChange(change) {
        const peer = this.#node.peers.commissioned.find(peer => ownedBy(change.endpoint, peer));
        if (peer === undefined) return; // change on the controller itself
        this.#pushEntities(peer);
        this.#evaluateAutomations(peer);
    }

    #pushNodes() {
        this.#broadcast("nodes", { nodes: this.nodeSummaries() });
    }

    #pushAllEntities() {
        for (const peer of this.#node.peers.commissioned) {
            this.#pushEntities(peer);
        }
    }

    #pushEntities(peer) {
        const nodeId = peer.peerAddress?.nodeId?.toString();
        if (nodeId === undefined) return;
        this.#broadcast("entities", { nodeId, entities: extractEntities(nodeId, peer) });
    }

    // ------------------------------------------------------------------ node views

    nodeSummaries() {
        return this.#node.peers.commissioned.map(peer => {
            const nodeId = peer.peerAddress?.nodeId?.toString();
            return {
                id: nodeId,
                label: this.nodeLabel(peer),
                connectionState: CONNECTION_STATE_LABELS[peer.lifecycle.connectionState] ?? "unknown",
                connected: peer.lifecycle.isConnected === true,
                online: peer.lifecycle.isOnline === true,
            };
        });
    }

    nodeLabel(peer) {
        const nodeId = peer.peerAddress?.nodeId?.toString();
        if (nodeId !== undefined && this.#labels.has(nodeId)) {
            return this.#labels.get(nodeId);
        }
        try {
            const basic = peer.maybeStateOf(BasicInformationClient);
            if (basic !== undefined) {
                const name = basic.productLabel ?? basic.productName;
                if (name !== undefined && name !== null) return name;
            }
        } catch {
            // Not seeded yet — fall through.
        }
        return nodeId === undefined ? "unknown node" : `Node ${nodeId}`;
    }

    peerByNodeId(nodeIdText) {
        const nodeId = NodeId(BigInt(nodeIdText));
        return this.#node.peers.commissioned.find(peer => peer.peerAddress?.nodeId === nodeId);
    }

    async nodeDetail(nodeIdText) {
        const peer = this.peerByNodeId(nodeIdText);
        if (peer === undefined) return undefined;
        await awaitSeeded(peer, 5);
        return {
            id: nodeIdText,
            label: this.nodeLabel(peer),
            connectionState: CONNECTION_STATE_LABELS[peer.lifecycle.connectionState] ?? "unknown",
            connected: peer.lifecycle.isConnected === true,
            fabric: { label: FABRIC_LABEL },
            endpoints: Array.from(peer.endpoints).map(endpoint => extractEndpointInfo(endpoint)),
        };
    }

    // ------------------------------------------------------------------ commissioning

    #commissioningEvent(phase, message, extra = {}) {
        this.#broadcast("commissioning", { phase, message, ...extra });
        this.#log.info("commission", message);
    }

    async #findBleCandidate(discriminator, shortDiscriminator) {
        const scanner = this.#node.env.get(ScannerSet).scannerFor(ChannelType.BLE);
        if (scanner === undefined || typeof scanner.findCommissionableDevices !== "function") {
            throw new ImplementationError("The active BLE scanner cannot perform targeted commissioning discovery");
        }

        const identifier =
            discriminator !== undefined ? { longDiscriminator: discriminator } : { shortDiscriminator };
        await this.#bleStatus?.prepareScan();
        const candidates = await scanner.findCommissionableDevices(identifier, Seconds(30), true);
        if (candidates.length === 0) {
            const value = discriminator ?? shortDiscriminator;
            throw new ImplementationError(`No Matter BLE device advertising discriminator ${value} was found`);
        }
        return candidates[0];
    }

    async commission(request) {
        if (this.#commissioningLock) throw new Error("a commissioning run is already in progress");
        if (this.#scanning) throw new ImplementationError("Wait for the current device scan to finish before commissioning");
        this.#commissioningLock = true;
        try {
            return await this.#commissionLocked(request);
        } catch (error) {
            this.#commissioningEvent("error", error.message);
            throw error;
        } finally {
            this.#commissioningLock = false;
        }
    }

    async #commissionLocked(request) {
        let passcode = request.passcode;
        let discriminator;
        let shortDiscriminator;
        let vendorId;
        let productId;
        let discoveredPeer;

        if (request.discoveredId !== undefined) {
            const found = this.#scanResults.get(request.discoveredId);
            if (found === undefined) {
                throw new Error(`discovered device ${request.discoveredId} is no longer known — rescan`);
            }
            discoveredPeer = this.#scanPeers.get(request.discoveredId);
            if (discoveredPeer === undefined) {
                throw new ImplementationError("The selected discovery is no longer available — rescan the device");
            }
            this.#commissioningEvent("discovered", `commissioning discovered device ${found.name}`);
        }
        if (typeof request.qrCode === "string" && request.qrCode.length > 0) {
            const entries = QrPairingCodeCodec.decode(request.qrCode.trim());
            if (entries.length === 0) throw new Error("QR code contains no pairing payload");
            const entry = entries[0];
            discriminator = entry.discriminator;
            passcode = entry.passcode;
            vendorId = entry.vendorId === undefined ? undefined : VendorId(entry.vendorId, false);
            productId = entry.productId;
        } else if (typeof request.pairingCode === "string" && request.pairingCode.length > 0) {
            const decoded = ManualPairingCodeCodec.decode(request.pairingCode.replace(/\D/g, ""));
            shortDiscriminator = decoded.shortDiscriminator;
            passcode = decoded.passcode;
            vendorId = decoded.vendorId;
            productId = decoded.productId;
        } else if (request.discriminator !== undefined) {
            discriminator = Number(request.discriminator);
        } else if (request.shortDiscriminator !== undefined) {
            shortDiscriminator = Number(request.shortDiscriminator);
        } else if (discoveredPeer === undefined) {
            throw new Error("provide a pairing code, QR payload, discriminator, or a discovered device");
        }

        if (passcode === undefined) throw new Error("passcode required (from pairing code or manual entry)");

        const needsBle = request.useBle === true ||
            discoveredPeer?.state.commissioning.addresses?.some(address => address.type === "ble") === true;
        if (needsBle && !this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE)) {
            throw new ImplementationError("BLE was requested but the controller has no BLE scanner. Save Enable BLE in Settings and restart the hub.");
        }

        const options = {
            passcode: Number(passcode),
            discriminator,
            shortDiscriminator,
            vendorId,
            productId,
            discoveryCapabilities: {
                onIpNetwork: true,
                ble: needsBle === true,
            },
            autoSubscribe: true,
            regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
            regulatoryCountryCode: "XX",
            onAttestationFailure: findings => {
                for (const finding of findings) {
                    this.#log.warn("attestation", `[${finding.level}] ${finding.type}: ${finding.message}`);
                }
                // Hub policy: accept devices with attestation warnings for convenience.
                return true;
            },
        };

        // Matter discovery selects identifiers by property presence (`in`), including undefined values.
        for (const key of Object.keys(options)) {
            if (options[key] === undefined) delete options[key];
        }

        if (request.useWifi === true) {
            if (typeof request.wifiSsid !== "string" || typeof request.wifiPass !== "string") {
                throw new Error("Wi-Fi commissioning requires ssid and password");
            }
            options.wifiNetwork = { wifiSsid: request.wifiSsid, wifiCredentials: request.wifiPass };
            this.#commissioningEvent("credentials", "Wi-Fi credentials prepared for commissioning");
        } else if (request.useThread !== false) {
            this.#commissioningEvent("credentials", "fetching Thread dataset from OTBR…");
            let credentials = await this.#otbr.threadCredentials().catch(error => {
                throw new Error(`OTBR unreachable (${error.message}) — start the OTBR container or disable Thread`);
            });
            if (typeof request.threadDataset === "string" && request.threadDataset.length > 0) {
                // Manual override (hex TLV from `ot-ctl dataset active -x`).
                credentials = {
                    networkName: "manual dataset",
                    operationalDataset: request.threadDataset.replace(/[^0-9a-fA-F]/g, "").toLowerCase(),
                };
            }
            if (credentials === undefined) {
                throw new Error("OTBR has no active Thread dataset — form a network first");
            }
            options.threadNetwork = {
                networkName: credentials.networkName,
                operationalDataset: credentials.operationalDataset,
            };
            this.#commissioningEvent(
                "credentials",
                `Thread credentials prepared: ${credentials.networkName} (ch ${credentials.channel ?? "?"})`,
            );
        }

        let peer;
        if (discoveredPeer !== undefined) {
            if (needsBle) await this.#bleStatus?.ready();
            this.#commissioningEvent("connecting", "connecting to the selected discovered device…");
            await discoveredPeer.commission(options);
            peer = discoveredPeer;
        } else if (needsBle) {
            this.#commissioningEvent("discovery", "searching for the device over BLE…");
            const descriptor = await this.#findBleCandidate(discriminator, shortDiscriminator);
            const [advertisedVendorId, advertisedProductId] = descriptor.VP?.split("+").map(Number) ?? [];
            if (vendorId !== undefined && advertisedVendorId !== undefined && vendorId !== advertisedVendorId) {
                throw new ImplementationError(
                    `The BLE device advertises vendor ${advertisedVendorId}, but the onboarding payload names ${vendorId}`,
                );
            }
            if (productId !== undefined && advertisedProductId !== undefined && productId !== advertisedProductId) {
                throw new ImplementationError(
                    `The BLE device advertises product ${advertisedProductId}, but the onboarding payload names ${productId}`,
                );
            }
            peer = await this.#node.peers.forDescriptor(descriptor);
            await peer.construction.ready;
            this.#commissioningEvent("connecting", `connecting to BLE device ${descriptor.deviceIdentifier}…`);
            await peer.commission(options);
        } else {
            this.#commissioningEvent("discovery", "searching for the device over IP…");
            peer = await this.#node.peers.commission(options);
        }
        const nodeId = peer.peerAddress?.nodeId?.toString();
        this.#commissioningEvent("case", "operational session established, reading structure…");

        const seeded = await awaitSeeded(peer, SEEDED_TIMEOUT_SECONDS);
        if (!seeded) {
            this.#commissioningEvent(
                "warning",
                "node did not finish initial read within timeout — it may still come online",
            );
        }

        this.#pushNodes();
        this.#pushEntities(peer);
        this.#commissioningEvent("done", `commissioned node ${nodeId} (${this.nodeLabel(peer)})`, { nodeId });
        return { nodeId };
    }

    // ------------------------------------------------------------------ discovery scan

    #recordScanPeer(node) {
        const commissioning = node.state.commissioning;
        const addresses = commissioning.addresses ?? [];
        const id = commissioning.deviceIdentifier ?? node.id;
        if (id === undefined) return;

        const vendorSuffix =
            commissioning.deviceName !== undefined || commissioning.vendorId !== undefined
                ? ` (VP ${commissioning.vendorId ?? "?"}/${commissioning.productId ?? "?"})`
                : "";
        const entry = {
            id,
            name: `${commissioning.deviceName ?? "commissionable device"}${vendorSuffix}`,
            addresses: addresses.map(a => ({ ...a })),
            discriminator: commissioning.discriminator,
        };
        const isNew = !this.#scanResults.has(id);
        this.#scanPeers.set(id, node);
        this.#scanResults.set(id, entry);
        this.#broadcast("discovered", { entries: Array.from(this.#scanResults.values()) });
        if (isNew) this.#log.info("scan", `found ${entry.name} [${id}]`);
    }

    async scan(seconds = 20) {
        if (this.#commissioningLock || this.#scanning) {
            throw new ImplementationError("A discovery or commissioning operation is already running");
        }
        this.#scanning = true;
        this.#scanResults.clear();
        this.#scanPeers.clear();
        this.#broadcast("scan", { running: true });

        try {
            const scanners = [...this.#node.env.get(ScannerSet)];
            if (scanners.some(scanner => scanner.type === ChannelType.BLE)) {
                await this.#bleStatus?.prepareScan();
            }
            const descriptors = new Map();
            const descriptorTasks = new Array();
            const capture = (scanner, descriptor) => {
                const key = `${scanner.type}:${descriptor.deviceIdentifier}`;
                if (descriptors.has(key)) return;
                descriptors.set(key, descriptor);
                descriptorTasks.push(
                    this.#node.peers.forDescriptor(descriptor).then(async peer => {
                        await peer.construction.ready;
                        this.#recordScanPeer(peer);
                    }),
                );
            };
            const stop = Time.sleep("hub discovery scan", Seconds(seconds));
            const outcomes = await Promise.allSettled(
                scanners.map(scanner =>
                    scanner.findCommissionableDevicesContinuously(
                        {},
                        descriptor => capture(scanner, descriptor),
                        undefined,
                        stop,
                    ),
                ),
            );
            stop.cancel();

            for (const outcome of outcomes) {
                if (outcome.status === "rejected") {
                    this.#log.warn("scan", `discovery transport failed: ${outcome.reason?.message ?? outcome.reason}`);
                }
            }
            const descriptorOutcomes = await Promise.allSettled(descriptorTasks);
            for (const outcome of descriptorOutcomes) {
                if (outcome.status === "rejected") {
                    this.#log.warn("scan", `discovered node initialization failed: ${outcome.reason?.message ?? outcome.reason}`);
                }
            }
            if (
                descriptorOutcomes.length > 0 &&
                this.#scanResults.size === 0 &&
                descriptorOutcomes.every(outcome => outcome.status === "rejected")
            ) {
                throw descriptorOutcomes.find(outcome => outcome.status === "rejected").reason;
            }

            if (
                descriptors.size === 0 &&
                outcomes.length > 0 &&
                outcomes.every(outcome => outcome.status === "rejected")
            ) {
                throw new ImplementationError("Every Matter discovery transport failed; see the hub log for details");
            }
        } finally {
            this.#scanning = false;
            this.#broadcast("scan", { running: false });
        }
        return { entries: Array.from(this.#scanResults.values()) };
    }

    // ------------------------------------------------------------------ node ops

    async renameNode(nodeIdText, label) {
        const peer = this.peerByNodeId(nodeIdText);
        if (peer === undefined) throw new Error(`node ${nodeIdText} not commissioned`);
        await this.#labelContext.set(nodeIdText, label);
        this.#labels.set(nodeIdText, label);
        this.#pushNodes();
        this.#pushEntities(peer);
        return { ok: true };
    }

    async decommissionNode(nodeIdText, force = false) {
        const peer = this.peerByNodeId(nodeIdText);
        if (peer === undefined) throw new Error(`node ${nodeIdText} not commissioned`);
        if (force) {
            await peer.delete();
        } else {
            try {
                await peer.decommission();
            } catch (error) {
                this.#log.warn("node", `graceful decommission failed (${error.message}) — forcing local removal`);
                await peer.delete();
            }
        }
        await this.#labelContext.delete(nodeIdText);
        this.#labels.delete(nodeIdText);
        this.#pushNodes();
        this.#broadcast("entities", { nodeId: nodeIdText, entities: [] });
        this.#log.info("node", `node ${nodeIdText} decommissioned`);
        return { ok: true };
    }

    async openWindow(nodeIdText, timeoutSeconds = 900) {
        const peer = this.peerByNodeId(nodeIdText);
        if (peer === undefined) throw new Error(`node ${nodeIdText} not commissioned`);
        const window = await peer.openEnhancedCommissioningWindow(Seconds(timeoutSeconds));
        this.#log.info("node", `enhanced commissioning window open on ${nodeIdText} for ${timeoutSeconds}s`);
        return {
            qrPairingCode: window.qrPairingCode,
            manualPairingCode: window.manualPairingCode,
            qrUrl: `https://project-chip.github.io/connectedhomeip/qrcode.html?data=${window.qrPairingCode}`,
            timeoutSeconds,
        };
    }

    async identify(nodeIdText, seconds = 10) {
        const peer = this.peerByNodeId(nodeIdText);
        if (peer === undefined) throw new Error(`node ${nodeIdText} not commissioned`);
        let identified = false;
        for (const endpoint of peer.endpoints) {
            if (!endpoint.behaviors.has(IdentifyClient)) continue;
            await endpoint.act(agent => agent.get(IdentifyClient).identify({ identifyTime: seconds }));
            identified = true;
        }
        if (!identified) throw new Error("no endpoint on this node supports identify");
        return { ok: true };
    }

    // ------------------------------------------------------------------ groups

    #pushGroups() {
        this.#broadcast("groups", { groups: this.listGroups() });
    }

    listGroups() {
        return Array.from(this.#groups.values()).sort((a, b) => a.createdAt - b.createdAt);
    }

    async createGroup(name, entityKeys) {
        if (typeof name !== "string" || name.trim().length === 0) throw new Error("group name required");
        if (!Array.isArray(entityKeys) || entityKeys.length === 0) {
            throw new Error("at least one entity key required");
        }
        const group = {
            id: randomId(),
            name: name.trim(),
            entityKeys: entityKeys.map(String),
            createdAt: Date.now(),
        };
        this.#groups.set(group.id, group);
        await this.#groupContext.set(group.id, group);
        this.#log.info("group", `created group "${group.name}" (${group.entityKeys.length} members)`);
        this.#pushGroups();
        return group;
    }

    async updateGroup(id, patch) {
        const group = this.#groups.get(id);
        if (group === undefined) throw new Error(`group ${id} not found`);
        if (patch.name !== undefined) {
            if (typeof patch.name !== "string" || patch.name.trim().length === 0) {
                throw new Error("group name required");
            }
            group.name = patch.name.trim();
        }
        if (patch.entityKeys !== undefined) {
            if (!Array.isArray(patch.entityKeys) || patch.entityKeys.length === 0) {
                throw new Error("at least one entity key required");
            }
            group.entityKeys = patch.entityKeys.map(String);
        }
        await this.#groupContext.set(id, group);
        this.#pushGroups();
        return group;
    }

    async deleteGroup(id) {
        if (!this.#groups.delete(id)) throw new Error(`group ${id} not found`);
        await this.#groupContext.delete(id);
        this.#log.info("group", `deleted group ${id}`);
        this.#pushGroups();
        return { ok: true };
    }

    async groupCommand(groupId, action, value) {
        const group = this.#groups.get(groupId);
        if (group === undefined) throw new Error(`group ${groupId} not found`);
        const results = await Promise.allSettled(
            group.entityKeys.map(key => {
                const { nodeId, endpointId } = parseEntityKey(key);
                return this.command({ nodeId, endpointId, action, value });
            }),
        );
        let failures = 0;
        let firstError = "";
        results.forEach((result, index) => {
            if (result.status === "rejected") {
                failures++;
                if (firstError === "") firstError = result.reason.message;
                this.#log.warn(
                    "group",
                    `${group.name}: ${group.entityKeys[index]} ${action} failed: ${result.reason.message}`,
                );
            }
        });
        if (failures > 0) {
            throw new Error(`${failures}/${group.entityKeys.length} members failed (${firstError})`);
        }
        return { ok: true, applied: group.entityKeys.length };
    }

    // ------------------------------------------------------------------ automations

    #pushAutomations() {
        this.#broadcast("automations", { automations: this.listAutomations() });
    }

    listAutomations() {
        return Array.from(this.#automations.values()).sort((a, b) => a.createdAt - b.createdAt);
    }

    async createAutomation(request) {
        const automation = {
            id: randomId(),
            enabled: request.enabled !== false,
            createdAt: Date.now(),
            ...validateAutomation(request),
        };
        this.#automations.set(automation.id, automation);
        await this.#automationContext.set(automation.id, automation);
        this.#log.info("automation", `created automation "${automation.name}"`);
        this.#pushAutomations();
        return automation;
    }

    async updateAutomation(id, patch) {
        const automation = this.#automations.get(id);
        if (automation === undefined) throw new Error(`automation ${id} not found`);
        Object.assign(
            automation,
            validateAutomation({
                name: patch.name ?? automation.name,
                trigger: patch.trigger ?? automation.trigger,
                action: patch.action ?? automation.action,
            }),
        );
        if (patch.enabled !== undefined) automation.enabled = patch.enabled === true;
        await this.#automationContext.set(id, automation);
        this.#pushAutomations();
        return automation;
    }

    async deleteAutomation(id) {
        if (!this.#automations.delete(id)) throw new Error(`automation ${id} not found`);
        await this.#automationContext.delete(id);
        this.#pushAutomations();
        return { ok: true };
    }

    async runAutomation(id) {
        const automation = this.#automations.get(id);
        if (automation === undefined) throw new Error(`automation ${id} not found`);
        await this.#executeAutomationAction(automation);
        return { ok: true };
    }

    /**
     * Level-triggered with a cooldown: an action that loops back into its own
     * trigger (group on → brightness report → trigger again) cannot oscillate.
     */
    #evaluateAutomations(peer) {
        const nodeId = peer.peerAddress?.nodeId?.toString();
        if (nodeId === undefined || this.#automations.size === 0) return;
        const entities = extractEntities(nodeId, peer);
        if (entities.length === 0) return;
        const now = Date.now();
        for (const automation of this.#automations.values()) {
            if (automation.enabled !== true || automation.trigger.type === "time") continue;
            const { key, field, op, value } = automation.trigger;
            if (!key.startsWith(`${nodeId}/`)) continue;
            const entity = entities.find(e => e.key === key);
            if (entity === undefined) continue;
            const stateValue = entity.state[field];
            if (stateValue === undefined || stateValue === null) continue;
            if (!triggerMatches(stateValue, op, value)) continue;
            if (now - (this.#automationFiredAt.get(automation.id) ?? 0) < AUTOMATION_COOLDOWN_MS) continue;
            this.#automationFiredAt.set(automation.id, now);
            this.#log.info("automation", `"${automation.name}" fired (${key} ${field} ${op} ${value})`);
            this.#executeAutomationAction(automation).catch(error =>
                this.#log.warn("automation", `"${automation.name}" action failed: ${error.message}`),
            );
        }
    }

    /**
     * Minute-resolution scheduler: polls every 30s and fires each time trigger
     * once per scheduled minute. A hub that is down at the scheduled minute
     * misses it; there is no catch-up.
     */
    #evaluateTimeAutomations() {
        if (this.#automations.size === 0) return;
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hhmm}`;
        for (const automation of this.#automations.values()) {
            if (automation.enabled !== true || automation.trigger.type !== "time") continue;
            if (automation.trigger.time !== hhmm) continue;
            const days = automation.trigger.days;
            if (days !== undefined && !days.includes(now.getDay())) continue;
            if (this.#timeFiredAt.get(automation.id) === minuteKey) continue;
            this.#timeFiredAt.set(automation.id, minuteKey);
            this.#log.info("automation", `"${automation.name}" fired (scheduled ${hhmm})`);
            this.#executeAutomationAction(automation).catch(error =>
                this.#log.warn("automation", `"${automation.name}" action failed: ${error.message}`),
            );
        }
    }

    async #executeAutomationAction(automation) {
        const { nodeId, endpointId } = parseEntityKey(automation.action.key);
        await this.command({
            nodeId,
            endpointId,
            action: automation.action.action,
            value: automation.action.value,
        });
    }

    // ------------------------------------------------------------------ entity commands

    async command({ nodeId, endpointId, action, value }) {
        const peer = this.peerByNodeId(String(nodeId));
        if (peer === undefined) throw new Error(`node ${nodeId} not commissioned`);
        const endpoint = Array.from(peer.endpoints).find(e => e.number === Number(endpointId));
        if (endpoint === undefined) throw new Error(`endpoint ${endpointId} not found on node ${nodeId}`);

        switch (action) {
            case "on":
                return invoke(endpoint, OnOffClient, c => c.on());
            case "off":
                return invoke(endpoint, OnOffClient, c => c.off());
            case "toggle":
                return invoke(endpoint, OnOffClient, c => c.toggle());
            case "level":
                return invoke(endpoint, LevelControlClient, c =>
                    c.moveToLevelWithOnOff({
                        level: clamp(Math.round(Number(value)), 0, 254),
                        transitionTime: null,
                        optionsMask: 0,
                        optionsOverride: 0,
                    }),
                );
            case "hueSat":
                return invoke(endpoint, ColorControlClient, c =>
                    c.enhancedMoveToHueAndSaturation({
                        enhancedHue: clamp(Math.round(((Number(value?.h) || 0) / 360) * 65536), 0, 65535),
                        saturation: clamp(Math.round(((Number(value?.s) || 0) / 100) * 0xfe), 0, 0xfe),
                        transitionTime: 5, // deciseconds
                        optionsMask: 0,
                        optionsOverride: 0,
                    }),
                );
            case "colorTemp":
                return invoke(endpoint, ColorControlClient, c =>
                    c.moveToColorTemperature({
                        colorTemperatureMireds: clamp(Math.round(Number(value)), 1, 0xffff),
                        transitionTime: 5,
                        optionsMask: 0,
                        optionsOverride: 0,
                    }),
                );
            case "lock":
                return invoke(endpoint, DoorLockClient, c => c.lockDoor({}));
            case "unlock":
                return invoke(endpoint, DoorLockClient, c => c.unlockDoor({}));
            case "position":
                return invoke(endpoint, WindowCoveringClient, c =>
                    c.goToLiftPercentage({ liftPercent100thsValue: clamp(Math.round(Number(value)), 0, 100) * 100 }),
                );
            case "fan":
                await endpoint.setStateOf(FanControlClient, {
                    percentSetting: clamp(Math.round(Number(value)), 0, 100),
                });
                return { ok: true };
            case "setpoint":
                await endpoint.setStateOf(ThermostatClient, {
                    occupiedHeatingSetpoint: Math.round(Number(value) * 100),
                });
                return { ok: true };
            case "coolingSetpoint":
                await endpoint.setStateOf(ThermostatClient, {
                    occupiedCoolingSetpoint: Math.round(Number(value) * 100),
                });
                return { ok: true };
            case "mode":
                await endpoint.setStateOf(ThermostatClient, { systemMode: Number(value) });
                return { ok: true };
            default:
                throw new Error(`unknown action "${action}"`);
        }
    }

    // ------------------------------------------------------------------ thread

    async refreshThreadStatus() {
        const status = await this.#otbr.status();
        this.#broadcast("thread", { thread: status });
        return status;
    }

    get log() {
        return this.#log;
    }

    async close() {
        this.#threadTimer?.stop();
        this.#timeTimer?.stop();
        this.#observers?.close();
        this.#bleStatus?.close();
        await this.#node?.close();
        await this.#storageManager?.close();
    }
}

import { ChannelType, Environment, ImplementationError, ObserverGroup, Seconds, StorageService, Time } from "@matter/general";
import {
  ChangeNotificationService,
  ControllerBehavior,
  NodeConnectionState,
  ServerNode
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
const CONNECTION_STATE_LABELS = {
  [NodeConnectionState.Connected]: "connected",
  [NodeConnectionState.Disconnected]: "disconnected",
  [NodeConnectionState.Reconnecting]: "reconnecting",
  [NodeConnectionState.WaitingForDeviceDiscovery]: "waiting for rediscovery"
};
function ownedBy(endpoint, node) {
  for (let e = endpoint; e !== void 0; e = e.owner) {
    if (e === node) return true;
  }
  return false;
}
function clamp(value, min, max) {
  if (!Number.isFinite(value)) throw new Error("value must be a number");
  return Math.min(max, Math.max(min, value));
}
async function invoke(endpoint, behavior, call) {
  if (!endpoint.behaviors.has(behavior)) {
    throw new Error(`endpoint ${endpoint.number} does not support ${behavior.id}`);
  }
  await call(endpoint.commandsOf(behavior));
  return { ok: true };
}
async function awaitSeeded(peer, seconds) {
  if (peer.lifecycle.isSeeded) return true;
  const observers = new ObserverGroup();
  const sleep = Time.sleep("awaitSeeded", Seconds(seconds));
  try {
    const seeded = new Promise((resolve) => observers.on(peer.lifecycle.seeded, () => resolve(true)));
    return await Promise.race([seeded, sleep.then(() => false)]);
  } finally {
    sleep.cancel();
    observers.close();
  }
}
class Hub {
  #rootEnvironment;
  #environment;
  #node;
  #fabric;
  #storageManager;
  #settingsContext;
  #labelContext;
  #log = new Log();
  #observers;
  #broadcast = () => {
  };
  #otbr;
  #settings = { otbrHost: "localhost", otbrPort: 8081, bleEnabled: false };
  #labels = /* @__PURE__ */ new Map();
  #scanResults = /* @__PURE__ */ new Map();
  #scanPeers = /* @__PURE__ */ new Map();
  #scanning = false;
  #threadTimer;
  #commissioningLock = false;
  #bleStatus;
  constructor(environment, node, fabric, storageManager, settingsContext, labelContext, rootEnvironment) {
    this.#rootEnvironment = rootEnvironment;
    this.#environment = environment;
    this.#node = node;
    this.#fabric = fabric;
    this.#storageManager = storageManager;
    this.#settingsContext = settingsContext;
    this.#labelContext = labelContext;
    this.#otbr = new Otbr(this.#settings);
  }
  static async create(rootEnvironment) {
    const environment = new Environment("hub", rootEnvironment);
    const storageManager = await environment.get(StorageService).open("hub");
    const settingsContext = storageManager.createContext("settings");
    const labelContext = storageManager.createContext("labels");
    const bleEnabled = rootEnvironment.vars.boolean("ble.enable") ?? await settingsContext.get("bleEnabled", false) === true;
    rootEnvironment.vars.set("ble.enable", bleEnabled);
    await settingsContext.set("bleEnabled", bleEnabled);
    const node = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
      environment,
      id: "hub",
      network: {
        // Only controller BLE is needed; device BLE would also start bleno on the same adapter.
        ble: false,
        // A hub should keep every commissioned device live-subscribed.
        autoStartCommissionedPeers: true
      },
      basicInformation: {
        productName: "Matter Hub"
      },
      controller: {
        adminFabricLabel: FABRIC_LABEL,
        ble: bleEnabled
      },
      commissioning: {
        enabled: false
        // The hub itself is never commissionable.
      },
      subscriptions: {
        persistenceEnabled: false
        // Subscription persistence is a device feature.
      }
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
      rootEnvironment
    );
    await hub.#start();
    return hub;
  }
  async #start() {
    this.#settings.otbrHost = await this.#settingsContext.get("otbrHost", "localhost");
    this.#settings.otbrPort = await this.#settingsContext.get("otbrPort", 8081);
    this.#settings.bleEnabled = await this.#settingsContext.get("bleEnabled", false);
    if (this.#settings.bleEnabled) {
      this.#bleStatus = new BleStatus((message) => {
        if (this.#commissioningLock || this.#scanning) this.#commissioningEvent("ble", message);
        else this.#log.info("ble", message);
      });
    }
    await this.#node.start();
    await this.#node.act((agent) => agent.load(ControllerBehavior));
    this.#observers = new ObserverGroup(this.#environment.runtime);
    this.#observers.on(this.#node.env.get(ChangeNotificationService).change, (change) => {
      try {
        this.#handleChange(change);
      } catch (error) {
        this.#log.warn("hub", `change processing failed: ${error.message}`);
      }
    });
    for (const key of await this.#labelContext.keys?.() ?? []) {
      this.#labels.set(key, await this.#labelContext.get(key));
    }
    const watchPeer = (peer) => {
      if (peer.peerAddress?.nodeId === void 0) return;
      this.#observers.on(peer.lifecycle.connectionStateChanged, (state) => {
        const nodeId = peer.peerAddress.nodeId.toString();
        this.#log.info("node", `${this.nodeLabel(peer)} (${nodeId}) ${CONNECTION_STATE_LABELS[state] ?? state}`);
        this.#pushNodes();
        this.#pushEntities(peer);
      });
    };
    for (const peer of this.#node.peers.commissioned) {
      watchPeer(peer);
    }
    this.#observers.on(this.#node.peers.added, watchPeer);
    this.#observers.on(this.#node.peers.deleted, () => this.#pushNodes());
    this.#threadTimer = Time.getTimer(
      "hub-thread-poll",
      Seconds(THREAD_POLL_SECONDS),
      () => void this.refreshThreadStatus()
    ).start();
    const count = this.#node.peers.commissioned.length;
    this.#log.info("hub", `controller online \u2014 ${count} commissioned node(s)`);
    void this.refreshThreadStatus();
  }
  // ------------------------------------------------------------------ settings
  async getSettings() {
    const bleActive = this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE);
    return {
      ...this.#settings,
      bleActive,
      bleRestartRequired: bleActive !== this.#settings.bleEnabled,
      bleStatus: this.#bleStatus?.state
    };
  }
  async updateSettings(patch) {
    if (patch.otbrHost !== void 0) {
      await this.#settingsContext.set("otbrHost", String(patch.otbrHost));
      this.#settings.otbrHost = String(patch.otbrHost);
    }
    if (patch.otbrPort !== void 0) {
      const port = Number(patch.otbrPort);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid OTBR port");
      await this.#settingsContext.set("otbrPort", port);
      this.#settings.otbrPort = port;
    }
    if (patch.bleEnabled !== void 0) {
      const enabled = patch.bleEnabled === true;
      await this.#settingsContext.set("bleEnabled", enabled);
      this.#settings.bleEnabled = enabled;
      const active = this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE);
      this.#log.info("ble", enabled === active ? `BLE commissioning ${enabled ? "enabled" : "disabled"}` : `BLE setting saved; restart the hub to ${enabled ? "enable" : "disable"} its Bluetooth transport`);
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
  }
  #handleChange(change) {
    const peer = this.#node.peers.commissioned.find((peer2) => ownedBy(change.endpoint, peer2));
    if (peer === void 0) return;
    this.#pushEntities(peer);
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
    if (nodeId === void 0) return;
    this.#broadcast("entities", { nodeId, entities: extractEntities(nodeId, peer) });
  }
  // ------------------------------------------------------------------ node views
  nodeSummaries() {
    return this.#node.peers.commissioned.map((peer) => {
      const nodeId = peer.peerAddress?.nodeId?.toString();
      return {
        id: nodeId,
        label: this.nodeLabel(peer),
        connectionState: CONNECTION_STATE_LABELS[peer.lifecycle.connectionState] ?? "unknown",
        connected: peer.lifecycle.isConnected === true,
        online: peer.lifecycle.isOnline === true
      };
    });
  }
  nodeLabel(peer) {
    const nodeId = peer.peerAddress?.nodeId?.toString();
    if (nodeId !== void 0 && this.#labels.has(nodeId)) {
      return this.#labels.get(nodeId);
    }
    try {
      const basic = peer.maybeStateOf(BasicInformationClient);
      if (basic !== void 0) {
        const name = basic.productLabel ?? basic.productName;
        if (name !== void 0 && name !== null) return name;
      }
    } catch {
    }
    return nodeId === void 0 ? "unknown node" : `Node ${nodeId}`;
  }
  peerByNodeId(nodeIdText) {
    const nodeId = NodeId(BigInt(nodeIdText));
    return this.#node.peers.commissioned.find((peer) => peer.peerAddress?.nodeId === nodeId);
  }
  async nodeDetail(nodeIdText) {
    const peer = this.peerByNodeId(nodeIdText);
    if (peer === void 0) return void 0;
    await awaitSeeded(peer, 5);
    return {
      id: nodeIdText,
      label: this.nodeLabel(peer),
      connectionState: CONNECTION_STATE_LABELS[peer.lifecycle.connectionState] ?? "unknown",
      connected: peer.lifecycle.isConnected === true,
      fabric: { label: FABRIC_LABEL },
      endpoints: Array.from(peer.endpoints).map((endpoint) => extractEndpointInfo(endpoint))
    };
  }
  // ------------------------------------------------------------------ commissioning
  #commissioningEvent(phase, message, extra = {}) {
    this.#broadcast("commissioning", { phase, message, ...extra });
    this.#log.info("commission", message);
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
    if (request.discoveredId !== void 0) {
      const found = this.#scanResults.get(request.discoveredId);
      if (found === void 0) {
        throw new Error(`discovered device ${request.discoveredId} is no longer known \u2014 rescan`);
      }
      discoveredPeer = this.#scanPeers.get(request.discoveredId);
      if (discoveredPeer === void 0) {
        throw new ImplementationError("The selected discovery is no longer available \u2014 rescan the device");
      }
      this.#commissioningEvent("discovered", `commissioning discovered device ${found.name}`);
    }
    if (typeof request.qrCode === "string" && request.qrCode.length > 0) {
      const entries = QrPairingCodeCodec.decode(request.qrCode.trim());
      if (entries.length === 0) throw new Error("QR code contains no pairing payload");
      const entry = entries[0];
      discriminator = entry.discriminator;
      passcode = entry.passcode;
      vendorId = entry.vendorId === void 0 ? void 0 : VendorId(entry.vendorId, false);
      productId = entry.productId;
    } else if (typeof request.pairingCode === "string" && request.pairingCode.length > 0) {
      const decoded = ManualPairingCodeCodec.decode(request.pairingCode.replace(/\D/g, ""));
      shortDiscriminator = decoded.shortDiscriminator;
      passcode = decoded.passcode;
      vendorId = decoded.vendorId;
      productId = decoded.productId;
    } else if (request.discriminator !== void 0) {
      discriminator = Number(request.discriminator);
    } else if (request.shortDiscriminator !== void 0) {
      shortDiscriminator = Number(request.shortDiscriminator);
    } else if (discoveredPeer === void 0) {
      throw new Error("provide a pairing code, QR payload, discriminator, or a discovered device");
    }
    if (passcode === void 0) throw new Error("passcode required (from pairing code or manual entry)");
    const needsBle = request.useBle === true || discoveredPeer?.state.commissioning.addresses?.some((address) => address.type === "ble") === true;
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
        ble: needsBle === true
      },
      autoSubscribe: true,
      regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
      regulatoryCountryCode: "XX",
      onAttestationFailure: (findings) => {
        for (const finding of findings) {
          this.#log.warn("attestation", `[${finding.level}] ${finding.type}: ${finding.message}`);
        }
        return true;
      }
    };
    for (const key of Object.keys(options)) {
      if (options[key] === void 0) delete options[key];
    }
    if (request.useWifi === true) {
      if (typeof request.wifiSsid !== "string" || typeof request.wifiPass !== "string") {
        throw new Error("Wi-Fi commissioning requires ssid and password");
      }
      options.wifiNetwork = { wifiSsid: request.wifiSsid, wifiCredentials: request.wifiPass };
      this.#commissioningEvent("credentials", "Wi-Fi credentials prepared for commissioning");
    } else if (request.useThread !== false) {
      this.#commissioningEvent("credentials", "fetching Thread dataset from OTBR\u2026");
      let credentials = await this.#otbr.threadCredentials().catch((error) => {
        throw new Error(`OTBR unreachable (${error.message}) \u2014 start the OTBR container or disable Thread`);
      });
      if (typeof request.threadDataset === "string" && request.threadDataset.length > 0) {
        credentials = {
          networkName: "manual dataset",
          operationalDataset: request.threadDataset.replace(/[^0-9a-fA-F]/g, "").toLowerCase()
        };
      }
      if (credentials === void 0) {
        throw new Error("OTBR has no active Thread dataset \u2014 form a network first");
      }
      options.threadNetwork = {
        networkName: credentials.networkName,
        operationalDataset: credentials.operationalDataset
      };
      this.#commissioningEvent(
        "credentials",
        `Thread credentials prepared: ${credentials.networkName} (ch ${credentials.channel ?? "?"})`
      );
    }
    let peer;
    if (discoveredPeer !== void 0) {
      if (needsBle) await this.#bleStatus?.ready();
      this.#commissioningEvent("connecting", "connecting to the selected discovered device\u2026");
      await discoveredPeer.commission(options);
      peer = discoveredPeer;
    } else {
      if (needsBle) await this.#bleStatus?.prepareScan();
      this.#commissioningEvent("discovery", `searching for the device (IP${needsBle ? " + BLE" : ""})\u2026`);
      peer = await this.#node.peers.commission(options);
    }
    const nodeId = peer.peerAddress?.nodeId?.toString();
    this.#commissioningEvent("case", "operational session established, reading structure\u2026");
    const seeded = await awaitSeeded(peer, SEEDED_TIMEOUT_SECONDS);
    if (!seeded) {
      this.#commissioningEvent(
        "warning",
        "node did not finish initial read within timeout \u2014 it may still come online"
      );
    }
    this.#pushNodes();
    this.#pushEntities(peer);
    this.#commissioningEvent("done", `commissioned node ${nodeId} (${this.nodeLabel(peer)})`, { nodeId });
    return { nodeId };
  }
  // ------------------------------------------------------------------ discovery scan
  async scan(seconds = 20) {
    if (this.#commissioningLock || this.#scanning) {
      throw new ImplementationError("A discovery or commissioning operation is already running");
    }
    this.#scanning = true;
    this.#scanResults.clear();
    this.#scanPeers.clear();
    this.#broadcast("scan", { running: true });
    try {
      if (this.#node.env.get(ScannerSet).hasScannerFor(ChannelType.BLE)) {
        await this.#bleStatus?.prepareScan();
      }
      const discovery = this.#node.peers.discover({ timeout: Seconds(seconds) });
      discovery.discovered.on((node) => {
        const commissioning = node.state.commissioning;
        const addresses = commissioning.addresses ?? [];
        const id = commissioning.deviceIdentifier ?? node.id;
        if (id === void 0) return;
        const vendorSuffix = commissioning.deviceName !== void 0 || commissioning.vendorId !== void 0 ? ` (VP ${commissioning.vendorId ?? "?"}/${commissioning.productId ?? "?"})` : "";
        const entry = {
          id,
          name: `${commissioning.deviceName ?? "commissionable device"}${vendorSuffix}`,
          addresses: addresses.map((a) => ({ ...a })),
          discriminator: commissioning.discriminator
        };
        const isNew = !this.#scanResults.has(id);
        this.#scanPeers.set(id, node);
        this.#scanResults.set(id, entry);
        this.#broadcast("discovered", { entries: Array.from(this.#scanResults.values()) });
        if (isNew) this.#log.info("scan", `found ${entry.name} [${id}]`);
      });
      await discovery;
    } finally {
      this.#scanning = false;
      this.#broadcast("scan", { running: false });
    }
    return { entries: Array.from(this.#scanResults.values()) };
  }
  // ------------------------------------------------------------------ node ops
  async renameNode(nodeIdText, label) {
    const peer = this.peerByNodeId(nodeIdText);
    if (peer === void 0) throw new Error(`node ${nodeIdText} not commissioned`);
    await this.#labelContext.set(nodeIdText, label);
    this.#labels.set(nodeIdText, label);
    this.#pushNodes();
    this.#pushEntities(peer);
    return { ok: true };
  }
  async decommissionNode(nodeIdText, force = false) {
    const peer = this.peerByNodeId(nodeIdText);
    if (peer === void 0) throw new Error(`node ${nodeIdText} not commissioned`);
    if (force) {
      await peer.delete();
    } else {
      try {
        await peer.decommission();
      } catch (error) {
        this.#log.warn("node", `graceful decommission failed (${error.message}) \u2014 forcing local removal`);
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
    if (peer === void 0) throw new Error(`node ${nodeIdText} not commissioned`);
    const window = await peer.openEnhancedCommissioningWindow(Seconds(timeoutSeconds));
    this.#log.info("node", `enhanced commissioning window open on ${nodeIdText} for ${timeoutSeconds}s`);
    return {
      qrPairingCode: window.qrPairingCode,
      manualPairingCode: window.manualPairingCode,
      qrUrl: `https://project-chip.github.io/connectedhomeip/qrcode.html?data=${window.qrPairingCode}`,
      timeoutSeconds
    };
  }
  async identify(nodeIdText, seconds = 10) {
    const peer = this.peerByNodeId(nodeIdText);
    if (peer === void 0) throw new Error(`node ${nodeIdText} not commissioned`);
    let identified = false;
    for (const endpoint of peer.endpoints) {
      if (!endpoint.behaviors.has(IdentifyClient)) continue;
      await endpoint.act((agent) => agent.get(IdentifyClient).identify({ identifyTime: seconds }));
      identified = true;
    }
    if (!identified) throw new Error("no endpoint on this node supports identify");
    return { ok: true };
  }
  // ------------------------------------------------------------------ entity commands
  async command({ nodeId, endpointId, action, value }) {
    const peer = this.peerByNodeId(String(nodeId));
    if (peer === void 0) throw new Error(`node ${nodeId} not commissioned`);
    const endpoint = Array.from(peer.endpoints).find((e) => e.number === Number(endpointId));
    if (endpoint === void 0) throw new Error(`endpoint ${endpointId} not found on node ${nodeId}`);
    switch (action) {
      case "on":
        return invoke(endpoint, OnOffClient, (c) => c.on());
      case "off":
        return invoke(endpoint, OnOffClient, (c) => c.off());
      case "toggle":
        return invoke(endpoint, OnOffClient, (c) => c.toggle());
      case "level":
        return invoke(
          endpoint,
          LevelControlClient,
          (c) => c.moveToLevelWithOnOff({
            level: clamp(Math.round(Number(value)), 0, 254),
            transitionTime: null,
            optionsMask: 0,
            optionsOverride: 0
          })
        );
      case "hueSat":
        return invoke(
          endpoint,
          ColorControlClient,
          (c) => c.enhancedMoveToHueAndSaturation({
            enhancedHue: clamp(Math.round((Number(value?.h) || 0) / 360 * 65536), 0, 65535),
            saturation: clamp(Math.round((Number(value?.s) || 0) / 100 * 254), 0, 254),
            transitionTime: 5,
            // deciseconds
            optionsMask: 0,
            optionsOverride: 0
          })
        );
      case "colorTemp":
        return invoke(
          endpoint,
          ColorControlClient,
          (c) => c.moveToColorTemperature({
            colorTemperatureMireds: clamp(Math.round(Number(value)), 1, 65535),
            transitionTime: 5,
            optionsMask: 0,
            optionsOverride: 0
          })
        );
      case "lock":
        return invoke(endpoint, DoorLockClient, (c) => c.lockDoor({}));
      case "unlock":
        return invoke(endpoint, DoorLockClient, (c) => c.unlockDoor({}));
      case "position":
        return invoke(
          endpoint,
          WindowCoveringClient,
          (c) => c.goToLiftPercentage({ liftPercent100thsValue: clamp(Math.round(Number(value)), 0, 100) * 100 })
        );
      case "fan":
        await endpoint.setStateOf(FanControlClient, {
          percentSetting: clamp(Math.round(Number(value)), 0, 100)
        });
        return { ok: true };
      case "setpoint":
        await endpoint.setStateOf(ThermostatClient, {
          occupiedHeatingSetpoint: Math.round(Number(value) * 100)
        });
        return { ok: true };
      case "coolingSetpoint":
        await endpoint.setStateOf(ThermostatClient, {
          occupiedCoolingSetpoint: Math.round(Number(value) * 100)
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
    this.#observers?.close();
    this.#bleStatus?.close();
    await this.#node?.close();
    await this.#storageManager?.close();
  }
}
export {
  Hub
};
//# sourceMappingURL=Hub.js.map

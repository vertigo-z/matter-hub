import { Bytes } from "@matter/general";
import { DescriptorClient } from "@matter/main/behaviors/descriptor";
import { BasicInformationClient } from "@matter/main/behaviors/basic-information";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { LevelControlClient } from "@matter/main/behaviors/level-control";
import { ColorControlClient } from "@matter/main/behaviors/color-control";
import { DoorLockClient } from "@matter/main/behaviors/door-lock";
import { ThermostatClient } from "@matter/main/behaviors/thermostat";
import { WindowCoveringClient } from "@matter/main/behaviors/window-covering";
import { FanControlClient } from "@matter/main/behaviors/fan-control";
import { OccupancySensingClient } from "@matter/main/behaviors/occupancy-sensing";
import { BooleanStateClient } from "@matter/main/behaviors/boolean-state";
import { TemperatureMeasurementClient } from "@matter/main/behaviors/temperature-measurement";
import { RelativeHumidityMeasurementClient } from "@matter/main/behaviors/relative-humidity-measurement";
import { PressureMeasurementClient } from "@matter/main/behaviors/pressure-measurement";
import { IlluminanceMeasurementClient } from "@matter/main/behaviors/illuminance-measurement";
import { FlowMeasurementClient } from "@matter/main/behaviors/flow-measurement";
import { ElectricalPowerMeasurementClient } from "@matter/main/behaviors/electrical-power-measurement";
import { ElectricalEnergyMeasurementClient } from "@matter/main/behaviors/electrical-energy-measurement";
import { ThreadNetworkDiagnosticsClient } from "@matter/main/behaviors/thread-network-diagnostics";
const ILLUMINANCE_INVALID = 65535;
const DEVICE_TYPE_NAMES = {
  10: "Door Lock",
  21: "Contact Sensor",
  22: "Switch",
  43: "Fan",
  117: "Air Conditioner",
  769: "Thermostat",
  770: "Temperature Sensor",
  771: "Pressure Sensor",
  772: "Flow Sensor",
  773: "Humidity Sensor",
  775: "Air Quality Sensor",
  776: "Occupancy Sensor",
  256: "Light",
  257: "Dimmable Light",
  258: "Color Temperature Light",
  259: "Extended Color Light",
  260: "Light Sensor",
  266: "Plug",
  267: "Dimmable Plug",
  514: "Window Covering"
};
const LIGHT_DEVICE_TYPES = /* @__PURE__ */ new Set([256, 257, 258, 259, 266, 267]);
const THREAD_ROLE_NAMES = {
  0: "unspecified",
  1: "unassigned",
  2: "sleepy end device",
  3: "end device",
  4: "REED",
  5: "router",
  6: "leader"
};
function jsonReplacer(key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Bytes.toHex(value);
  return value;
}
function stateOf(endpoint, behavior) {
  if (!endpoint.behaviors.has(behavior)) return void 0;
  try {
    return endpoint.stateOf(behavior);
  } catch {
    return void 0;
  }
}
function deviceTypeLabel(endpoint) {
  const descriptor = stateOf(endpoint, DescriptorClient);
  if (descriptor?.deviceTypeList === void 0) return void 0;
  for (const entry of descriptor.deviceTypeList) {
    const name = DEVICE_TYPE_NAMES[Number(entry.deviceType)];
    if (name !== void 0) return name;
  }
  return void 0;
}
function isLightDeviceType(endpoint) {
  const descriptor = stateOf(endpoint, DescriptorClient);
  if (descriptor?.deviceTypeList === void 0) return false;
  return descriptor.deviceTypeList.some(({ deviceType }) => LIGHT_DEVICE_TYPES.has(Number(deviceType)));
}
function endpointLabel(endpoint) {
  return deviceTypeLabel(endpoint) ?? `Endpoint ${endpoint.number}`;
}
function entityKey(nodeId, endpointId, kind) {
  return `${nodeId}/${endpointId}/${kind}`;
}
function extractEntities(nodeId, peer) {
  const entities = [];
  for (const endpoint of peer.endpoints) {
    const onOff = stateOf(endpoint, OnOffClient);
    const level = stateOf(endpoint, LevelControlClient);
    const color = stateOf(endpoint, ColorControlClient);
    const lock = stateOf(endpoint, DoorLockClient);
    const thermostat = stateOf(endpoint, ThermostatClient);
    const covering = stateOf(endpoint, WindowCoveringClient);
    const fan = stateOf(endpoint, FanControlClient);
    if (onOff !== void 0 || level !== void 0) {
      const lightish = color !== void 0 || isLightDeviceType(endpoint);
      const state = { on: onOff?.onOff === true };
      const features = { level: level !== void 0 };
      if (level !== void 0) {
        state.brightness = level.currentLevel === 255 ? null : level.currentLevel;
      }
      if (color !== void 0) {
        features.color = color.currentHue !== void 0 || color.enhancedCurrentHue !== void 0;
        features.colorTemp = color.colorTempPhysicalMinMireds !== void 0 && color.colorTempPhysicalMaxMireds !== void 0;
        state.hue = color.currentHue;
        state.saturation = color.currentSaturation;
        state.enhancedHue = color.enhancedCurrentHue;
        state.colorTempMireds = color.currentColorTempMireds;
        state.colorTempRange = features.colorTemp ? [color.colorTempPhysicalMinMireds, color.colorTempPhysicalMaxMireds] : void 0;
      }
      entities.push({
        key: entityKey(nodeId, endpoint.number, lightish ? "light" : "plug"),
        nodeId,
        endpointId: endpoint.number,
        kind: lightish ? "light" : "plug",
        label: endpointLabel(endpoint),
        state,
        features
      });
    }
    if (lock !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "lock"),
        nodeId,
        endpointId: endpoint.number,
        kind: "lock",
        label: endpointLabel(endpoint),
        state: { lockState: lock.lockState },
        features: {}
      });
    }
    if (thermostat !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "thermostat"),
        nodeId,
        endpointId: endpoint.number,
        kind: "thermostat",
        label: endpointLabel(endpoint),
        state: {
          localTemperature: thermostat.localTemperature ?? null,
          occupiedHeatingSetpoint: thermostat.occupiedHeatingSetpoint ?? null,
          occupiedCoolingSetpoint: thermostat.occupiedCoolingSetpoint ?? null,
          systemMode: thermostat.systemMode ?? null
        },
        features: { cool: thermostat.occupiedCoolingSetpoint !== void 0 }
      });
    }
    if (covering !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "cover"),
        nodeId,
        endpointId: endpoint.number,
        kind: "cover",
        label: endpointLabel(endpoint),
        state: {
          position: scalePercent100ths(covering.currentPositionLiftPercent100ths),
          target: scalePercent100ths(covering.targetPositionLiftPercent100ths),
          operationalStatus: covering.operationalStatus ?? null
        },
        features: {}
      });
    }
    if (fan !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "fan"),
        nodeId,
        endpointId: endpoint.number,
        kind: "fan",
        label: endpointLabel(endpoint),
        state: {
          percentCurrent: fan.percentCurrent ?? null,
          percentSetting: fan.percentSetting ?? null,
          fanMode: fan.fanMode ?? null
        },
        features: {}
      });
    }
    const measuredSensors = [
      [TemperatureMeasurementClient, "temperature", (v) => v / 100],
      [RelativeHumidityMeasurementClient, "humidity", (v) => v / 100],
      [PressureMeasurementClient, "pressure", (v) => v / 100],
      [
        IlluminanceMeasurementClient,
        "illuminance",
        (v) => v === ILLUMINANCE_INVALID ? null : v / 100
      ],
      [FlowMeasurementClient, "flow", (v) => v / 100]
    ];
    for (const [behavior, kind, scale] of measuredSensors) {
      const s = stateOf(endpoint, behavior);
      if (s?.measuredValue === void 0 || s.measuredValue === null) continue;
      entities.push(sensorEntity(nodeId, endpoint, kind, { value: scale(s.measuredValue) }));
    }
    const occupancy = stateOf(endpoint, OccupancySensingClient);
    if (occupancy?.occupancy !== void 0) {
      entities.push(sensorEntity(nodeId, endpoint, "occupancy", { value: occupancy.occupancy.occupied === true }));
    }
    const booleanState = stateOf(endpoint, BooleanStateClient);
    if (booleanState?.stateValue !== void 0) {
      entities.push(sensorEntity(nodeId, endpoint, "contact", { value: booleanState.stateValue === true }));
    }
    const power = stateOf(endpoint, ElectricalPowerMeasurementClient);
    if (power !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "power"),
        nodeId,
        endpointId: endpoint.number,
        kind: "power",
        label: "Power",
        state: {
          activePower: power.activePower ?? null,
          // mW
          voltage: power.voltage ?? null,
          // mV
          current: power.current ?? null
          // mA
        },
        features: {}
      });
    }
    const energy = stateOf(endpoint, ElectricalEnergyMeasurementClient);
    if (energy?.cumulativeEnergyImported?.energy !== void 0) {
      entities.push({
        key: entityKey(nodeId, endpoint.number, "energy"),
        nodeId,
        endpointId: endpoint.number,
        kind: "energy",
        label: "Energy",
        state: { cumulativeImported: energy.cumulativeEnergyImported.energy },
        // mWh
        features: {}
      });
    }
  }
  return entities;
}
function scalePercent100ths(value) {
  if (value === void 0 || value === null) return null;
  return value / 100;
}
function sensorEntity(nodeId, endpoint, kind, state) {
  return {
    key: entityKey(nodeId, endpoint.number, kind),
    nodeId,
    endpointId: endpoint.number,
    kind,
    label: `${endpointLabel(endpoint)}`,
    state,
    features: {}
  };
}
function extractEndpointInfo(endpoint) {
  const descriptor = stateOf(endpoint, DescriptorClient);
  const basic = stateOf(endpoint, BasicInformationClient);
  const thread = stateOf(endpoint, ThreadNetworkDiagnosticsClient);
  return {
    id: endpoint.number,
    deviceTypes: descriptor?.deviceTypeList?.map(({ deviceType, revision }) => ({
      code: Number(deviceType),
      name: DEVICE_TYPE_NAMES[Number(deviceType)] ?? `Type 0x${Number(deviceType).toString(16)}`,
      revision
    })),
    serverList: descriptor?.serverList?.map(Number),
    basic: basic === void 0 ? void 0 : {
      vendorName: basic.vendorName,
      productName: basic.productName,
      productLabel: basic.productLabel,
      serialNumber: basic.serialNumber,
      softwareVersion: basic.softwareVersionString ?? basic.softwareVersion,
      hardwareVersion: basic.hardwareVersionString ?? basic.hardwareVersion,
      reachable: basic.reachable
    },
    thread: thread === void 0 ? void 0 : {
      networkName: thread.networkName,
      channel: thread.channel,
      routingRole: thread.routingRole === void 0 || thread.routingRole === null ? null : THREAD_ROLE_NAMES[thread.routingRole] ?? `role ${thread.routingRole}`,
      partitionId: thread.partitionId,
      rloc16: thread.rloc16 === void 0 || thread.rloc16 === null ? null : `0x${thread.rloc16.toString(16).padStart(4, "0")}`
    }
  };
}
export {
  extractEndpointInfo,
  extractEntities,
  jsonReplacer
};
//# sourceMappingURL=Entities.js.map

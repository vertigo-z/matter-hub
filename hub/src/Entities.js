/**
 * Entity model: maps Matter endpoints + clusters onto flat UI entities.
 *
 * One endpoint can yield one primary controllable entity (light, plug, lock,
 * thermostat, cover, fan) plus any number of sensor entities. State values are
 * read from the controller's subscription cache, so extraction is synchronous
 * and cheap to re-run on every change notification.
 */

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

const ILLUMINANCE_INVALID = 0xffff;

const DEVICE_TYPE_NAMES = {
    0x000a: "Door Lock",
    0x0015: "Contact Sensor",
    0x0016: "Switch",
    0x002b: "Fan",
    0x0075: "Air Conditioner",
    0x0301: "Thermostat",
    0x0302: "Temperature Sensor",
    0x0303: "Pressure Sensor",
    0x0304: "Flow Sensor",
    0x0305: "Humidity Sensor",
    0x0307: "Air Quality Sensor",
    0x0308: "Occupancy Sensor",
    0x0100: "Light",
    0x0101: "Dimmable Light",
    0x0102: "Color Temperature Light",
    0x0103: "Extended Color Light",
    0x0104: "Light Sensor",
    0x010a: "Plug",
    0x010b: "Dimmable Plug",
    0x0202: "Window Covering",
};

const LIGHT_DEVICE_TYPES = new Set([0x0100, 0x0101, 0x0102, 0x0103, 0x010a, 0x010b]);

const THREAD_ROLE_NAMES = {
    0: "unspecified",
    1: "unassigned",
    2: "sleepy end device",
    3: "end device",
    4: "REED",
    5: "router",
    6: "leader",
};

/** Serialize cache state defensively: bigints → strings, byte arrays → hex. */
export function jsonReplacer(key, value) {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Uint8Array) return Bytes.toHex(value);
    return value;
}

function stateOf(endpoint, behavior) {
    if (!endpoint.behaviors.has(behavior)) return undefined;
    try {
        return endpoint.stateOf(behavior);
    } catch {
        return undefined;
    }
}

function deviceTypeLabel(endpoint) {
    const descriptor = stateOf(endpoint, DescriptorClient);
    if (descriptor?.deviceTypeList === undefined) return undefined;
    for (const entry of descriptor.deviceTypeList) {
        const name = DEVICE_TYPE_NAMES[Number(entry.deviceType)];
        if (name !== undefined) return name;
    }
    return undefined;
}

function isLightDeviceType(endpoint) {
    const descriptor = stateOf(endpoint, DescriptorClient);
    if (descriptor?.deviceTypeList === undefined) return false;
    return descriptor.deviceTypeList.some(({ deviceType }) => LIGHT_DEVICE_TYPES.has(Number(deviceType)));
}

function endpointLabel(endpoint) {
    return deviceTypeLabel(endpoint) ?? `Endpoint ${endpoint.number}`;
}

function entityKey(nodeId, endpointId, kind) {
    return `${nodeId}/${endpointId}/${kind}`;
}

/** Build the entity list for one commissioned peer. */
export function extractEntities(nodeId, peer) {
    const entities = [];

    for (const endpoint of peer.endpoints) {
        const onOff = stateOf(endpoint, OnOffClient);
        const level = stateOf(endpoint, LevelControlClient);
        const color = stateOf(endpoint, ColorControlClient);
        const lock = stateOf(endpoint, DoorLockClient);
        const thermostat = stateOf(endpoint, ThermostatClient);
        const covering = stateOf(endpoint, WindowCoveringClient);
        const fan = stateOf(endpoint, FanControlClient);

        if (onOff !== undefined || level !== undefined) {
            const lightish = color !== undefined || isLightDeviceType(endpoint);
            const state = { on: onOff?.onOff === true };
            const features = { level: level !== undefined };
            if (level !== undefined) {
                state.brightness = level.currentLevel === 255 ? null : level.currentLevel;
            }
            if (color !== undefined) {
                features.color = color.currentHue !== undefined || color.enhancedCurrentHue !== undefined;
                features.colorTemp =
                    color.colorTempPhysicalMinMireds !== undefined && color.colorTempPhysicalMaxMireds !== undefined;
                state.hue = color.currentHue;
                state.saturation = color.currentSaturation;
                state.enhancedHue = color.enhancedCurrentHue;
                state.colorTempMireds = color.currentColorTempMireds;
                state.colorTempRange = features.colorTemp
                    ? [color.colorTempPhysicalMinMireds, color.colorTempPhysicalMaxMireds]
                    : undefined;
            }
            entities.push({
                key: entityKey(nodeId, endpoint.number, lightish ? "light" : "plug"),
                nodeId,
                endpointId: endpoint.number,
                kind: lightish ? "light" : "plug",
                label: endpointLabel(endpoint),
                state,
                features,
            });
        }

        if (lock !== undefined) {
            entities.push({
                key: entityKey(nodeId, endpoint.number, "lock"),
                nodeId,
                endpointId: endpoint.number,
                kind: "lock",
                label: endpointLabel(endpoint),
                state: { lockState: lock.lockState },
                features: {},
            });
        }

        if (thermostat !== undefined) {
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
                    systemMode: thermostat.systemMode ?? null,
                },
                features: { cool: thermostat.occupiedCoolingSetpoint !== undefined },
            });
        }

        if (covering !== undefined) {
            entities.push({
                key: entityKey(nodeId, endpoint.number, "cover"),
                nodeId,
                endpointId: endpoint.number,
                kind: "cover",
                label: endpointLabel(endpoint),
                state: {
                    position: scalePercent100ths(covering.currentPositionLiftPercent100ths),
                    target: scalePercent100ths(covering.targetPositionLiftPercent100ths),
                    operationalStatus: covering.operationalStatus ?? null,
                },
                features: {},
            });
        }

        if (fan !== undefined) {
            entities.push({
                key: entityKey(nodeId, endpoint.number, "fan"),
                nodeId,
                endpointId: endpoint.number,
                kind: "fan",
                label: endpointLabel(endpoint),
                state: {
                    percentCurrent: fan.percentCurrent ?? null,
                    percentSetting: fan.percentSetting ?? null,
                    fanMode: fan.fanMode ?? null,
                },
                features: {},
            });
        }

        // Sensors: several per endpoint possible; each cluster found becomes one entity.
        const measuredSensors = [
            [TemperatureMeasurementClient, "temperature", v => v / 100],
            [RelativeHumidityMeasurementClient, "humidity", v => v / 100],
            [PressureMeasurementClient, "pressure", v => v / 100],
            [
                IlluminanceMeasurementClient,
                "illuminance",
                v => (v === ILLUMINANCE_INVALID ? null : v / 100),
            ],
            [FlowMeasurementClient, "flow", v => v / 100],
        ];
        for (const [behavior, kind, scale] of measuredSensors) {
            const s = stateOf(endpoint, behavior);
            if (s?.measuredValue === undefined || s.measuredValue === null) continue;
            entities.push(sensorEntity(nodeId, endpoint, kind, { value: scale(s.measuredValue) }));
        }

        const occupancy = stateOf(endpoint, OccupancySensingClient);
        if (occupancy?.occupancy !== undefined) {
            entities.push(sensorEntity(nodeId, endpoint, "occupancy", { value: occupancy.occupancy.occupied === true }));
        }

        const booleanState = stateOf(endpoint, BooleanStateClient);
        if (booleanState?.stateValue !== undefined) {
            entities.push(sensorEntity(nodeId, endpoint, "contact", { value: booleanState.stateValue === true }));
        }

        const power = stateOf(endpoint, ElectricalPowerMeasurementClient);
        if (power !== undefined) {
            entities.push({
                key: entityKey(nodeId, endpoint.number, "power"),
                nodeId,
                endpointId: endpoint.number,
                kind: "power",
                label: "Power",
                state: {
                    activePower: power.activePower ?? null, // mW
                    voltage: power.voltage ?? null, // mV
                    current: power.current ?? null, // mA
                },
                features: {},
            });
        }

        const energy = stateOf(endpoint, ElectricalEnergyMeasurementClient);
        if (energy?.cumulativeEnergyImported?.energy !== undefined) {
            entities.push({
                key: entityKey(nodeId, endpoint.number, "energy"),
                nodeId,
                endpointId: endpoint.number,
                kind: "energy",
                label: "Energy",
                state: { cumulativeImported: energy.cumulativeEnergyImported.energy }, // mWh
                features: {},
            });
        }
    }

    return entities;
}

function scalePercent100ths(value) {
    if (value === undefined || value === null) return null;
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
        features: {},
    };
}

/** Endpoint meta for the device detail view. */
export function extractEndpointInfo(endpoint) {
    const descriptor = stateOf(endpoint, DescriptorClient);
    const basic = stateOf(endpoint, BasicInformationClient);
    const thread = stateOf(endpoint, ThreadNetworkDiagnosticsClient);
    return {
        id: endpoint.number,
        deviceTypes: descriptor?.deviceTypeList?.map(({ deviceType, revision }) => ({
            code: Number(deviceType),
            name: DEVICE_TYPE_NAMES[Number(deviceType)] ?? `Type 0x${Number(deviceType).toString(16)}`,
            revision,
        })),
        serverList: descriptor?.serverList?.map(Number),
        basic:
            basic === undefined
                ? undefined
                : {
                      vendorName: basic.vendorName,
                      productName: basic.productName,
                      productLabel: basic.productLabel,
                      serialNumber: basic.serialNumber,
                      softwareVersion: basic.softwareVersionString ?? basic.softwareVersion,
                      hardwareVersion: basic.hardwareVersionString ?? basic.hardwareVersion,
                      reachable: basic.reachable,
                  },
        thread:
            thread === undefined
                ? undefined
                : {
                      networkName: thread.networkName,
                      channel: thread.channel,
                      routingRole:
                          thread.routingRole === undefined || thread.routingRole === null
                              ? null
                              : (THREAD_ROLE_NAMES[thread.routingRole] ?? `role ${thread.routingRole}`),
                      partitionId: thread.partitionId,
                      rloc16:
                          thread.rloc16 === undefined || thread.rloc16 === null
                              ? null
                              : `0x${thread.rloc16.toString(16).padStart(4, "0")}`,
                  },
    };
}

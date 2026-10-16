import { ImplementationError, Seconds } from "@matter/general";
import { require } from "@matter/nodejs-ble/require";
import { BtpCodec, MatterBle } from "@matter/protocol";

/** Observes the same noble singleton used by matter.js; never opens a second adapter instance. */
export class BleStatus {
    #noble;
    #report;
    #listeners;
    #seen = new Set();
    #lastWarning;
    #state = "unknown";
    #scanning = false;

    constructor(report) {
        this.#report = report;
        this.#noble = require("@stoprocent/noble");
        this.#listeners = {
            stateChange: state => {
                this.#state = state;
                report(`Bluetooth adapter state: ${state}`);
            },
            warning: message => {
                this.#lastWarning = String(message);
                report(`Bluetooth warning: ${message}`);
            },
            scanStart: () => {
                this.#scanning = true;
                report("Bluetooth driver confirmed scan start");
            },
            scanStop: () => {
                this.#scanning = false;
                report("Bluetooth driver reported scan stop");
            },
            discover: peripheral => this.#discovered(peripheral),
        };
        for (const [event, listener] of Object.entries(this.#listeners)) {
            this.#noble.on(event, listener);
        }
        this.#state = this.#noble.state;
    }

    get state() {
        return { adapterState: this.#state, scanning: this.#scanning, lastWarning: this.#lastWarning };
    }

    async ready() {
        this.#report(`Waiting for Bluetooth adapter (current state: ${this.#noble.state})`);
        try {
            await this.#noble.waitForPoweredOnAsync(Seconds(10));
        } catch (cause) {
            throw new ImplementationError(
                `Bluetooth adapter did not become ready within 10 seconds; state: ${this.#noble.state}` +
                    (this.#lastWarning ? `; ${this.#lastWarning}` : ""),
                { cause },
            );
        }
    }

    async prepareScan() {
        await this.ready();
        this.#seen.clear();
        this.#lastWarning = undefined;
        this.#report("Requesting a Matter BLE scan");
    }

    #discovered(peripheral) {
        const service = peripheral.advertisement.serviceData?.find(item => MatterBle.isServiceUuid(item.uuid));
        if (!service || service.data.length !== 8 || this.#seen.has(peripheral.address)) return;
        try {
            const { discriminator } = BtpCodec.decodeBleAdvertisementServiceData(service.data);
            this.#seen.add(peripheral.address);
            this.#report(`Matter BLE advertisement: ${peripheral.advertisement.localName ?? peripheral.address}; discriminator ${discriminator}`);
        } catch (error) {
            this.#report(`Cannot decode Matter BLE advertisement from ${peripheral.address}: ${error.message}`);
        }
    }

    close() {
        for (const [event, listener] of Object.entries(this.#listeners)) {
            this.#noble.off(event, listener);
        }
    }
}

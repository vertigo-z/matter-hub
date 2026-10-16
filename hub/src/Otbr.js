/**
 * OpenThread Border Router (OTBR) REST integration.
 *
 * Assumes an OTBR container (e.g. ghcr.io/project-chip/openthread-border-router)
 * with the REST API exposed on port 8081. Provides:
 *  - status snapshot for the Thread page (node info, redacted dataset, commissioner)
 *  - the raw active Operational Dataset TLV used as Thread credentials when
 *    commissioning Matter-over-Thread devices
 */

import { Bytes } from "@matter/general";
import { OperationalDataset } from "@matter/protocol";
import { OtbrRestClient } from "@matter/thread-br-client";

export class Otbr {
    #settings;

    constructor(settings) {
        this.#settings = settings;
    }

    get configured() {
        return typeof this.#settings.otbrHost === "string" && this.#settings.otbrHost.length > 0;
    }

    #client() {
        return new OtbrRestClient({
            host: this.#settings.otbrHost,
            port: this.#settings.otbrPort,
            timeoutMs: 4000,
        });
    }

    /**
     * Thread network credentials for commissioning. Returns the raw TLV hex the
     * OTBR serves — never a re-encode — so devices receive the exact dataset the
     * border router formed the network with.
     */
    async threadCredentials() {
        if (!this.configured) return undefined;
        const { activeHex } = await this.#client().getDataset();
        if (activeHex === undefined) return undefined;
        const decoded = OperationalDataset.decode(activeHex);
        return {
            networkName: decoded.networkName,
            operationalDataset: activeHex.toLowerCase(),
            channel: decoded.channel,
            extPanId: decoded.extPanId instanceof Uint8Array ? Bytes.toHex(decoded.extPanId) : undefined,
        };
    }

    /** Full status snapshot for the Thread page; never throws. */
    async status() {
        if (!this.configured) {
            return { online: false, configured: false };
        }
        const client = this.#client();
        const status = {
            configured: true,
            online: false,
            host: this.#settings.otbrHost,
            port: this.#settings.otbrPort,
        };
        try {
            status.node = await client.getNode();
            status.online = true;
        } catch (error) {
            status.error = error.message;
            return status;
        }

        try {
            const { activeHex } = await client.getDataset();
            if (activeHex !== undefined) {
                status.dataset = presentDataset(OperationalDataset.decode(activeHex));
            }
        } catch (error) {
            status.datasetError = error.message;
        }

        for (const [field, method] of [
            ["commissionerState", () => client.getCommissionerState()],
            ["coprocessorVersion", () => client.getCoprocessorVersion()],
        ]) {
            try {
                status[field] = await method();
            } catch {
                // Optional endpoints (404 on firmware without them) — just omit.
            }
        }

        try {
            status.joiners = await client.getJoiners();
        } catch {
            // Optional.
        }

        return status;
    }
}

/** Human-ready dataset summary with secrets stripped. */
function presentDataset(dataset) {
    const safe = OperationalDataset.redact(dataset);
    return {
        networkName: safe.networkName,
        channel: safe.channel,
        panId: safe.panId === undefined ? undefined : `0x${safe.panId.toString(16)}`,
        extPanId: safe.extPanId instanceof Uint8Array ? Bytes.toHex(safe.extPanId) : undefined,
        meshLocalPrefix:
            safe.meshLocalPrefix instanceof Uint8Array ? formatPrefix(Bytes.toHex(safe.meshLocalPrefix)) : undefined,
        // pskc / networkKey are removed by redact() and intentionally absent here
    };
}

function formatPrefix(hex) {
    const bytes = hex.match(/../g) ?? [];
    const hextets = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        hextets.push(((parseInt(bytes[i], 16) << 8) | parseInt(bytes[i + 1], 16)).toString(16));
    }
    return `${hextets.join(":")}::/64`;
}

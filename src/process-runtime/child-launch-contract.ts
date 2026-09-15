import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";

import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	ChildProcessBootstrapSchema,
	CHILD_LAUNCH_ALIGNMENT_GUIDANCE,
	describeChildBootstrapFailure,
} from "../control/control-protocol-schemas.ts";

const execFileAsync = promisify(execFile);
const SCHEMA_MODULE_URL = new URL("../control/control-protocol-schemas.ts", import.meta.url);
const PROBE_TIMEOUT_MS = 5_000;
// Strip TypeBox-only symbol metadata before comparing the transportable contract.
const OWNER_BOOTSTRAP_SCHEMA = JSON.parse(JSON.stringify(ChildProcessBootstrapSchema));

/** Host-local rejection is permanent: retrying work cannot align an installed package. */
export class ChildLaunchContractGuard {
	readonly #schemaModuleUrl: URL;
	#failure: Error | undefined;

	constructor(schemaModuleUrl = SCHEMA_MODULE_URL) {
		this.#schemaModuleUrl = schemaModuleUrl;
	}

	async assertCompatible(): Promise<void> {
		if (this.#failure) throw this.#failure;
		try {
			// A cache-busted import in this process still shares cached transitive modules.
			// A fresh Node process sees the same on-disk schema the next Pi child will load.
			const { stdout } = await execFileAsync(process.execPath, [
				"--input-type=module", "--eval",
				`const schema = await import(${JSON.stringify(this.#schemaModuleUrl.href)}); process.stdout.write(JSON.stringify({version: schema.AGENT_CONTROL_PROTOCOL_VERSION, bootstrap: schema.ChildProcessBootstrapSchema}));`,
			], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 });
			const contract = JSON.parse(stdout) as { version: unknown; bootstrap: unknown };
			if (contract.version !== AGENT_CONTROL_PROTOCOL_VERSION || !isDeepStrictEqual(contract.bootstrap, OWNER_BOOTSTRAP_SCHEMA)) {
				if (typeof contract.bootstrap !== "object" || contract.bootstrap === null) {
					throw new Error(describeChildBootstrapFailure(contract.version, AGENT_CONTROL_PROTOCOL_VERSION, [], ["bootstrapSchema"]));
				}
				const schema = contract.bootstrap as { required?: string[]; properties?: Record<string, unknown> };
				const required = new Set(schema.required ?? []);
				const ownerRequired = new Set<string>(OWNER_BOOTSTRAP_SCHEMA.required);
				const missing = [...required].filter(field => !ownerRequired.has(field));
				const properties = schema.properties ?? {};
				const invalid = [...new Set([...Object.keys(properties), ...Object.keys(OWNER_BOOTSTRAP_SCHEMA.properties)])].filter(field =>
					!missing.includes(field) && (
						!isDeepStrictEqual(properties[field], OWNER_BOOTSTRAP_SCHEMA.properties[field]) ||
						required.has(field) !== ownerRequired.has(field)
					)
				);
				if (!Number.isSafeInteger(contract.version) && !invalid.includes("protocolVersion")) invalid.push("protocolVersion");
				if (missing.length === 0 && invalid.length === 0 && contract.version === AGENT_CONTROL_PROTOCOL_VERSION) {
					invalid.push("descriptor constraints");
				}
				// Schema-owned names are safe; never print constraints or descriptor values.
				throw new Error(describeChildBootstrapFailure(
					contract.version, AGENT_CONTROL_PROTOCOL_VERSION, missing, invalid,
				));
			}
		} catch (error) {
			// Never forward subprocess stderr or descriptors, which can contain secrets.
			const detail = error instanceof Error && /^control_bootstrap_(invalid|protocol_mismatch|schema_drift):/.test(error.message)
				? error.message
				: "control_bootstrap_probe_failed: could not verify the installed child launch contract";
			this.#failure ??= new Error(`${detail}. ${CHILD_LAUNCH_ALIGNMENT_GUIDANCE}`);
			throw this.#failure;
		}
		// A concurrent probe may already have rejected this host's launch path.
		if (this.#failure) throw this.#failure;
	}
}

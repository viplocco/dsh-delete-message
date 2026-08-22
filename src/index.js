/**
 * Re-export surface for tooling; the harness consumes `./plugin` (host half,
 * via cordis.patch.yml) and `./client` (browser half, via `dsh.client`).
 *
 * @module dsh-delete-message
 */
export { name, inject, apply, buildStatus, deleteMessage, VERSION } from "./plugin.js";
export { assessDeletion, buildPlaceholder, hasToolUse, insideOpenTurn, REFUSALS } from "./surface.js";
export {
	BASE_PATH,
	STATUS_PATH,
	DELETE_PATH,
	registerRoutes,
	attachRoutes,
	screenRequest,
	isLoopbackAddress,
	hostNameOf,
	parseQuery,
	readJsonBody
} from "./http.js";

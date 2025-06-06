import * as core from "@actions/core";

export function getModeFromInput() {
	const mode = core.getInput("mode");
	if (mode !== "pause" && mode !== "background") {
		throw new Error(`Invalid mode "${mode}" specified, must be one of "pause", "background"`);
	}

	return mode;
}

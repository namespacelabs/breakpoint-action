import * as core from "@actions/core";

export type Mode = "pause" | "background" | "pause-idle";

export function getModeFromInput(): Mode {
	const mode = core.getInput("mode");
	if (mode !== "pause" && mode !== "background" && mode !== "pause-idle") {
		throw new Error(`Invalid mode "${mode}" specified, must be one of "pause", "background", "pause-idle"`);
	}
	return mode;
}

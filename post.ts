import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { getModeFromInput } from "./lib";

async function run(): Promise<void> {
	try {
		const mode = getModeFromInput();

		if (mode === "background") {
			core.debug(`Starting hold at ${new Date().toTimeString()}`);
			await exec.exec(`breakpoint hold --while-connected --stop`);
			core.debug(`Finished hold at ${new Date().toTimeString()}`);
		}
	} catch (err) {
		core.info("Error encountered while waiting for breakpoint to finish, it might've been stopped manually");
		core.debug(err);
	}
}

run();

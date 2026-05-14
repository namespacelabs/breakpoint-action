import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { getModeFromInput } from "./lib";

const STATE_CHECK_RUN_ID = "breakpoint_check_run_id";
const STATE_CHECK_RUN_REPO = "breakpoint_check_run_repo";

async function resolveBreakpointCheckRun(): Promise<void> {
	const checkRunId = core.getState(STATE_CHECK_RUN_ID);
	const repo = core.getState(STATE_CHECK_RUN_REPO);
	const token = core.getInput("github-token");

	if (!checkRunId || !repo || !token) {
		return;
	}

	const conclusion = core.getInput("check-run-conclusion-on-resume") || "success";
	const body = {
		status: "completed",
		conclusion,
		output: {
			title: "SSH breakpoint resumed",
			summary: `Breakpoint exited at ${new Date().toISOString()}.`,
		},
	};

	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/check-runs/${checkRunId}`, {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "breakpoint-action",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			core.warning(`Failed to update Check Run ${checkRunId} (${res.status}): ${text.slice(0, 200)}`);
			return;
		}
		core.info(`Updated Check Run ${checkRunId} -> conclusion=${conclusion}`);
	} catch (err) {
		core.warning(`Error updating Check Run: ${err}`);
	}
}

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

	// Always try to resolve the breakpoint Check Run, regardless of mode or
	// whether the action errored.
	await resolveBreakpointCheckRun();
}

run();

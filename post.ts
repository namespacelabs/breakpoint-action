import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { getModeFromInput } from "./lib";

const STATE_COMMENT_ID = "breakpoint_comment_id";
const STATE_COMMENT_REPO = "breakpoint_comment_repo";

async function deletePRComment(): Promise<void> {
	const commentId = core.getState(STATE_COMMENT_ID);
	const repo = core.getState(STATE_COMMENT_REPO);
	const token = core.getInput("github-token");

	if (!commentId || !repo || !token) {
		return;
	}

	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/issues/comments/${commentId}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "breakpoint-action",
			},
		});
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			core.warning(`Failed to delete PR comment (${res.status}): ${text.slice(0, 200)}`);
			return;
		}
		core.info(`Deleted PR comment ${commentId}`);
	} catch (err) {
		core.warning(`Error deleting PR comment: ${err}`);
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

	// Always try cleanup, regardless of mode or whether the action errored.
	await deletePRComment();
}

run();

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModeFromInput } from "./lib";

const defaultBreakpointVersion = "0.0.24";

// Matches the "Connect with: ssh -p <PORT> <USER>@<HOST>" line emitted by
// the breakpoint binary once the rendezvous tunnel is established.
const sshLineRegex = /Connect with:\s*(ssh\s+-p\s+\d+\s+\S+@\S+)/;

const STATE_CHECK_RUN_ID = "breakpoint_check_run_id";
const STATE_CHECK_RUN_REPO = "breakpoint_check_run_repo";

function getBreakpointVersion(): string {
	const override = process.env.BREAKPOINT_VERSION?.trim().replace(/^v/, "");
	if (override) {
		core.info(`Using breakpoint version from BREAKPOINT_VERSION: ${override}`);
		return override;
	}
	return defaultBreakpointVersion;
}

interface WaitConfig {
	endpoint: string;
	duration: string;
	authorized_keys?: string[];
	authorized_github_users?: string[];
	shell?: string[];
	allowed_ssh_users: string[];
	webhooks?: Webhook[];
	slack_bot?: SlackBot;
}

class Webhook {
	url: string;
	payload: unknown;
}

class SlackBot {
	channel: string;
	token: string;
}

async function run(): Promise<void> {
	try {
		await installBreakpoint();
		await runBreakpoint();
	} catch (err) {
		core.setFailed(err.message);
	}
}

async function installBreakpoint(): Promise<void> {
	const toolURL = await getDownloadURL();
	core.info(`Downloading: ${toolURL}`);

	const pathToTarball = await tc.downloadTool(toolURL, null, null, {
		CI: process.env.CI,
		"User-Agent": "breakpoint-action",
		accept: "application/octet-stream",
	});

	const pathToCLI = await tc.extractTar(pathToTarball);
	core.addPath(pathToCLI);
}

// -------------------- Check Run signalling --------------------

interface CheckRunContext {
	name: string;
	summaryTemplate: string;
	token: string;
	owner: string;
	repo: string;
	headSha: string;
}

function readCheckRunContext(): CheckRunContext | null {
	const name = core.getInput("check-run-name");
	if (!name) {
		return null;
	}

	const token = core.getInput("github-token");
	if (!token) {
		core.warning("check-run-name is set but no github-token provided; skipping Check Run signal.");
		return null;
	}

	const repository = process.env.GITHUB_REPOSITORY;
	if (!repository) {
		core.warning("Missing GITHUB_REPOSITORY; skipping Check Run signal.");
		return null;
	}
	const [owner, repo] = repository.split("/");

	const headSha = resolveHeadSha();
	if (!headSha) {
		core.warning("Could not determine head SHA; skipping Check Run signal.");
		return null;
	}

	return {
		name,
		summaryTemplate: core.getInput("check-run-summary-template") || "## SSH breakpoint open\n\n```\n{endpoint}\n```",
		token,
		owner,
		repo,
		headSha,
	};
}

// In pull_request workflows, GITHUB_SHA is the merge commit. Check Runs need
// the PR head SHA so they surface on the PR's Checks tab — pull it from the
// event payload when present, fall back to GITHUB_SHA otherwise.
function resolveHeadSha(): string | null {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (eventPath) {
		try {
			const evt = JSON.parse(fs.readFileSync(eventPath, "utf8"));
			const prHead = evt?.pull_request?.head?.sha;
			if (prHead) return prHead;
		} catch (err) {
			core.debug(`Failed to read event payload: ${err}`);
		}
	}
	return process.env.GITHUB_SHA || null;
}

async function createBreakpointCheckRun(ctx: CheckRunContext, endpoint: string): Promise<number | null> {
	const summary = ctx.summaryTemplate.split("{endpoint}").join(endpoint);
	const body = {
		name: ctx.name,
		head_sha: ctx.headSha,
		status: "completed",
		conclusion: "failure",
		output: {
			title: "SSH breakpoint open — paused for debug",
			summary,
		},
	};

	try {
		const res = await fetch(`https://api.github.com/repos/${ctx.owner}/${ctx.repo}/check-runs`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "breakpoint-action",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			core.warning(`Failed to create Check Run (${res.status}): ${text.slice(0, 200)}`);
			return null;
		}
		const json = (await res.json()) as { id: number };
		core.info(`Created Check Run ${json.id} ("${ctx.name}") with conclusion=failure`);
		return json.id;
	} catch (err) {
		core.warning(`Error creating Check Run: ${err}`);
		return null;
	}
}

// -------------------- Endpoint detection --------------------

// EndpointDetector centralises the "watch breakpoint output, surface the SSH
// endpoint" logic. The same detector is fed both by stdout listeners of
// long-running `breakpoint wait`/`breakpoint start` calls and by the output
// of periodic `breakpoint status` polls during `pause-idle`.
interface EndpointDetector {
	feed: (text: string) => Promise<void>;
	execOpts: exec.ExecOptions;
}

function makeEndpointDetector(checkRunCtx: CheckRunContext | null): EndpointDetector {
	let captured = "";
	let done = false;

	const feed = async (text: string): Promise<void> => {
		if (done || !text) return;
		captured += text;
		const match = captured.match(sshLineRegex);
		if (!match) return;

		done = true;
		const endpoint = match[1].trim();
		core.setOutput("endpoint", endpoint);
		core.notice(endpoint, { title: "SSH breakpoint endpoint" });
		core.info(`Detected SSH endpoint: ${endpoint}`);

		if (checkRunCtx) {
			const id = await createBreakpointCheckRun(checkRunCtx, endpoint);
			if (id !== null) {
				core.saveState(STATE_CHECK_RUN_ID, String(id));
				core.saveState(STATE_CHECK_RUN_REPO, `${checkRunCtx.owner}/${checkRunCtx.repo}`);
			}
		}
	};

	const execOpts: exec.ExecOptions = {
		listeners: {
			stdout: (data: Buffer) => {
				const text = data.toString();
				process.stdout.write(text);
				void feed(text);
			},
		},
		// We do our own writing to stdout so we don't double up.
		silent: true,
	};

	return { feed, execOpts };
}

// -------------------- Mode dispatch --------------------

async function runBreakpoint(): Promise<void> {
	const configFile = tmpFile("config.json");
	const config = createConfiguration();
	const mode = getModeFromInput();

	core.debug(`Mode: ${mode}`);

	if (mode === "background" || mode === "pause-idle") {
		// Duration is managed differently in these modes.
		config.duration = "10h";
	}

	core.debug(`Configuration: ${JSON.stringify(config)}`);
	// Write the file synchronously — the original async version had a race
	// against the immediately-following exec.
	fs.writeFileSync(configFile, JSON.stringify(config));

	const checkRunCtx = readCheckRunContext();
	const detector = makeEndpointDetector(checkRunCtx);

	core.debug(new Date().toTimeString());
	switch (mode) {
		case "pause":
			await exec.exec(`breakpoint wait --config=${configFile}`, [], detector.execOpts);
			break;

		case "background":
			await exec.exec(`breakpoint start --config=${configFile}`, [], detector.execOpts);
			break;

		case "pause-idle":
			await runPauseIdle(configFile, detector);
			break;
	}
	core.debug(new Date().toTimeString());
}

// -------------------- pause-idle implementation --------------------

function parseDurationToMs(input: string, fallbackMs: number): number {
	const m = input.match(/^(\d+)\s*(ms|s|m|h)?$/);
	if (!m) return fallbackMs;
	const n = parseInt(m[1], 10);
	const unit = m[2] || "s";
	switch (unit) {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "m":
			return n * 60 * 1000;
		case "h":
			return n * 60 * 60 * 1000;
	}
	return fallbackMs;
}

// pollStatus runs `breakpoint status`, feeds its output to the endpoint
// detector (so we surface the SSH endpoint on the first poll where it appears
// — `breakpoint start` itself does not print it), and returns the number of
// currently-active SSH connections. Returns null when the daemon is no longer
// reachable.
async function pollStatus(detector: EndpointDetector): Promise<number | null> {
	let output = "";
	const exitCode = await exec.exec("breakpoint", ["status"], {
		listeners: {
			stdout: (data: Buffer) => {
				output += data.toString();
			},
			stderr: () => {
				/* swallow */
			},
		},
		ignoreReturnCode: true,
		silent: true,
	});
	if (exitCode !== 0) {
		return null;
	}
	await detector.feed(output);
	const match = output.match(/Active connections:\s*(\d+)/);
	return match ? parseInt(match[1], 10) : 0;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPauseIdle(configFile: string, detector: EndpointDetector): Promise<void> {
	// Start the daemon. `breakpoint start` returns once the rendezvous tunnel
	// is up; the SSH endpoint is then printed by `breakpoint status` (which we
	// poll below), not by `start` itself.
	await exec.exec(`breakpoint start --config=${configFile}`, [], detector.execOpts);

	const graceMs = parseDurationToMs(core.getInput("grace-period") || "20m", 20 * 60 * 1000);
	const idleMs = parseDurationToMs(core.getInput("idle-timeout") || "10m", 10 * 60 * 1000);
	const pollMs = 5000;

	core.info(`pause-idle: grace=${graceMs}ms, idle-timeout=${idleMs}ms (waiting for first SSH connection)`);

	const graceDeadline = Date.now() + graceMs;
	let everConnected = false;
	while (Date.now() < graceDeadline) {
		const conns = await pollStatus(detector);
		if (conns === null) {
			core.info("breakpoint daemon is no longer reachable; exiting pause-idle");
			return;
		}
		if (conns > 0) {
			everConnected = true;
			core.info(`pause-idle: SSH session connected (${conns} active), entering idle-aware wait`);
			break;
		}
		await sleep(pollMs);
	}

	if (!everConnected) {
		core.info("pause-idle: no SSH connection during grace period, stopping breakpoint");
		await stopBreakpoint();
		return;
	}

	let lastSeenConnectedAt = Date.now();
	while (true) {
		const conns = await pollStatus(detector);
		if (conns === null) {
			core.info("breakpoint daemon stopped externally; exiting pause-idle");
			return;
		}
		if (conns > 0) {
			lastSeenConnectedAt = Date.now();
		} else if (Date.now() - lastSeenConnectedAt > idleMs) {
			core.info(`pause-idle: idle for ${idleMs}ms with no connections, stopping breakpoint`);
			await stopBreakpoint();
			return;
		}
		await sleep(pollMs);
	}
}

async function stopBreakpoint(): Promise<void> {
	try {
		await exec.exec("breakpoint", ["resume"], { ignoreReturnCode: true, silent: true });
	} catch (err) {
		core.debug(`Error stopping breakpoint: ${err}`);
	}
}

// -------------------- Tool download --------------------

async function getDownloadURL(): Promise<string> {
	const { RUNNER_ARCH, RUNNER_OS } = process.env;

	let arch = "";
	switch (RUNNER_ARCH) {
		case "X64":
			arch = "amd64";
			break;
		case "ARM64":
			arch = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${RUNNER_ARCH}`);
	}

	let os = "";
	switch (RUNNER_OS) {
		case "macOS":
			os = "darwin";
			break;
		case "Linux":
			os = "linux";
			break;
		case "Windows":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported operating system: ${RUNNER_OS}`);
	}

	const version = getBreakpointVersion();
	return `https://github.com/namespacelabs/breakpoint/releases/download/v${version}/breakpoint_${os}_${arch}.tar.gz`;
}

function createConfiguration(): WaitConfig {
	const config: WaitConfig = {
		endpoint: core.getInput("endpoint"),
		duration: core.getInput("duration"),
		allowed_ssh_users: ["runner"],
	};

	let authorized = false;
	const authorizedUsers: string = core.getInput("authorized-users");
	if (authorizedUsers) {
		config.authorized_github_users = authorizedUsers.split(",").map((u) => String(u).trim());
		authorized = true;
	}

	const authorizedKeys: string = core.getInput("authorized-keys");
	if (authorizedKeys) {
		config.authorized_keys = authorizedKeys.split(",").map((k) => String(k).trim());
		authorized = true;
	}

	if (!authorized) {
		throw new Error("Neither 'authorized-users' nor 'authorized-keys' is provided.");
	}

	const webhookDefFile: string = core.getInput("webhook-definition");
	if (webhookDefFile) {
		const webhookDef: string = fs.readFileSync(webhookDefFile, "utf8");
		config.webhooks = [JSON.parse(webhookDef)];
	}

	const shell: string = core.getInput("shell");
	if (shell) {
		config.shell = [shell];
	} else if (process.env.RUNNER_OS === "Windows") {
		config.shell = ["c:\\windows\\system32\\cmd.exe"];
	}

	const slackChannel: string = core.getInput("slack-announce-channel");
	if (slackChannel) {
		const slackBot: SlackBot = {
			channel: slackChannel,
			token: "${SLACK_BOT_TOKEN}",
		};
		config.slack_bot = slackBot;
	}

	return config;
}

function tmpFile(file: string): string {
	const tmpDir = path.join(process.env.RUNNER_TEMP, "breakpoint");
	if (!fs.existsSync(tmpDir)) {
		fs.mkdirSync(tmpDir);
	}

	return path.join(tmpDir, file);
}

run();

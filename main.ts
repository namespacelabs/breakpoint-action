import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModeFromInput, Mode } from "./lib";

const defaultBreakpointVersion = "0.0.24";

// Matches the "Connect with: ssh -p <PORT> <USER>@<HOST>" line emitted by
// the breakpoint binary once the rendezvous tunnel is established.
const sshLineRegex = /Connect with:\s*(ssh\s+-p\s+\d+\s+\S+@\S+)/;

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

// State used to coordinate with post.ts for PR comment cleanup.
const STATE_COMMENT_ID = "breakpoint_comment_id";
const STATE_COMMENT_REPO = "breakpoint_comment_repo";

interface CommentContext {
	enabled: boolean;
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
	marker: string;
	extraHint: string;
}

function readCommentContext(): CommentContext | null {
	const enabled = core.getInput("comment-on-pr").toLowerCase() === "true";
	if (!enabled) {
		return null;
	}

	const token = core.getInput("github-token");
	if (!token) {
		core.warning("comment-on-pr is enabled but no github-token provided; skipping PR comment.");
		return null;
	}

	const eventPath = process.env.GITHUB_EVENT_PATH;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!eventPath || !repository) {
		core.warning("Missing GITHUB_EVENT_PATH or GITHUB_REPOSITORY; skipping PR comment.");
		return null;
	}

	let prNumber = 0;
	try {
		const evt = JSON.parse(fs.readFileSync(eventPath, "utf8"));
		prNumber = evt?.pull_request?.number ?? evt?.number ?? 0;
	} catch (err) {
		core.warning(`Failed to read event payload: ${err}`);
		return null;
	}
	if (!prNumber) {
		core.warning("No pull_request.number on the event payload; skipping PR comment.");
		return null;
	}

	const [owner, repo] = repository.split("/");
	return {
		enabled: true,
		token,
		owner,
		repo,
		prNumber,
		marker: core.getInput("comment-marker") || "BREAKPOINT_OPEN",
		extraHint: core.getInput("comment-extra-hint") || "",
	};
}

function buildCommentBody(ctx: CommentContext, endpoint: string, runId: string): string {
	const lines = [`<!-- ${ctx.marker} run=${runId} -->`, `🔴 **SSH breakpoint open**`, "", "```", endpoint, "```"];
	if (ctx.extraHint) {
		lines.push("", ctx.extraHint);
	}
	lines.push("", `_The comment is removed automatically when the breakpoint exits._`);
	return lines.join("\n");
}

async function postPRComment(ctx: CommentContext, body: string): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"Content-Type": "application/json",
				Accept: "application/vnd.github+json",
				"User-Agent": "breakpoint-action",
			},
			body: JSON.stringify({ body }),
		});
		if (!res.ok) {
			const text = await res.text();
			core.warning(`Failed to post PR comment (${res.status}): ${text.slice(0, 200)}`);
			return null;
		}
		const json = (await res.json()) as { id: number };
		core.info(`Posted PR comment ${json.id}`);
		return json.id;
	} catch (err) {
		core.warning(`Error posting PR comment: ${err}`);
		return null;
	}
}

// EndpointDetector centralises the "watch breakpoint output, surface the SSH
// endpoint" logic. The same detector is fed both by stdout listeners of
// long-running `breakpoint wait`/`breakpoint start` calls and by the output
// of periodic `breakpoint status` polls during `pause-idle`.
interface EndpointDetector {
	feed: (text: string) => Promise<void>;
	execOpts: exec.ExecOptions;
}

function makeEndpointDetector(commentCtx: CommentContext | null): EndpointDetector {
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

		if (commentCtx) {
			const runId = process.env.GITHUB_RUN_ID || "unknown";
			const body = buildCommentBody(commentCtx, endpoint, runId);
			const id = await postPRComment(commentCtx, body);
			if (id !== null) {
				core.saveState(STATE_COMMENT_ID, String(id));
				core.saveState(STATE_COMMENT_REPO, `${commentCtx.owner}/${commentCtx.repo}`);
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
	fs.writeFileSync(configFile, JSON.stringify(config));

	const commentCtx = readCommentContext();
	const detector = makeEndpointDetector(commentCtx);

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
			stderr: () => {},
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

	const graceMs = parseDurationToMs(core.getInput("grace-period") || "5m", 5 * 60 * 1000);
	const idleMs = parseDurationToMs(core.getInput("idle-timeout") || "20m", 20 * 60 * 1000);
	const pollMs = 5000;

	core.info(`pause-idle: grace=${graceMs}ms, idle-timeout=${idleMs}ms (waiting for first SSH connection)`);

	// Phase 1: wait for the first connection, up to grace-period.
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

	// Phase 2: keep going while connected; exit after idle-timeout of zero connections.
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

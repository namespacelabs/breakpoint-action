import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModeFromInput } from "./lib";

const defaultBreakpointVersion = "0.0.23";

function getBreakpointVersion(): string {
	const override = process.env.BREAKPOINT_VERSION;
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
	// Download the specific version of the tool, e.g. as a tarball.
	const toolURL = await getDownloadURL();
	core.info(`Downloading: ${toolURL}`);

	const pathToTarball = await tc.downloadTool(toolURL, null, null, {
		CI: process.env.CI,
		"User-Agent": "breakpoint-action",
		accept: "application/octet-stream",
	});

	// Extract the tarball onto the runner.
	const pathToCLI = await tc.extractTar(pathToTarball);

	// Expose the tool by adding it to the $PATH.
	core.addPath(pathToCLI);
}

async function runBreakpoint(): Promise<void> {
	const configFile = tmpFile("config.json");
	const config = createConfiguration();

	const mode = getModeFromInput();

	core.debug(`Mode: ${mode}`);

	if (mode === "background") {
		core.info("Duration input is ignored when running in background mode");
		config.duration = "10h";
	}

	core.debug(`Configuration: ${config}`);

	fs.writeFile(configFile, JSON.stringify(config), (err) => {
		if (err) {
			core.setFailed(`Failed to write config file: ${err.message}`);
			return;
		}
	});

	core.debug(new Date().toTimeString());
	if (mode === "pause") {
		await exec.exec(`breakpoint wait --config=${configFile}`);
	} else {
		await exec.exec(`breakpoint start --config=${configFile}`);
	}
	core.debug(new Date().toTimeString());
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

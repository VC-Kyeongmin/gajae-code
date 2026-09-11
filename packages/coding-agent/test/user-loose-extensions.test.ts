import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverUserLooseExtensionFactories,
	ExtensionRuntime,
	loadExtensionFromFactory,
} from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

const PROBE_MODULE = `export default function register(api) {
	api.on("before_agent_start", async (event) => {
		return { systemPrompt: [...(event.systemPrompt ?? []), "INJECTED-BY-PROBE"] };
	});
};
`;

async function makeTempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeExtension(root: string, name: string, content: string): Promise<void> {
	const dir = path.join(root, "extensions", name);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "index.ts"), content);
}

describe("discoverUserLooseExtensionFactories", () => {
	test("loads a user-level module and lets it append to the turn system prompt", async () => {
		const agentDir = await makeTempDir("gjc-loose-agent-");
		const cwd = await makeTempDir("gjc-loose-cwd-");
		await writeExtension(agentDir, "probe", PROBE_MODULE);

		const discovered = await discoverUserLooseExtensionFactories(cwd, [], agentDir);
		expect(discovered.length).toBe(1);
		expect(discovered[0]?.name).toBe("probe");

		const runtime = new ExtensionRuntime();
		const loaded = await loadExtensionFromFactory(
			discovered[0]!.factory,
			cwd,
			new EventBus(),
			runtime,
			discovered[0]!.name,
		);
		const runner = new ExtensionRunner([loaded], runtime, cwd, SessionManager.inMemory(), {} as never);

		const result = await runner.emitBeforeAgentStart("hello", undefined, ["BASE"]);
		expect(result?.systemPrompt).toEqual(["BASE", "INJECTED-BY-PROBE"]);
	});

	test("never returns project-level loose extensions", async () => {
		const agentDir = await makeTempDir("gjc-loose-agent-");
		const cwd = await makeTempDir("gjc-loose-cwd-");
		// Project-level extension present under <cwd>/.gjc/extensions — must be
		// ignored: a repository walked into must not contribute executable code.
		await writeExtension(path.join(cwd, ".gjc"), "proj", PROBE_MODULE);

		const discovered = await discoverUserLooseExtensionFactories(cwd, [], agentDir);
		expect(discovered.map(entry => entry.name)).toEqual([]);
	});

	test("respects disabled extension ids", async () => {
		const agentDir = await makeTempDir("gjc-loose-agent-");
		const cwd = await makeTempDir("gjc-loose-cwd-");
		await writeExtension(agentDir, "probe", PROBE_MODULE);

		const discovered = await discoverUserLooseExtensionFactories(cwd, ["extension-module:probe"], agentDir);
		expect(discovered).toEqual([]);
	});

	test("surfaces a module without a factory export at load time, not discovery", async () => {
		const agentDir = await makeTempDir("gjc-loose-agent-");
		const cwd = await makeTempDir("gjc-loose-cwd-");
		await writeExtension(agentDir, "broken", "export const notAFactory = 1;\n");

		const discovered = await discoverUserLooseExtensionFactories(cwd, [], agentDir);
		expect(discovered.length).toBe(1);

		await expect(
			loadExtensionFromFactory(discovered[0]!.factory, cwd, new EventBus(), new ExtensionRuntime(), "broken"),
		).rejects.toThrow(/does not export a valid factory function/);
	});
});

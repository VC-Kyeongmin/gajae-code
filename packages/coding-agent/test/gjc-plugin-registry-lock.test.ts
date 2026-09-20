import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRegistry, registryRootForScope, withRegistryLock } from "../src/extensibility/gjc-plugins/registry";
import type { GjcPluginLoadError, GjcPluginRegistry, GjcPluginScope } from "../src/extensibility/gjc-plugins/types";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

const NONCE = "0123456789abcdef";

async function projectScope(): Promise<{ cwd: string; lock: string; registryPath: string }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-lock-"));
	tempDirs.push(cwd);
	const root = registryRootForScope("project", cwd);
	await fs.mkdir(root, { recursive: true });
	return { cwd, lock: path.join(root, "registry.lock"), registryPath: path.join(root, "registry.json") };
}

/** A pid that exited and was reaped, so a liveness probe reports it dead. */
async function deadPid(): Promise<number> {
	const proc = Bun.spawn(["/usr/bin/true"]);
	await proc.exited;
	return proc.pid;
}

/** Registry whose single hook entry lacks v2 metadata, so a migrating read must persist. */
function registryNeedingMigration(cwd: string): GjcPluginRegistry {
	const pluginRoot = path.join(cwd, "stale-plugin");
	const now = new Date().toISOString();
	return {
		version: 1,
		scope: "project" satisfies GjcPluginScope,
		plugins: [
			{
				name: "stale",
				version: "1.0.0",
				scope: "project",
				enabled: true,
				// Root does not exist on purpose: migration fails, but still
				// reports changed, which is what drives the locked persist step.
				pluginRoot,
				manifestPath: path.join(pluginRoot, "gajae-plugin.json"),
				manifestHash: "a".repeat(64),
				source: { kind: "path", uri: pluginRoot, resolvedAt: now },
				installedAt: now,
				updatedAt: now,
				copiedFiles: [{ relativePath: "gajae-plugin.json", sha256: "a".repeat(64), bytes: 10 }],
				surfaces: {
					subskills: [],
					tools: [],
					hooks: [
						{
							extensionId: "hook:session_start:::stale",
							name: "stale",
							event: "session_start",
							relativePath: "hooks/stale.js",
							sha256: "a".repeat(64),
						},
					],
					mcps: [],
					systemAppendices: [],
					agentAppendices: [],
				},
				disabledSurfaceIds: [],
			},
		],
	};
}

describe("GJC plugin registry lock recovery", () => {
	test("withRegistryLock evicts a host-tagged lock whose holder process is dead", async () => {
		const { cwd, lock } = await projectScope();
		const pid = await deadPid();
		await fs.writeFile(lock, `${pid}-${os.hostname()}-${NONCE}`, "utf8");

		let ran = false;
		await withRegistryLock("project", cwd, async () => {
			ran = true;
		});

		expect(ran).toBe(true);
		// Acquisition evicted the stale lock and release cleaned up after us.
		await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("withRegistryLock evicts an aged legacy lock whose holder pid is dead", async () => {
		const { cwd, lock } = await projectScope();
		const pid = await deadPid();
		await fs.writeFile(lock, `${pid}-${NONCE}`, "utf8");
		const aged = new Date(Date.now() - 60_000);
		await fs.utimes(lock, aged, aged);

		await withRegistryLock("project", cwd, async () => {});

		await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("withRegistryLock still fails closed on a fresh legacy lock with a dead pid", async () => {
		const { cwd, lock } = await projectScope();
		const pid = await deadPid();
		await fs.writeFile(lock, `${pid}-${NONCE}`, "utf8");

		let code: string | undefined;
		try {
			await withRegistryLock("project", cwd, async () => {});
		} catch (error) {
			code = (error as GjcPluginLoadError).code;
		}

		expect(code).toBe("install_conflict");
		// Fail-closed means the lock is left in place for diagnostics.
		await expect(fs.readFile(lock, "utf8")).resolves.toBe(`${pid}-${NONCE}`);
	}, 10_000);

	test("readRegistry degrades to its in-memory migration while a live holder holds the lock", async () => {
		const { cwd, lock, registryPath } = await projectScope();
		await fs.writeFile(registryPath, `${JSON.stringify(registryNeedingMigration(cwd), null, 2)}\n`);
		const holderToken = `${process.pid}-${os.hostname()}-${NONCE}`;
		await fs.writeFile(lock, holderToken, "utf8");
		const before = await fs.readFile(registryPath, "utf8");

		const registry = await readRegistry("project", cwd);

		expect(registry.plugins.map(plugin => plugin.name)).toEqual(["stale"]);
		expect(registry.plugins[0].migration?.status).toBe("failed");
		// The degraded read must not steal the live holder's lock or persist anything.
		await expect(fs.readFile(lock, "utf8")).resolves.toBe(holderToken);
		await expect(fs.readFile(registryPath, "utf8")).resolves.toBe(before);
	}, 10_000);
});

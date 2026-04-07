import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function writeAuthStore(agentDir: string, overrides?: Record<string, unknown>) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
    ...overrides,
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openrouter",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      await expect(fs.access(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("new session with auto override picks first available instead of round-robin", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:default": { type: "api_key", provider: "zai", key: "sk-default" },
          "zai:backup1": { type: "api_key", provider: "zai", key: "sk-backup1" },
          "zai:backup2": { type: "api_key", provider: "zai", key: "sk-backup2" },
        },
        order: { zai: ["zai:default", "zai:backup1", "zai:backup2"] },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:backup1",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      // Should pick first available (zai:default), not round-robin from backup1
      expect(resolved).toBe("zai:default");
    });
  });

  it("new session with user override round-robins from current position", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:default": { type: "api_key", provider: "zai", key: "sk-default" },
          "zai:backup1": { type: "api_key", provider: "zai", key: "sk-backup1" },
          "zai:backup2": { type: "api_key", provider: "zai", key: "sk-backup2" },
        },
        order: { zai: ["zai:default", "zai:backup1", "zai:backup2"] },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:backup1",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      // User-set overrides should round-robin: backup1 → backup2
      expect(resolved).toBe("zai:backup2");
    });
  });

  it("new session skips cooldown profiles when picking first available", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:default": { type: "api_key", provider: "zai", key: "sk-default" },
          "zai:backup1": { type: "api_key", provider: "zai", key: "sk-backup1" },
        },
        order: { zai: ["zai:default", "zai:backup1"] },
        usageStats: {
          "zai:default": {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
          },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      // Should skip zai:default (in cooldown) and pick zai:backup1
      expect(resolved).toBe("zai:backup1");
    });
  });

  it("legacy entry without authProfileOverrideSource infers auto from compactionCount", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:default": { type: "api_key", provider: "zai", key: "sk-default" },
          "zai:backup1": { type: "api_key", provider: "zai", key: "sk-backup1" },
        },
        order: { zai: ["zai:default", "zai:backup1"] },
      });

      // Legacy session entry: has compactionCount but no explicit source field.
      // The fallback inference should treat this as "auto" and pick fresh.
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:backup1",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      // Inferred as "auto" → picks first available, not round-robin
      expect(resolved).toBe("zai:default");
    });
  });

  it("falls back to first profile when all profiles are in cooldown", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:default": { type: "api_key", provider: "zai", key: "sk-default" },
          "zai:backup1": { type: "api_key", provider: "zai", key: "sk-backup1" },
        },
        order: { zai: ["zai:default", "zai:backup1"] },
        usageStats: {
          "zai:default": {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
          },
          "zai:backup1": {
            cooldownUntil: Date.now() + 120_000,
            cooldownReason: "rate_limit",
          },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:backup1",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      // All in cooldown → pickFirstAvailable falls back to order[0]
      expect(resolved).toBe("zai:default");
    });
  });

  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface E2eConfig {
  vm: {
    memoryMb: number;
    smp: number;
  };
  test: {
    sshUser: string;
    outputMethod: string;
  };
}

const DEFAULTS: E2eConfig = {
  vm: { memoryMb: 4096, smp: 1 },
  test: { sshUser: "testuser", outputMethod: "type" },
};

export function loadConfig(projectRoot: string): E2eConfig {
  const configPath = join(projectRoot, "e2e", "config.yaml");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, any>;
    return {
      vm: {
        memoryMb: parsed?.vm?.memory_mb ?? DEFAULTS.vm.memoryMb,
        smp: parsed?.vm?.smp ?? DEFAULTS.vm.smp,
      },
      test: {
        sshUser: parsed?.ssh?.user ?? DEFAULTS.test.sshUser,
        outputMethod: parsed?.test?.output_method ?? DEFAULTS.test.outputMethod,
      },
    };
  } catch {
    return DEFAULTS;
  }
}

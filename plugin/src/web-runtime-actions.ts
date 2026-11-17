// The Runtime page's action half: probe / download / restart / repair /
// prepare / release, wired behind `RuntimeApi` (web/api.ts).
//
// Extracted from `index.ts` where these six closures sat inline inside the
// `startWebServer` call (2026-11-17 structure pass). The bodies are moved
// verbatim; the only rewrites are the two binding renames the extraction
// forces -- `runtimeTagAtLoad` and `runEmbedderRepair` arrive as constructor
// params `activeTag` / `repair`, and the `vectorsUsable && localService`
// gate becomes the early return below.
//
// Why one file: all six actions share the same four things -- the service
// object, the service config, the `runningVariant()` truth and one
// `preparingVariants` set that keeps two windows from double-spawning a
// download. Splitting them would restate that shared state; keeping them
// together is the concern, not the line count.
//
// The gate lives here too: no usable vectors or no service client means no
// action half at all (the status route still answers; action routes 503).

import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { isBatteryPaused } from "./model/power.js";
import {
  effectiveRuntimeDirPath,
  resolveRuntimeFile,
  runtimeCudartZipPath,
  runtimeDirPath,
  runtimeZipPath,
  serverEntryPath,
  type RuntimeVariant,
  type ServiceConfig,
} from "./model/config.js";
import { nodeSystemCaArgs, probeService, type MemPlusService } from "./model/client.js";
import type { RepairOutcome, RuntimeAction, RuntimeApi } from "./web/api.js";

export type RuntimeActionsParams = {
  /** Gate: with no usable vectors there is nothing to run actions against. */
  readonly vectorsUsable: boolean;
  readonly localService: MemPlusService | null;
  readonly serviceConfig: ServiceConfig;
  /**
   * 正在跑的引擎变体（原 index.ts 注释：本插件 spawn 的真身，服务没在跑时
   * 回落到活读配置 = 下次 spawn 会用的值）。生效判定与文件占用守卫都按它算。
   */
  readonly runningVariant: () => RuntimeVariant;
  /** 装载期的运行时 tag（runtimeTag() 的装载值）；页面拿它算 tagPending。 */
  readonly activeTag: string;
  /** One manual embedder-repair pass; coalesces with an in-flight run. */
  readonly repair: () => Promise<RepairOutcome>;
  readonly log: (message: string, detail?: unknown) => void;
};

export function createRuntimeActions(params: RuntimeActionsParams): RuntimeApi | undefined {
  const { vectorsUsable, localService, serviceConfig, runningVariant, activeTag, repair, log } = params;
  if (!vectorsUsable || !localService) return undefined;
  // Runtime 页「准备中」灯：prepare 是火速返回（592 MB 超页面超时），
  // 靠这组集合让引擎行显示进度、并防同一变体双开下载。
  const preparingVariants = new Set<RuntimeVariant>();
  return {
    // 生效引擎 = spawn 真身（活读），不是装载期捕获值——见
    // runningVariant 的注释。
    get activeVariant(): RuntimeVariant {
      return runningVariant();
    },
    activeTag,
    probe: () => probeService(serviceConfig),
    download: async (force: boolean): Promise<RuntimeAction> => {
      // 电池暂停预检放在最前：不能先拆了运行时再拒绝启动
      // （force 分支第一步就是 dispose + 删 zip）。文案必须
      // 明说原因——落到下面 ready() 的通用超时话术就是假话。
      if (await isBatteryPaused(serviceConfig)) {
        return {
          ok: false,
          detail: "电池暂停中（service.pauseOnBattery）：插电或关闭该设置后再启动服务",
        };
      }
      // 擦的对象 = 会用到它的那一个变体；在 dispose 之前取值
      // （dispose 后 spawn 真身消失，只剩活读配置）。
      const variant = runningVariant();
      if (force) {
        // 先停再删：llama-server.exe 正在跑时 Windows 锁着文件，删不掉。
        await localService.dispose();
        try {
          rmSync(runtimeDirPath(variant), { recursive: true, force: true });
          rmSync(runtimeZipPath(variant), { force: true });
          if (variant === "cuda") {
            rmSync(runtimeCudartZipPath(), { force: true });
          }
        } catch (error) {
          return {
            ok: false,
            detail: `删除旧运行时失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const started = await localService.ready({ forcePrepare: true });
      if (started) return { ok: true, detail: `运行时就绪，服务已启动：${localService.url ?? ""}` };
      return {
        ok: false,
        detail: force
          ? "重新下载已触发，但服务 30 秒内未就绪——下载在后台继续，完成后自动恢复，稍后刷新本页"
          : "启动已触发（首次包含运行时下载），但服务 30 秒内未就绪——下载在后台继续，完成后自动恢复，稍后刷新本页",
      };
    },
    restart: async (): Promise<RuntimeAction> => {
      // 电池暂停预检：同 download，先于 dispose，且给明确文案。
      if (await isBatteryPaused(serviceConfig)) {
        return {
          ok: false,
          detail: "电池暂停中（service.pauseOnBattery）：插电或关闭该设置后再重启服务",
        };
      }
      const before = await probeService(serviceConfig);
      await localService.dispose();
      const started = await localService.ready();
      if (!started) return { ok: false, detail: "服务未能就绪：30 秒内没有响应，稍后重试或查看日志" };
      const after = await probeService(serviceConfig);
      const url = after?.url ?? localService.url ?? "";
      if (!before) return { ok: true, detail: `服务未在运行，已启动：${url}` };
      const prev = before.health.uptimeSeconds;
      const now = after?.health.uptimeSeconds;
      // uptime 变小 = 换了进程 = 真重启了。没变说明服务是别的
      // 实例启动的（dispose 只回收本插件拉起的子进程），如实说没重启。
      return prev === undefined || now === undefined || now < prev
        ? { ok: true, detail: `服务已重启：${url}` }
        : { ok: true, detail: `服务由其他实例持有（本窗口没有启动它），未重启、已重新连接：${url}` };
    },
    repair,
    preparing: () => [...preparingVariants],
    prepare: async (variant: RuntimeVariant, force: boolean): Promise<RuntimeAction> => {
      if (preparingVariants.has(variant)) {
        return { ok: true, detail: `${variant} 引擎已在后台准备中，完成后引擎列表会显示已安装` };
      }
      // 生效变体的 exe 被子进程握着：先停再删（与 download force
      // 同一条规矩）；非生效变体没人占，直接删。生效 = spawn 真身。
      if (variant === runningVariant()) await localService.dispose();
      if (force) {
        try {
          rmSync(runtimeDirPath(variant), { recursive: true, force: true });
          rmSync(runtimeZipPath(variant), { force: true });
          if (variant === "cuda") rmSync(runtimeCudartZipPath(), { force: true });
        } catch (error) {
          return {
            ok: false,
            detail: `删除旧运行时失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const entry = serverEntryPath();
      if (!existsSync(entry)) return { ok: false, detail: `找不到 ${entry}` };
      // 火速后台模式：--ensure 准备完即退，不起服务、不校验 GPU；
      // 日志转进 mem-plus.log，进度由 preparing 集合驱动页面灯。
      const child = spawn(
        process.execPath.startsWith("node") ? process.execPath : "node",
        [...nodeSystemCaArgs(), entry, "--variant", variant, "--ensure"],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      preparingVariants.add(variant);
      const relay = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim().length > 0) log(`[prepare:${variant}] ${line}`);
        }
      };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      child.on("error", (error) => {
        preparingVariants.delete(variant);
        log(`prepare ${variant} spawn failed`, error);
      });
      child.on("exit", (code) => {
        preparingVariants.delete(variant);
        log(`prepare ${variant} ${code === 0 ? "finished" : `failed (exit ${code})`}`);
      });
      return {
        ok: true,
        detail: `${force ? "重新" : ""}准备 ${variant} 引擎已在后台开始（下载→sha 校验→解压），完成后引擎列表自动显示已安装；体积大时可能要几分钟`,
      };
    },
    /**
     * 删除**一个**已下载文件（列表式：点开列表选具体文件删，
     * 机主 2026-11-05 拍板，不一键清空整个变体）。三道守卫：
     * 准备中不删；名字必须属于该变体的模式（resolveRuntimeFile
     * 不猜路径，删不掉列表外的东西）；生效引擎正在用的当前
     * tag 目录不删（API 层另有一道同语义兜底）。旧 tag 孤儿与
     * zip 可以删——那正是这功能要清理的东西。
     */
    release: async (variant: RuntimeVariant, name: string): Promise<RuntimeAction> => {
      if (preparingVariants.has(variant)) {
        return { ok: false, detail: `${variant} 正在后台准备中，等它结束再删` };
      }
      const target = resolveRuntimeFile(variant, name);
      if (!target) {
        return { ok: false, detail: `不认识的文件：${name}` };
      }
      if (variant === runningVariant() && name === path.basename(effectiveRuntimeDirPath(variant))) {
        return {
          ok: false,
          detail: "这是当前生效引擎正在使用的文件：先在下拉里切走，再删除它",
        };
      }
      try {
        rmSync(target.path, { recursive: target.kind === "directory", force: true });
        return { ok: true, detail: `已删除 ${name}` };
      } catch (error) {
        return {
          ok: false,
          detail: `删除失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

// 电池/市电检测，`service.pauseOnBattery` 的判据（2026-11-08 机主拍板）。
//
// WHY THIS EXISTS (no upstream counterpart)
//   openclaw 的记忆子系统没有电源概念——它跑在常电的服务器/桌面假设上，
//   `docs/memory-chain.md` 全链无一处电源门。这是 OpenCode 插件场景独有的
//   需求：笔记本上 4 GB 的 bge-m3 不该在电池上被自动拉起、后台批量嵌入
//   不该在电池上烧 GPU。先例（2026-11-08 检索）：claude-history 的
//   `pause_on_battery`（默认停、插电续）、Akin（电池暂停索引）、ivygrep
//   （暂停增强，`IVYGREP_ENHANCE_ON_BATTERY=1` 覆盖）——全是「停后台批量、
//   保交互」，本模块同构，另加一道「不冷启动」。
//
// HOW IT IS MEASURED
//   Windows 上查 `root\wmi\BatteryStatus.PowerOnline`（等价 GetSystemPowerStatus
//   的 ACLineStatus）。实测（2026-11-08，本机 5 发）：437/287/272/273/306 ms，
//   均值 315 ms——大头是 powershell.exe 启动。所以：**20 s TTL 缓存 + 单飞**，
//   只在后台门与冷启动门上调用；检索的查询嵌入路径不查它（热服务 70 ms 微
//   嵌入照放行，冷启动门在 autostart 分支，本来就不在热路径上）。
//
// FAIL-OPEN (deliberate, 对着「宁可漏拦不可误杀」)
//   只有**明确** `PowerOnline=False` 才算电池。探测超时（5 s）、powershell
//   报错、WMI 命名空间缺失（`-ErrorAction SilentlyContinue` 吞掉后空输出）、
//   无电池（台式机，空输出）一律放行：WMI 抽风不能把全站向量检索闷死。
//   非 Windows 平台直接 unknown，功能静默失效（本机只实测了 Windows）。
//
// ENV OVERRIDE (ivygrep 的 `IVYGREP_ENHANCE_ON_BATTERY` 同款先例)
//   `MEM_PLUS_FORCE_POWER=battery|ac` 覆盖探测——测试用（交流电上验电池门），
//   也是用户的紧急旁路。读值在每次 `powerSource()` 调用时，不缓存覆盖值。
import { spawn } from "node:child_process";

export type PowerSource = "ac" | "battery" | "unknown";

/** 缓存时长。必须小于 auto-embed 的 30 s 暂停重臂，插电后第一臂即见新状态。 */
const TTL_MS = 20_000;
/** 单次探测上限：正常 315 ms，超时视为 unknown（fail-open）。 */
const PROBE_TIMEOUT_MS = 5_000;
/** 一次只许一个探测在飞：并发的门检查共用同一次 spawn。 */
let inFlight: Promise<PowerSource> | null = null;
let cached: { at: number; source: PowerSource } | null = null;

function probe(): Promise<PowerSource> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve("unknown");
      return;
    }
    let settled = false;
    const finish = (source: PowerSource): void => {
      if (settled) return;
      settled = true;
      resolve(source);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // PowerOnline = True 在市电上，False 在电池上。多电池取第一条：
          // AC 状态是系统级的，与取哪块无关。空输出 = 没有电池（台式机）。
          "Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus " +
            "-ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty PowerOnline",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      finish("unknown");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish("unknown");
    }, PROBE_TIMEOUT_MS);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("unknown");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish("unknown");
        return;
      }
      const value = out.trim();
      if (value === "True") finish("ac");
      else if (value === "False") finish("battery");
      else finish(value === "" ? "ac" : "unknown");
    });
  });
}

/** 当前电源。20 s 内的重复调用走缓存；覆盖环境变量不走缓存。 */
export function powerSource(): Promise<PowerSource> {
  const forced = process.env["MEM_PLUS_FORCE_POWER"];
  if (forced === "battery" || forced === "ac") return Promise.resolve(forced);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.source);
  inFlight ??= probe().then((source) => {
    cached = { at: Date.now(), source };
    return source;
  });
  // `.finally` 之后返回的仍是 probe 的值；清 inFlight 让下一次缓存过期后重探。
  return inFlight.then(
    (source) => {
      inFlight = null;
      return source;
    },
    (error) => {
      inFlight = null;
      throw error;
    },
  );
}

/**
 * 电池暂停判定：设置开着 **且** 明确在电池上才 true。
 *
 * `config` 只要求 `pauseOnBattery` 字段，调用方直接传 ServiceConfig。
 * 每次调用最多花一次缓存命中的 0 ms；冷缓存时 315 ms，所以只许放在
 * 后台门（批量开跑前）与冷启动门（spawn 前）——不许放进查询嵌入路径。
 */
export async function isBatteryPaused(config: {
  readonly pauseOnBattery: boolean;
}): Promise<boolean> {
  if (!config.pauseOnBattery) return false;
  return (await powerSource()) === "battery";
}

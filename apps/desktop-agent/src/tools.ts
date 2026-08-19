import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { access, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { loadConfig } from '@personal-ai/config';
import type { DesktopToolDeclaration, PermissionLevel, ToolResult } from '@personal-ai/tools';

const execFileAsync = promisify(execFile);
const agentConfig = loadConfig();
const DASHSCOPE_KEY = agentConfig.qwenRealtime.apiKey;
// 快速档：日常看屏幕（低延迟）；深度档：需要仔细理解屏幕内容时用。
const VISION_MODEL = process.env.QWEN_VISION_MODEL ?? 'qwen-vl-max';
const VISION_MODEL_DEEP = process.env.QWEN_VISION_MODEL_DEEP ?? 'qwen3.8-max';

/** 删除保护：磁盘根目录与系统关键目录一律拒绝（可进回收站≠可删系统）。 */
const PROTECTED_PATH_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
];

function isProtectedPath(resolved: string): boolean {
  const lower = resolved.toLowerCase();
  if (/^[a-z]:[\\/]?$/.test(lower)) return true;
  return PROTECTED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export interface LocalTool {
  declaration: DesktopToolDeclaration;
  execute(input: unknown): Promise<ToolResult>;
}

interface TerminalInput {
  command: string;
}

interface PathsInput {
  source: string;
  destination: string;
}

interface CaptureInput {
  path?: string;
}

function powershellArgs(command: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
  ];
}

async function runPowershell(command: string, timeoutMs: number): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('powershell.exe', powershellArgs(command), {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { ok: true, data: { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() } };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    // The command ran but exited non-zero; still report it so the agent can react.
    if (typeof err.code === 'number') {
      return {
        ok: true,
        data: {
          exitCode: err.code,
          stdout: (err.stdout ?? '').trim(),
          stderr: (err.stderr ?? '').trim(),
        },
      };
    }
    return { ok: false, error: `命令执行失败：${err.message ?? String(error)}` };
  }
}

/**
 * Ensure the parent directory of a file exists. Unlike a bare
 * mkdir(dirname, { recursive: true }), this skips the call entirely when the
 * directory already exists — Windows throws EPERM when asked to mkdir a drive
 * root like E:\ (which is the dirname of E:\file.txt).
 */
async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

interface ScreenCaptureResult {
  path: string;
  width: number;
  height: number;
  /** 8x8 网格 + 3x3 采样平均色的轻量签名，用于"画面是否变化"判定。 */
  signature: string;
}

/** 最近一次截图（或裁剪区域）的签名；screen.click 用它校验坐标帧是否过期。 */
let lastScreenSignature: string | null = null;

/**
 * 截屏（可裁剪区域）并返回 PNG 路径与轻量签名。
 * 签名在 PowerShell 侧计算（8x8 单元格均值色，量化后拼接），
 * 相比直接比较 PNG 字节更稳定，用于 OpenClaw 风格的"帧过期/无变化"检测。
 */
async function captureScreenWithSignature(region?: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<ScreenCaptureResult> {
  const outPath = path.join(tmpdir(), `assistant-screen-${randomUUID()}.png`);
  const regionScript =
    typeof region?.x === 'number' &&
    typeof region?.y === 'number' &&
    typeof region?.w === 'number' &&
    typeof region?.h === 'number'
      ? [
          `$r=New-Object System.Drawing.Rectangle ${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.w)},${Math.round(region.h)}`,
          '$crop=New-Object System.Drawing.Bitmap $r.Width,$r.Height',
          '$cg=[System.Drawing.Graphics]::FromImage($crop)',
          '$cg.DrawImage($bmp,(New-Object System.Drawing.Rectangle 0,0,$r.Width,$r.Height),$r,[System.Drawing.GraphicsUnit]::Pixel)',
          '$final=$crop',
        ]
      : ['$final=$bmp'];
  const script = [
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}\'',
    '[D]::SetProcessDPIAware() | Out-Null',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)',
    ...regionScript,
    `$final.Save('${outPath.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$cells=8;$samples=3;$parts=@()',
    'for($ci=0;$ci -lt $cells;$ci++){for($cj=0;$cj -lt $cells;$cj++){',
    '$sr=0;$sg=0;$sb=0',
    'for($si=0;$si -lt $samples;$si++){for($sj=0;$sj -lt $samples;$sj++){',
    '$px=[math]::Floor((($cj*$samples+$sj+0.5)/($cells*$samples))*$final.Width)',
    '$py=[math]::Floor((($ci*$samples+$si+0.5)/($cells*$samples))*$final.Height)',
    'if($px -ge $final.Width){$px=$final.Width-1};if($py -ge $final.Height){$py=$final.Height-1}',
    '$c=$final.GetPixel($px,$py);$sr+=$c.R;$sg+=$c.G;$sb+=$c.B',
    '}}',
    '$n=$samples*$samples',
    "$parts+=('{0:x}{1:x}{2:x}' -f [int]($sr/$n/32),[int]($sg/$n/32),[int]($sb/$n/32))",
    '}}',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`,
    `Write-Output (ConvertTo-Json @{path='${outPath.replace(/'/g, "''")}';width=$final.Width;height=$final.Height;signature=($parts -join '')} -Compress)`,
  ].join('; ');
  const result = await runPowershell(script, 20_000);
  if (!result.ok) throw new Error('截屏命令执行失败');
  const stdout = (result.data as { stdout?: string }).stdout ?? '';
  try {
    const parsed = JSON.parse(stdout) as ScreenCaptureResult;
    await access(parsed.path);
    return parsed;
  } catch {
    throw new Error('截屏失败：未生成图片文件');
  }
}

async function callQwenVision(
  base64: string,
  prompt: string,
  model = VISION_MODEL,
): Promise<string> {
  if (!DASHSCOPE_KEY) {
    throw new Error('DASHSCOPE_API_KEY 未配置，无法分析屏幕');
  }
  const response = await fetch(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${DASHSCOPE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    },
  );
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!response.ok) {
    throw new Error(`视觉模型调用失败（HTTP ${response.status}）`);
  }
  return data.choices?.[0]?.message?.content ?? '';
}

export function createLocalTools(): LocalTool[] {
  return [
    {
      declaration: {
        name: 'terminal.run',
        description:
          '在 Windows 上执行一条 PowerShell 命令并返回输出（L3：需要用户二次确认）。可用于查看系统状态、管理文件等。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 PowerShell 命令' },
          },
          required: ['command'],
        },
        permissionLevel: 3 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { command } = (input ?? {}) as TerminalInput;
        if (!command?.trim()) {
          return { ok: false, error: '缺少 command 参数' };
        }
        return runPowershell(command.trim(), 30_000);
      },
    },
    {
      declaration: {
        name: 'filesystem.move',
        description: '移动或重命名本地文件/目录（L1）。',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源路径' },
            destination: { type: 'string', description: '目标路径' },
          },
          required: ['source', 'destination'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { source, destination } = (input ?? {}) as PathsInput;
        if (!source?.trim() || !destination?.trim()) {
          return { ok: false, error: '缺少 source 或 destination 参数' };
        }
        try {
          await rename(path.resolve(source), path.resolve(destination));
          return { ok: true, data: { moved: `${source} -> ${destination}` } };
        } catch (error) {
          return {
            ok: false,
            error: `移动失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'filesystem.copy',
        description: '复制本地文件/目录（L1）。',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源路径' },
            destination: { type: 'string', description: '目标路径' },
          },
          required: ['source', 'destination'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { source, destination } = (input ?? {}) as PathsInput;
        if (!source?.trim() || !destination?.trim()) {
          return { ok: false, error: '缺少 source 或 destination 参数' };
        }
        try {
          await copyFile(path.resolve(source), path.resolve(destination));
          return { ok: true, data: { copied: `${source} -> ${destination}` } };
        } catch (error) {
          return {
            ok: false,
            error: `复制失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'app.launch',
        description:
          '启动一个应用程序，或打开文件/文件夹/磁盘路径/URL（用默认程序或资源管理器打开，L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: '程序名、路径或 URL，如 notepad、C:\\path\\app.exe',
            },
          },
          required: ['target'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { target } = (input ?? {}) as { target?: string };
        if (!target?.trim()) {
          return { ok: false, error: '缺少 target 参数' };
        }
        return runPowershell(`Start-Process '${target.replace(/'/g, "''")}'`, 15_000);
      },
    },
    {
      declaration: {
        name: 'filesystem.delete',
        description:
          '删除本地文件或目录到回收站（L1：自动执行，可恢复）。拒绝删除磁盘根目录与系统关键目录。',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '要删除的文件或目录路径' },
          },
          required: ['target'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { target } = (input ?? {}) as { target?: string };
        if (!target?.trim()) {
          return { ok: false, error: '缺少 target 参数' };
        }
        const resolved = path.resolve(target.trim());
        if (isProtectedPath(resolved)) {
          return { ok: false, error: '拒绝删除磁盘根目录或系统关键目录' };
        }
        const safe = resolved.replace(/'/g, "''");
        const script = [
          'Add-Type -AssemblyName Microsoft.VisualBasic',
          `if (Test-Path -LiteralPath '${safe}' -PathType Container) {`,
          `  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${safe}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
          '} else {',
          `  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${safe}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
          '}',
        ].join(';');
        return runPowershell(script, 20_000);
      },
    },
    {
      declaration: {
        name: 'filesystem.write',
        description: '创建或覆写一个文本文件（L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            content: { type: 'string', description: '文件内容（文本）' },
          },
          required: ['path', 'content'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { path: filePath, content } = (input ?? {}) as {
          path?: string;
          content?: string;
        };
        if (!filePath?.trim()) {
          return { ok: false, error: '缺少 path 参数' };
        }
        const resolved = path.resolve(filePath.trim());
        try {
          await ensureParentDir(resolved);
          await writeFile(resolved, content ?? '', 'utf8');
          return { ok: true, data: { written: resolved } };
        } catch (error) {
          return {
            ok: false,
            error: `写入失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'filesystem.read',
        description:
          '读取一个文本文件的内容（L0：自动执行）。大文件只返回前 256KB，超限会标注 truncated。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
          },
          required: ['path'],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { path: filePath } = (input ?? {}) as { path?: string };
        if (!filePath?.trim()) {
          return { ok: false, error: '缺少 path 参数' };
        }
        const resolved = path.resolve(filePath.trim());
        try {
          const info = await stat(resolved);
          if (!info.isFile()) {
            return { ok: false, error: '目标不是文件（目录请用 filesystem.list）' };
          }
          const READ_CAP = 256 * 1024;
          const handle = await open(resolved, 'r');
          try {
            const size = Math.min(READ_CAP, info.size);
            const buffer = Buffer.alloc(size);
            await handle.read(buffer, 0, size, 0);
            const truncated = info.size > READ_CAP;
            return {
              ok: true,
              data: {
                path: resolved,
                size: info.size,
                truncated,
                content:
                  buffer.toString('utf8') + (truncated ? '\n…（文件过大，仅返回前 256KB）' : ''),
              },
            };
          } finally {
            await handle.close();
          }
        } catch (error) {
          return {
            ok: false,
            error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'filesystem.list',
        description:
          '列出目录内容（文件名与类型，L0：自动执行）。目录优先、按名称排序，最多返回 500 项。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录路径（默认当前用户主目录）' },
          },
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { path: dirPath } = (input ?? {}) as { path?: string };
        const resolved = path.resolve(dirPath?.trim() || process.env.USERPROFILE || process.cwd());
        try {
          const entries = await readdir(resolved, { withFileTypes: true });
          const items = entries
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .slice(0, 500);
          return {
            ok: true,
            data: { path: resolved, count: entries.length, truncated: entries.length > 500, items },
          };
        } catch (error) {
          return {
            ok: false,
            error: `列出目录失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'filesystem.create-folder',
        description: '创建目录（含父目录，L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要创建的目录路径' },
          },
          required: ['path'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { path: dirPath } = (input ?? {}) as { path?: string };
        if (!dirPath?.trim()) {
          return { ok: false, error: '缺少 path 参数' };
        }
        try {
          const resolved = path.resolve(dirPath.trim());
          await mkdir(resolved, { recursive: true });
          return { ok: true, data: { created: resolved } };
        } catch (error) {
          return {
            ok: false,
            error: `创建失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      declaration: {
        name: 'filesystem.compress',
        description: '把文件或目录压缩为 zip 压缩包（L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '要压缩的文件或目录路径' },
            destination: { type: 'string', description: 'zip 输出路径' },
          },
          required: ['source', 'destination'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { source, destination } = (input ?? {}) as PathsInput;
        if (!source?.trim() || !destination?.trim()) {
          return { ok: false, error: '缺少 source 或 destination 参数' };
        }
        const src = path.resolve(source.trim());
        const dst = path.resolve(destination.trim());
        return runPowershell(
          `Compress-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${dst.replace(/'/g, "''")}' -Force`,
          30_000,
        );
      },
    },
    {
      declaration: {
        name: 'filesystem.extract',
        description: '解压 zip 压缩包到指定目录（L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            archive: { type: 'string', description: 'zip 文件路径' },
            destination: { type: 'string', description: '解压目标目录' },
          },
          required: ['archive', 'destination'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { archive, destination } = (input ?? {}) as {
          archive?: string;
          destination?: string;
        };
        if (!archive?.trim() || !destination?.trim()) {
          return { ok: false, error: '缺少 archive 或 destination 参数' };
        }
        const src = path.resolve(archive.trim());
        const dst = path.resolve(destination.trim());
        return runPowershell(
          `Expand-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${dst.replace(/'/g, "''")}' -Force`,
          30_000,
        );
      },
    },
    {
      declaration: {
        name: 'system.power',
        description:
          '执行系统电源操作：shutdown（关机）、restart（重启）、sleep（睡眠）。（L3：需要用户二次确认）',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['shutdown', 'restart', 'sleep'],
              description: '要执行的操作',
            },
          },
          required: ['action'],
        },
        permissionLevel: 3 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { action } = (input ?? {}) as { action?: string };
        const command =
          action === 'shutdown'
            ? 'shutdown.exe /s /t 0'
            : action === 'restart'
              ? 'shutdown.exe /r /t 0'
              : action === 'sleep'
                ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
                : null;
        if (!command) {
          return { ok: false, error: 'action 必须是 shutdown / restart / sleep' };
        }
        return runPowershell(command, 15_000);
      },
    },
    {
      declaration: {
        name: 'clipboard.read',
        description: '读取剪贴板文本内容（L0）。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute() {
        const result = await runPowershell('Get-Clipboard -Raw', 10_000);
        if (!result.ok) return result;
        return {
          ok: true,
          data: { text: (result.data as { stdout?: string }).stdout ?? '' },
        };
      },
    },
    {
      declaration: {
        name: 'clipboard.write',
        description: '把文本写入剪贴板（L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要写入剪贴板的文本' },
          },
          required: ['text'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { text } = (input ?? {}) as { text?: string };
        if (text === undefined) {
          return { ok: false, error: '缺少 text 参数' };
        }
        return runPowershell(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`, 10_000);
      },
    },
    {
      declaration: {
        name: 'system.info',
        description: '查看系统信息：操作系统、CPU、内存、磁盘、电池（L0）。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute() {
        const script = [
          '$os = Get-CimInstance Win32_OperatingSystem',
          '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
          '$cs = Get-CimInstance Win32_ComputerSystem',
          '$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, @{n="SizeGB";e={[math]::Round($_.Size/1GB,1)}}, @{n="FreeGB";e={[math]::Round($_.FreeSpace/1GB,1)}}',
          '$battery = Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus',
          '[pscustomobject]@{ os=$os.Caption; version=$os.Version; cpu=$cpu.Name; cores=$cpu.NumberOfCores; ramTotalGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1); hostname=$cs.Name; disks=$disks; battery=$battery } | ConvertTo-Json -Depth 4 -Compress',
        ].join('; ');
        const result = await runPowershell(script, 20_000);
        if (!result.ok) return result;
        let info: unknown;
        try {
          info = JSON.parse((result.data as { stdout?: string }).stdout ?? '{}');
        } catch {
          info = (result.data as { stdout?: string }).stdout ?? '';
        }
        return { ok: true, data: { info } };
      },
    },
    {
      declaration: {
        name: 'system.volume',
        description:
          '调节系统音量：up（加大）、down（减小）、mute（静音/取消静音）（L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['up', 'down', 'mute'],
              description: '要执行的操作',
            },
          },
          required: ['action'],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { action } = (input ?? {}) as { action?: string };
        const key =
          action === 'up' ? 175 : action === 'down' ? 174 : action === 'mute' ? 173 : null;
        if (key === null) {
          return { ok: false, error: 'action 必须是 up / down / mute' };
        }
        return runPowershell(
          `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${key})`,
          10_000,
        );
      },
    },
    {
      declaration: {
        name: 'window.focus',
        description: '把指定窗口带到前台（按窗口标题或进程 PID，L1：自动执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '窗口标题关键词（与 pid 二选一）' },
            pid: { type: 'number', description: '进程 ID（与 title 二选一）' },
          },
          required: [],
        },
        permissionLevel: 1 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { title, pid } = (input ?? {}) as { title?: string; pid?: number };
        if (!title?.trim() && pid === undefined) {
          return { ok: false, error: '需要提供 title 或 pid' };
        }
        const target = pid !== undefined ? String(pid) : `'${(title ?? '').replace(/'/g, "''")}'`;
        const result = await runPowershell(
          `$w = New-Object -ComObject WScript.Shell; $ok = $w.AppActivate(${target}); if (-not $ok) { Write-Error 'window not found' }`,
          10_000,
        );
        if (!result.ok) return result;
        return { ok: true, data: { focused: title?.trim() || pid } };
      },
    },
    {
      declaration: {
        name: 'process.list',
        description: '列出当前运行的进程（名称、PID、CPU、内存、窗口标题）（L0）。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '按名称关键词过滤（可选）' },
            limit: { type: 'number', description: '最多返回条数，默认 50' },
          },
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { keyword, limit = 50 } = (input ?? {}) as { keyword?: string; limit?: number };
        const capped = Math.min(Math.max(1, Math.floor(limit)), 200);
        const filter = keyword?.trim()
          ? ` | Where-Object { $_.ProcessName -like '*${(keyword ?? '').replace(/'/g, "''")}*' }`
          : '';
        const script = [
          `$procs = Get-Process${filter} | Select-Object ProcessName, Id, CPU, @{n="MemMB";e={[math]::Round($_.WorkingSet64/1MB,1)}}, MainWindowTitle | Sort-Object MemMB -Descending | Select-Object -First ${capped}`,
          '$procs | ConvertTo-Json -Depth 3 -Compress',
        ].join('; ');
        const result = await runPowershell(script, 15_000);
        if (!result.ok) return result;
        let processes: unknown[] = [];
        try {
          const parsed = JSON.parse((result.data as { stdout?: string }).stdout ?? '[]') as unknown;
          processes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        } catch {
          // leave empty on parse failure
        }
        return { ok: true, data: { count: processes.length, processes } };
      },
    },
    {
      declaration: {
        name: 'process.kill',
        description: '结束一个进程（按 PID 或名称，L2：需要用户确认）。',
        inputSchema: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: '进程 ID（与 name 二选一）' },
            name: { type: 'string', description: '进程名称（与 pid 二选一，不含 .exe）' },
          },
          required: [],
        },
        permissionLevel: 2 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { pid, name } = (input ?? {}) as { pid?: number; name?: string };
        if (pid === undefined && !name?.trim()) {
          return { ok: false, error: '需要提供 pid 或 name' };
        }
        if (pid !== undefined && pid <= 4) {
          return { ok: false, error: '拒绝结束系统关键进程' };
        }
        const target =
          pid !== undefined ? `-Id ${pid}` : `-Name '${(name ?? '').replace(/'/g, "''")}'`;
        return runPowershell(`Stop-Process ${target} -Force`, 15_000);
      },
    },
    {
      declaration: {
        name: 'screen.capture',
        description: '截取主屏幕保存为 PNG 图片（L0）。返回保存路径。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '保存路径（可选，默认桌面）' },
          },
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { path: savePath } = (input ?? {}) as CaptureInput;
        const target =
          savePath?.trim() ||
          path.join(process.env.USERPROFILE ?? '.', 'Desktop', `screenshot-${Date.now()}.png`);
        const script = [
          'Add-Type -TypeDefinition \'using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}\'',
          '[D]::SetProcessDPIAware() | Out-Null',
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
          '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
          `$bmp.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
          'Write-Output "saved"',
        ].join('; ');
        const result = await runPowershell(script, 20_000);
        if (!result.ok) return result;
        return { ok: true, data: { path: target } };
      },
    },
    {
      declaration: {
        name: 'window.list',
        description: '列出当前桌面所有可见窗口（进程名、标题）。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute() {
        const result = await runPowershell(
          'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress',
          15_000,
        );
        if (!result.ok) return result;
        let windows: unknown[] = [];
        const raw = (result.data as { stdout?: string }).stdout ?? '';
        try {
          const parsed = JSON.parse(raw) as unknown;
          windows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        } catch {
          // leave empty on parse failure
        }
        return { ok: true, data: { count: windows.length, windows } };
      },
    },
    {
      declaration: {
        name: 'screen.analyze',
        description:
          '截取屏幕并用视觉模型分析内容（L0）。可让模型描述屏幕、找元素位置；' +
          '找元素时要求它返回屏幕像素坐标，格式：元素名 (x, y)。' +
          'detail 默认 fast（qwen-vl-max，快）；只有需要深度理解复杂屏幕内容时才用 deep（qwen3.8-max，慢但更强）。' +
          '可选 region 只分析屏幕的一个裁剪区域（小目标先放大再找，坐标以裁剪区域左上角为原点），' +
          '返回值带 frameId（截图帧标识），后续 screen.click 应原样传回以校验画面未过期。',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '要分析的问题，例如“屏幕上有什么”或“找到搜索框的坐标”',
            },
            detail: {
              type: 'string',
              enum: ['fast', 'deep'],
              description: 'fast=快速识别（默认）；deep=深度分析（更慢但理解更强）',
            },
            region: {
              type: 'object',
              properties: {
                x: { type: 'number', description: '裁剪区域左上角 X（屏幕物理像素）' },
                y: { type: 'number', description: '裁剪区域左上角 Y（屏幕物理像素）' },
                w: { type: 'number', description: '裁剪区域宽度' },
                h: { type: 'number', description: '裁剪区域高度' },
              },
              required: ['x', 'y', 'w', 'h'],
              description: '只分析屏幕的该矩形区域（放大细节、坐标相对区域左上角）',
            },
          },
          required: [],
        },
        permissionLevel: 0 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { query, detail, region } = (input ?? {}) as {
          query?: string;
          detail?: string;
          region?: { x: number; y: number; w: number; h: number };
        };
        let pngPath: string | undefined;
        try {
          const shot = await captureScreenWithSignature(region);
          pngPath = shot.path;
          lastScreenSignature = shot.signature;
          const image = await readFile(pngPath);
          const prompt = [
            '你是屏幕分析助手。根据用户的问题描述屏幕内容。',
            region
              ? `本次分析的是屏幕中的一个裁剪区域（屏幕坐标 ${region.x},${region.y}，尺寸 ${region.w}x${region.h}）。元素坐标以裁剪区域左上角为原点，格式：元素名 (x, y)。`
              : '如果用户要找某个元素（按钮、图标、输入框、链接等），在回答中给出它在屏幕上的像素坐标，格式：元素名 (x, y)。坐标以图片左上角为原点，即屏幕物理像素坐标。',
            `用户问题：${query?.trim() || '描述一下屏幕上显示的内容'}`,
          ].join('\n');
          const model = detail === 'deep' ? VISION_MODEL_DEEP : VISION_MODEL;
          const description = await callQwenVision(image.toString('base64'), prompt, model);
          return {
            ok: true,
            data: {
              description,
              frameId: shot.signature,
              ...(region ? { region } : {}),
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: `屏幕分析失败：${error instanceof Error ? error.message : String(error)}`,
          };
        } finally {
          if (pngPath) void unlink(pngPath).catch(() => {});
        }
      },
    },
    {
      declaration: {
        name: 'screen.click',
        description:
          '在屏幕指定像素坐标处点击鼠标左键（L2：需要用户确认）。坐标来自 screen.analyze 的返回值；' +
          '若 screen.analyze 用了 region，这里必须传同一个 region 做坐标映射，并传回 frameId 校验画面未过期。' +
          '点击后会自动检测画面是否变化：无变化会明确提示，避免重复点击。',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '屏幕 X 坐标（物理像素）' },
            y: { type: 'number', description: '屏幕 Y 坐标（物理像素）' },
            frameId: {
              type: 'string',
              description: 'screen.analyze 返回的帧标识；画面已变化时点击会被拒绝',
            },
            region: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                w: { type: 'number' },
                h: { type: 'number' },
              },
              required: ['x', 'y', 'w', 'h'],
              description: '与 screen.analyze 相同的裁剪区域，用于把相对坐标映射回屏幕坐标',
            },
          },
          required: ['x', 'y'],
        },
        permissionLevel: 2 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { x, y, frameId, region } = (input ?? {}) as {
          x?: number;
          y?: number;
          frameId?: string;
          region?: { x: number; y: number; w: number; h: number };
        };
        if (typeof x !== 'number' || typeof y !== 'number') {
          return { ok: false, error: '缺少 x / y 坐标' };
        }
        if (frameId && lastScreenSignature && frameId !== lastScreenSignature) {
          return {
            ok: false,
            error: '画面已变化（坐标来自过期截图），请先重新调用 screen.analyze 获取最新坐标',
          };
        }
        const screenX = Math.round(x + (region?.x ?? 0));
        const screenY = Math.round(y + (region?.y ?? 0));
        const script = [
          'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class U{[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,int dwExtraInfo);}\'',
          `[U]::SetCursorPos(${screenX},${screenY}) | Out-Null`,
          '[U]::mouse_event(0x0002,0,0,0,0)',
          'Start-Sleep -Milliseconds 60',
          '[U]::mouse_event(0x0004,0,0,0,0)',
        ].join('; ');
        const clickResult = await runPowershell(script, 10_000);
        if (!clickResult.ok) return clickResult;
        // 点击后复查同一区域：画面无变化时明确提示（防止模型重复点击同一位置）。
        try {
          const before = lastScreenSignature;
          const after = await captureScreenWithSignature(region);
          if (before && after.signature === before) {
            return {
              ok: true,
              data: {
                clicked: true,
                noVisibleChange: true,
                message:
                  '点击已执行，但画面与点击前完全一致，可能没有生效。建议重新 screen.analyze 或改用其他目标。',
              },
            };
          }
          lastScreenSignature = after.signature;
          return { ok: true, data: { clicked: true, frameId: after.signature } };
        } catch {
          return { ok: true, data: { clicked: true } };
        }
      },
    },
    {
      declaration: {
        name: 'screen.type',
        description: '在焦点窗口输入一段文本（含中文，L2：需要用户确认）。',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文本' },
          },
          required: ['text'],
        },
        permissionLevel: 2 as PermissionLevel,
      },
      async execute(input: unknown) {
        const { text } = (input ?? {}) as { text?: string };
        if (text === undefined) {
          return { ok: false, error: '缺少 text 参数' };
        }
        const script = [
          `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`,
          '$w = New-Object -ComObject WScript.Shell',
          '$w.SendKeys("^v")',
        ].join('; ');
        return runPowershell(script, 10_000);
      },
    },
  ];
}

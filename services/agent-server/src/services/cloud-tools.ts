import { lighthouse } from 'tencentcloud-sdk-nodejs-lighthouse';
import type { Tool, ToolResult } from '@personal-ai/tools';
import type { TimelineStore } from '@personal-ai/memory';

/**
 * 腾讯云轻量应用服务器（Lighthouse）管理工具。
 *
 * 架构参考：不引入额外 Manager/Orchestrator，仅把「实例状态 / 防火墙规则」
 * 两条能力暴露为 Agent 可调用的结构化工具，凭据来自环境变量，调用方
 * （桌面 / 定时任务 / 自我开发）通过既有权限系统分级放行。
 *
 * 权限说明（AGENTS.md 新增工具准则）：
 * - cloud.instance_status / cloud.firewall_list：L0，只读查询。
 * - cloud.firewall_open：L1，开放公网 TCP 端口（可逆，可再次关闭），
 *   微信通道可用；描述中明确标注影响面。
 * - cloud.firewall_close：L2，删除防火墙规则（永久移除放行，误删可能
 *   导致 SSH/服务不可达），微信通道自动拒绝，避免远程误操作锁死实例。
 * - cloud.server_reboot：L3，重启整台云服务器（系统级，中断所有服务），
 *   必须显式 confirm=true；重启后 systemd + Docker 自动拉起服务并通知。
 */

/** 与 tencentcloud-sdk-nodejs-lighthouse 客户端方法形状对齐的接口（测试可注入桩）。 */
export interface LighthouseClientLike {
  DescribeInstances(params: { InstanceIds?: string[] }): Promise<unknown>;
  DescribeFirewallRules(params: { InstanceId: string }): Promise<unknown>;
  CreateFirewallRules(params: {
    InstanceId: string;
    FirewallRules: unknown[];
  }): Promise<unknown>;
  DeleteFirewallRules(params: {
    InstanceId: string;
    FirewallRules: unknown[];
  }): Promise<unknown>;
  RebootInstances(params: { InstanceIds: string[] }): Promise<unknown>;
}

export interface CloudToolOptions {
  secretId: string;
  secretKey: string;
  region?: string;
  instanceId?: string;
  /** 测试注入：返回自定义客户端；缺省用官方 SDK。 */
  clientFactory?: (opts: {
    secretId: string;
    secretKey: string;
    region: string;
  }) => LighthouseClientLike;
  /** 事件时间线：云操作留痕。 */
  timeline?: TimelineStore;
}

interface FirewallRule {
  Protocol?: string;
  Port?: string;
  CidrBlock?: string;
  Ipv6CidrBlock?: string;
  Action?: string;
  FirewallRuleDescription?: string;
}

function createLighthouseClient({
  secretId,
  secretKey,
  region,
}: {
  secretId: string;
  secretKey: string;
  region: string;
}): LighthouseClientLike {
  return new lighthouse.v20200324.Client({
    credential: { secretId, secretKey },
    region,
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPort(port: unknown): number {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('端口必须是 1-65535 之间的整数');
  }
  return value;
}

function summarizeInstance(instance: Record<string, unknown>): Record<string, unknown> {
  return {
    instanceId: instance.InstanceId,
    name: instance.InstanceName,
    state: instance.InstanceState,
    publicIps: instance.PublicAddresses,
    privateIps: instance.PrivateAddresses,
    cpu: instance.CPU,
    memoryGB: instance.Memory,
    zone: instance.Zone,
    platform: instance.Platform,
    osName: instance.OsName,
    expiresAt: instance.ExpiredTime,
    bandwidthMbps: (
      (instance.InternetAccessible as { InternetMaxBandwidthOut?: number } | undefined) ??
      {}
    ).InternetMaxBandwidthOut,
  };
}

function formatRule(rule: FirewallRule): Record<string, unknown> {
  const source = rule.CidrBlock || rule.Ipv6CidrBlock || '';
  return {
    protocol: rule.Protocol ?? '',
    port: rule.Port ?? '',
    source,
    action: rule.Action ?? '',
    description: rule.FirewallRuleDescription ?? '',
  };
}

export function createCloudTools(options: CloudToolOptions): Tool[] {
  const {
    secretId,
    secretKey,
    region = 'ap-shanghai',
    instanceId = 'lhins-f1k9cz9m',
    timeline,
  } = options;
  const clientFactory = options.clientFactory ?? createLighthouseClient;
  const client = clientFactory({ secretId, secretKey, region });

  const tools: Tool[] = [
    {
      name: 'cloud.instance_status',
      description:
        '查询腾讯云轻量应用服务器（Lighthouse）实例状态：运行状态、公网/内网 IP、配置、地域、到期时间（只读，L0）。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        try {
          const result = await client.DescribeInstances({ InstanceIds: [instanceId] });
          const instances =
            ((result as { InstanceSet?: Array<Record<string, unknown>> }).InstanceSet ?? []);
          if (instances.length === 0) {
            return { ok: false, error: `未找到实例 ${instanceId}，请检查 TENCENT_LIGHTHOUSE_INSTANCE_ID` };
          }
          return { ok: true, data: { instance: summarizeInstance(instances[0]!) } };
        } catch (error) {
          return { ok: false, error: `查询实例状态失败：${toErrorMessage(error)}` };
        }
      },
    },
    {
      name: 'cloud.firewall_list',
      description:
        '列出腾讯云轻量应用服务器当前防火墙规则（协议/端口/来源/放行或拒绝/备注），只读（L0）。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        try {
          const result = await client.DescribeFirewallRules({ InstanceId: instanceId });
          const rules = (
            (result as { FirewallRuleSet?: Array<Record<string, unknown>> }).FirewallRuleSet ?? []
          ).map((rule) =>
            formatRule(rule as FirewallRule),
          );
          return { ok: true, data: { count: rules.length, rules } };
        } catch (error) {
          return { ok: false, error: `查询防火墙规则失败：${toErrorMessage(error)}` };
        }
      },
    },
    {
      name: 'cloud.firewall_open',
      description:
        '开放轻量应用服务器公网 TCP 端口（IPv4+IPv6 同时放行，可逆）。会修改云防火墙，'
        + '端口开放后公网即可访问该端口上的服务；可通过 cloud.firewall_close 关闭（L1）。',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'number', description: '要开放的 TCP 端口（1-65535）' },
          description: { type: 'string', description: '规则备注，例如 "assistant-app 备用端口"' },
        },
        required: ['port'],
      },
      permissionLevel: 1,
      timeoutMs: 20_000,
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { port, description = '' } = (input ?? {}) as {
            port?: unknown;
            description?: string;
          };
          const portNumber = assertPort(port);
          const existing = await client.DescribeFirewallRules({ InstanceId: instanceId });
          const rules = (
            (existing as { FirewallRuleSet?: Array<Record<string, unknown>> }).FirewallRuleSet ?? []
          ) as FirewallRule[];
          const hasV4 = rules.some(
            (rule) => rule.Protocol === 'TCP' && String(rule.Port) === String(portNumber) && rule.CidrBlock,
          );
          const hasV6 = rules.some(
            (rule) => rule.Protocol === 'TCP' && String(rule.Port) === String(portNumber) && rule.Ipv6CidrBlock,
          );
          if (hasV4 && hasV6) {
            return { ok: true, data: { port: portNumber, alreadyOpen: true } };
          }
          const toAdd: Array<Record<string, unknown>> = [];
          if (!hasV4) {
            toAdd.push({
              Protocol: 'TCP',
              Port: String(portNumber),
              CidrBlock: '0.0.0.0/0',
              Action: 'ACCEPT',
              FirewallRuleDescription: description,
            });
          }
          if (!hasV6) {
            toAdd.push({
              Protocol: 'TCP',
              Port: String(portNumber),
              Ipv6CidrBlock: '::/0',
              Action: 'ACCEPT',
              FirewallRuleDescription: description,
            });
          }
          await client.CreateFirewallRules({ InstanceId: instanceId, FirewallRules: toAdd });
          void timeline?.addEvent({
            type: 'cloud',
            summary: `开放云服务器 TCP ${portNumber} 端口（IPv4+IPv6）`,
            metadata: { port: portNumber },
          });
          return {
            ok: true,
            data: {
              port: portNumber,
              added: toAdd.length,
              note: `已放行公网 TCP ${portNumber}（IPv4+IPv6）`,
            },
          };
        } catch (error) {
          return { ok: false, error: `开放端口失败：${toErrorMessage(error)}` };
        }
      },
    },
    {
      name: 'cloud.firewall_close',
      description:
        '删除轻量应用服务器的 TCP 防火墙规则（永久移除公网放行，不可恢复，需要时可重新开放）。'
        + '误删可能使 SSH 或线上服务无法访问；关闭 SSH 端口 22 必须额外传 force=true（L2）。',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'number', description: '要关闭的 TCP 端口（1-65535）' },
          force: {
            type: 'boolean',
            description: '关闭 SSH 端口 22 时需要显式设为 true，防止误操作锁死实例',
          },
        },
        required: ['port'],
      },
      permissionLevel: 2,
      timeoutMs: 20_000,
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { port, force = false } = (input ?? {}) as {
            port?: unknown;
            force?: boolean;
          };
          const portNumber = assertPort(port);
          if (portNumber === 22 && force !== true) {
            return {
              ok: false,
              error: '关闭 SSH 端口 22 会锁死远程登录，需要显式传 force=true 确认',
            };
          }
          const existing = await client.DescribeFirewallRules({ InstanceId: instanceId });
          const rules = (
            (existing as { FirewallRuleSet?: Array<Record<string, unknown>> }).FirewallRuleSet ?? []
          ) as FirewallRule[];
          const matching = rules.filter(
            (rule) => rule.Protocol === 'TCP' && String(rule.Port) === String(portNumber),
          );
          if (matching.length === 0) {
            return { ok: true, data: { port: portNumber, removed: 0, alreadyClosed: true } };
          }
          await client.DeleteFirewallRules({
            InstanceId: instanceId,
            FirewallRules: matching.map((rule) => {
              // 腾讯云 API 拒绝空串 CidrBlock/Ipv6CidrBlock：
              // IPv6 规则在查询结果里 CidrBlock 为空串，必须省略而非传空。
              const payload: Record<string, unknown> = {
                Protocol: rule.Protocol,
                Port: rule.Port,
                Action: rule.Action,
              };
              if (rule.CidrBlock) payload.CidrBlock = rule.CidrBlock;
              if (rule.Ipv6CidrBlock) payload.Ipv6CidrBlock = rule.Ipv6CidrBlock;
              if (rule.FirewallRuleDescription) {
                payload.FirewallRuleDescription = rule.FirewallRuleDescription;
              }
              return payload;
            }),
          });
          void timeline?.addEvent({
            type: 'cloud',
            summary: `关闭云服务器 TCP ${portNumber} 端口（移除 ${matching.length} 条规则）`,
            metadata: { port: portNumber, removed: matching.length },
          });
          return {
            ok: true,
            data: {
              port: portNumber,
              removed: matching.length,
              note: `已删除公网 TCP ${portNumber} 的 ${matching.length} 条放行规则`,
            },
          };
        } catch (error) {
          return { ok: false, error: `关闭端口失败：${toErrorMessage(error)}` };
        }
      },
    },
    {
      name: 'cloud.server_reboot',
      description:
        '重启腾讯云轻量应用服务器（系统级 L3：中断所有服务约 1-3 分钟，当前会话会断开）。'
        + '重启后 systemd + Docker 会自动拉起全部项目服务，恢复后会自动通知。'
        + '高风险操作：必须显式传 confirm=true 才会执行。',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: '确认重启，必须为 true 才执行',
          },
        },
        required: ['confirm'],
      },
      permissionLevel: 3,
      timeoutMs: 30_000,
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { confirm = false } = (input ?? {}) as { confirm?: boolean };
          if (confirm !== true) {
            return {
              ok: false,
              error: '重启云服务器是系统级操作，需要显式传 confirm=true 确认',
            };
          }
          await client.RebootInstances({ InstanceIds: [instanceId] });
          void timeline?.addEvent({
            type: 'cloud',
            summary: '重启云服务器（服务将中断约 1-3 分钟）',
            metadata: { instanceId },
          });
          return {
            ok: true,
            data: {
              instanceId,
              note:
                '已提交重启指令：服务器约 1-3 分钟内重启，重启后所有服务自动恢复并通知',
            },
          };
        } catch (error) {
          return { ok: false, error: `重启云服务器失败：${toErrorMessage(error)}` };
        }
      },
    },
  ];

  return tools;
}

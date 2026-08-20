import { describe, expect, it, vi } from 'vitest';
import {
  createCloudTools,
  type LighthouseClientLike,
} from './cloud-tools.js';

const INSTANCE_ID = 'lhins-f1k9cz9m';

function makeStubClient(overrides: Partial<LighthouseClientLike> = {}): LighthouseClientLike {
  return {
    DescribeInstances: vi.fn(async () => ({
      InstanceSet: [
        {
          InstanceId: INSTANCE_ID,
          InstanceName: 'promise-server',
          InstanceState: 'RUNNING',
          PublicAddresses: ['122.152.209.182'],
          PrivateAddresses: ['10.0.0.15'],
          CPU: 4,
          Memory: 4,
          Zone: 'ap-shanghai-4',
          Platform: 'UBUNTU',
          OsName: 'Ubuntu Server 24.04 LTS 64bit',
          ExpiredTime: '2027-04-15T07:11:34Z',
          InternetAccessible: { InternetMaxBandwidthOut: 3 },
        },
      ],
    })),
    DescribeFirewallRules: vi.fn(async () => ({
      FirewallRuleSet: [
        {
          Protocol: 'TCP',
          Port: '3000',
          CidrBlock: '0.0.0.0/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: 'app',
        },
        {
          Protocol: 'TCP',
          Port: '3000',
          Ipv6CidrBlock: '::/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: 'app',
        },
        {
          Protocol: 'TCP',
          Port: '22',
          CidrBlock: '0.0.0.0/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: 'SSH',
        },
      ],
    })),
    CreateFirewallRules: vi.fn(async () => ({})),
    DeleteFirewallRules: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeTools(client: LighthouseClientLike) {
  return createCloudTools({
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key',
    region: 'ap-shanghai',
    instanceId: INSTANCE_ID,
    clientFactory: () => client,
  });
}

describe('cloud.* 工具权限分级（AGENTS.md 新增工具准则）', () => {
  it('只读查询为 L0，开端口为 L1，删规则为 L2（微信通道自动拒绝）', () => {
    const tools = makeTools(makeStubClient());
    const byName = new Map(tools.map((tool) => [tool.name, tool.permissionLevel]));
    expect(byName.get('cloud.instance_status')).toBe(0);
    expect(byName.get('cloud.firewall_list')).toBe(0);
    expect(byName.get('cloud.firewall_open')).toBe(1);
    expect(byName.get('cloud.firewall_close')).toBe(2);
  });
});

describe('cloud.instance_status', () => {
  it('返回实例状态摘要', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[0]!;
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { instance: Record<string, unknown> };
    expect(data.instance.name).toBe('promise-server');
    expect(data.instance.publicIps).toEqual(['122.152.209.182']);
    expect(data.instance.state).toBe('RUNNING');
    expect(client.DescribeInstances).toHaveBeenCalledWith({ InstanceIds: [INSTANCE_ID] });
  });

  it('实例不存在时返回错误', async () => {
    const client = makeStubClient({
      DescribeInstances: vi.fn(async () => ({ InstanceSet: [] })),
    });
    const tool = makeTools(client)[0]!;
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未找到实例');
  });

  it('SDK 异常映射为可读错误', async () => {
    const client = makeStubClient({
      DescribeInstances: vi.fn(async () => {
        throw new Error('AuthFailure.SecretIdNotFound');
      }),
    });
    const tool = makeTools(client)[0]!;
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('AuthFailure.SecretIdNotFound');
  });
});

describe('cloud.firewall_list', () => {
  it('列出规则并统一格式', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[1]!;
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; rules: Array<Record<string, unknown>> };
    expect(data.count).toBe(3);
    expect(data.rules[0]).toMatchObject({
      protocol: 'TCP',
      port: '3000',
      source: '0.0.0.0/0',
      action: 'ACCEPT',
    });
    expect(data.rules[1]!.source).toBe('::/0');
  });
});

describe('cloud.firewall_open', () => {
  it('端口未开放时同时添加 IPv4 与 IPv6 规则', async () => {
    const client = makeStubClient({
      DescribeFirewallRules: vi.fn(async () => ({
        FirewallRuleSet: [
          { Protocol: 'TCP', Port: '22', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT' },
        ],
      })),
    });
    const tool = makeTools(client)[2]!;
    const result = await tool.execute({ port: 8080, description: '测试' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect(client.CreateFirewallRules).toHaveBeenCalledWith({
      InstanceId: INSTANCE_ID,
      FirewallRules: [
        {
          Protocol: 'TCP',
          Port: '8080',
          CidrBlock: '0.0.0.0/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: '测试',
        },
        {
          Protocol: 'TCP',
          Port: '8080',
          Ipv6CidrBlock: '::/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: '测试',
        },
      ],
    });
  });

  it('IPv4/IPv6 均已放行时幂等跳过', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[2]!;
    const result = await tool.execute({ port: 3000 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { alreadyOpen: boolean }).alreadyOpen).toBe(true);
    expect(client.CreateFirewallRules).not.toHaveBeenCalled();
  });

  it('只缺 IPv6 时只补 IPv6 规则', async () => {
    const client = makeStubClient({
      DescribeFirewallRules: vi.fn(async () => ({
        FirewallRuleSet: [
          { Protocol: 'TCP', Port: '9000', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT' },
        ],
      })),
    });
    const tool = makeTools(client)[2]!;
    const result = await tool.execute({ port: 9000 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect(client.CreateFirewallRules).toHaveBeenCalledTimes(1);
    expect(client.CreateFirewallRules).toHaveBeenCalledWith(
      expect.objectContaining({
        InstanceId: INSTANCE_ID,
        // 精确数组长度 1：只补 IPv6，IPv4 已存在不应重复添加
        FirewallRules: [
          expect.objectContaining({ Protocol: 'TCP', Port: '9000', Ipv6CidrBlock: '::/0' }),
        ],
      }),
    );
  });

  it('非法端口参数校验失败', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[2]!;
    const result = await tool.execute({ port: 70000 }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1-65535');
  });
});

describe('cloud.firewall_close', () => {
  it('删除匹配端口的全部 TCP 规则', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[3]!;
    const result = await tool.execute({ port: 3000 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { removed: number }).removed).toBe(2);
    expect(client.DeleteFirewallRules).toHaveBeenCalledWith({
      InstanceId: INSTANCE_ID,
      FirewallRules: [
        {
          Protocol: 'TCP',
          Port: '3000',
          CidrBlock: '0.0.0.0/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: 'app',
        },
        {
          Protocol: 'TCP',
          Port: '3000',
          Ipv6CidrBlock: '::/0',
          Action: 'ACCEPT',
          FirewallRuleDescription: 'app',
        },
      ],
    });
  });

  it('关闭 SSH 22 必须显式 force=true', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[3]!;
    const denied = await tool.execute({ port: 22 }, { sessionId: 's1' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('force=true');
    expect(client.DeleteFirewallRules).not.toHaveBeenCalled();

    const allowed = await tool.execute({ port: 22, force: true }, { sessionId: 's1' });
    expect(allowed.ok).toBe(true);
    expect(client.DeleteFirewallRules).toHaveBeenCalled();
  });

  it('没有匹配规则时幂等返回', async () => {
    const client = makeStubClient();
    const tool = makeTools(client)[3]!;
    const result = await tool.execute({ port: 9999 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { alreadyClosed: boolean }).alreadyClosed).toBe(true);
    expect(client.DeleteFirewallRules).not.toHaveBeenCalled();
  });
});

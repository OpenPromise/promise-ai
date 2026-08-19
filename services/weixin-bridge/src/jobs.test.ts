import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ILinkClient } from './ilink.js';
import { saveLibraryFile } from './files.js';
import { FileJobManager } from './jobs.js';

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error('waitFor timeout');
}

function makeFakeClient(): ILinkClient {
  return {
    async uploadMediaBytes() {
      return {
        downloadParam: 'dl-param',
        aesKeyBase64: 'a2V5',
        ciphertextSize: 16,
        plaintextSize: 10,
      };
    },
    async sendUploadedFileToUser() {},
  } as unknown as ILinkClient;
}

describe('FileJobManager', () => {
  it('starts a background job and reports progress to done', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxjobs-'));
    await saveLibraryFile(dir, '菜单.psd', Buffer.alloc(100));
    const progress: string[] = [];
    const manager = new FileJobManager({
      filesDir: dir,
      clientFactory: makeFakeClient,
      sendProgress: async (_peer, text) => {
        progress.push(text);
      },
    });

    const { job, deduped } = await manager.start('wx_peer', '菜单');
    expect(deduped).toBe(false);
    // 立即返回（不等待上传），状态可能在 queued/uploading
    expect(['queued', 'uploading'].includes(job.status)).toBe(true);

    // 同文件去重：仍在进行中时重复创建会返回同一任务
    const second = await manager.start('wx_peer', '菜单.psd');
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(job.id);

    await waitFor(() => manager.get(job.id)?.status === 'done');
    expect(progress.some((text) => text.includes('开始后台发送「菜单.psd」'))).toBe(true);
    expect(progress.some((text) => text.includes('上传完成'))).toBe(true);
    expect(progress.some((text) => text.includes('已发送到你微信'))).toBe(true);
  });

  it('marks the job failed and sends an error progress message', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxjobs-'));
    await saveLibraryFile(dir, '坏文件.zip', Buffer.alloc(10));
    const progress: string[] = [];
    const manager = new FileJobManager({
      filesDir: dir,
      clientFactory: () =>
        ({
          async uploadMediaBytes() {
            throw new Error('CDN 上传失败');
          },
        }) as unknown as ILinkClient,
      sendProgress: async (_peer, text) => {
        progress.push(text);
      },
    });

    const { job } = await manager.start('wx_peer', '坏文件');
    await waitFor(() => manager.get(job.id)?.status === 'failed');
    expect(manager.get(job.id)?.error).toContain('CDN 上传失败');
    expect(progress.some((text) => text.includes('发送失败'))).toBe(true);
  });
});

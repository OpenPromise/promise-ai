import { randomUUID } from 'node:crypto';
import type { ILinkClient } from './ilink.js';
import { UploadMediaType } from './ilink.js';
import { buildReplyMessage } from './ilink.js';
import { listLibraryFiles, readLibraryFile, resolveFileByName } from './files.js';

export type FileJobStatus = 'queued' | 'uploading' | 'sending' | 'done' | 'failed';

export interface FileJob {
  id: string;
  fileName: string;
  size: number;
  peer: string;
  status: FileJobStatus;
  progress?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface FileJobManagerOptions {
  filesDir: string;
  clientFactory: () => ILinkClient;
  log?: (message: string) => void;
  /** 进度消息发送；默认发到 peer 的微信。 */
  sendProgress?: (peer: string, text: string) => Promise<void>;
  maxBytes?: number;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

/**
 * 后台文件发送任务：工具立即返回 jobId，上传/投递在后台异步执行，
 * 每个阶段通过微信进度消息实时告知，完成/失败再提醒。
 */
export class FileJobManager {
  readonly #jobs = new Map<string, FileJob>();
  readonly #options: FileJobManagerOptions;

  constructor(options: FileJobManagerOptions) {
    this.#options = options;
  }

  get(id: string): FileJob | undefined {
    return this.#jobs.get(id);
  }

  list(limit = 20): FileJob[] {
    return [...this.#jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** 同一文件正在发送中（去重，防重复任务）。 */
  activeFor(fileName: string): FileJob | undefined {
    const lower = fileName.toLowerCase();
    return [...this.#jobs.values()].find(
      (job) =>
        job.fileName.toLowerCase() === lower &&
        (job.status === 'queued' || job.status === 'uploading' || job.status === 'sending'),
    );
  }

  /** 校验文件并创建后台任务（立即返回，不等待上传）。 */
  async start(peer: string, fileName: string): Promise<{ job: FileJob; deduped: boolean }> {
    const existing = this.activeFor(fileName);
    if (existing) return { job: existing, deduped: true };

    // 模糊匹配（精确/前缀/包含），与同步发送接口一致。
    const files = await listLibraryFiles(this.#options.filesDir);
    const matched = resolveFileByName(files, fileName);
    if (!matched) throw new Error(`文件库中找不到「${fileName}」`);
    const loaded = await readLibraryFile(this.#options.filesDir, matched.name);
    if (!loaded) throw new Error(`无法读取文件「${matched.name}」`);
    const maxBytes = this.#options.maxBytes ?? 100 * 1024 * 1024;
    if (loaded.bytes.length > maxBytes) {
      throw new Error(`文件超过 ${formatSize(maxBytes)} 上限：${loaded.name}`);
    }

    const job: FileJob = {
      id: randomUUID(),
      fileName: loaded.name,
      size: loaded.bytes.length,
      peer,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.#jobs.set(job.id, job);
    void this.#run(job, loaded.bytes);
    return { job, deduped: false };
  }

  async #run(job: FileJob, bytes: Buffer): Promise<void> {
    const { log, sendProgress } = this.#options;
    const progress = async (text: string): Promise<void> => {
      job.progress = text;
      try {
        if (sendProgress) await sendProgress(job.peer, text);
        else
          await this.#options
            .clientFactory()
            .sendMessage(buildReplyMessage({ to: job.peer, text }));
      } catch (error) {
        log?.(
          `[weixin] 进度消息发送失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    try {
      job.status = 'uploading';
      await progress(`📤 开始后台发送「${job.fileName}」（${formatSize(job.size)}）…`);

      const client = this.#options.clientFactory();
      const uploaded = await client.uploadMediaBytes(job.peer, UploadMediaType.FILE, bytes);
      job.status = 'sending';
      await progress('⏳ 上传完成，正在投递到微信…');

      await client.sendUploadedFileToUser({
        to: job.peer,
        fileName: job.fileName,
        uploaded,
      });
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      await progress(`✅ 「${job.fileName}」已发送到你微信，请查收`);
      log?.(`[weixin] 后台发送完成 ${job.fileName}（${formatSize(job.size)}）`);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      await progress(`❌ 「${job.fileName}」发送失败：${job.error}`);
      log?.(`[weixin] 后台发送失败 ${job.fileName}：${job.error}`);
    }
  }
}

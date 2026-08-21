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

/** 后台文件发送的全局并发上限：超过则排队，防止连环请求拉起无上限上传。 */
const MAX_CONCURRENT_JOBS = 3;
/** 任务表上限：超过后驱逐最旧的已完成/失败任务。 */
const MAX_JOBS = 50;

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
  /** 并发超限时排队的任务（FIFO）。 */
  readonly #waiting: Array<{ job: FileJob; bytes: Buffer }> = [];
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
    this.#startQueuedOrWait(job, loaded.bytes);
    return { job, deduped: false };
  }

  /** 并发未满则启动，否则排队（队列中的 job 保持 queued，参与同文件去重）。 */
  #startQueuedOrWait(job: FileJob, bytes: Buffer): void {
    if (this.#activeCount() >= MAX_CONCURRENT_JOBS) {
      this.#waiting.push({ job, bytes });
      return;
    }
    void this.#run(job, bytes);
  }

  /** 正在上传/投递的任务数（queued 排队中的不算）。 */
  #activeCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) {
      if (job.status === 'uploading' || job.status === 'sending') count += 1;
    }
    return count;
  }

  /** 前一个任务结束后，从等待队列拉下一个（直到并发满）。 */
  #drainQueue(): void {
    while (this.#waiting.length > 0 && this.#activeCount() < MAX_CONCURRENT_JOBS) {
      const next = this.#waiting.shift()!;
      this.#startQueuedOrWait(next.job, next.bytes);
    }
  }

  /** 有界驱逐：只清已完成/失败的最旧记录，运行中的不受影响。 */
  #evict(): void {
    if (this.#jobs.size <= MAX_JOBS) return;
    const finished = [...this.#jobs.values()]
      .filter((job) => job.status === 'done' || job.status === 'failed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const overflow = this.#jobs.size - MAX_JOBS;
    for (const job of finished.slice(0, overflow)) this.#jobs.delete(job.id);
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
    } finally {
      this.#drainQueue();
      this.#evict();
    }
  }
}

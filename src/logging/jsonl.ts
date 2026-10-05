import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
export async function openLog(directory: string, runId: string): Promise<FileHandle> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return open(join(directory, `${runId}.jsonl`), 'wx', 0o600);
}

import * as fs from 'fs';
import * as path from 'path';
import { Profile } from './profiles';

/**
 * Conversation của Claude Code nằm trong thư mục cấu hình của từng profile:
 *   <configDir>/projects/<cwd đã mã hoá>/<sessionId>.jsonl
 *   <configDir>/file-history/<sessionId>/   (checkpoint để rewind, có thể không có)
 * Copy hai mục này sang profile khác là account đó resume được đúng conversation.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Session {
  id: string;
  /** Thư mục làm việc của session. */
  cwd: string;
  mtime: number;
  title?: string;
}

/** Cách Claude Code đặt tên thư mục project: mọi ký tự không phải chữ/số thành "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function sessionFile(profile: Profile, cwd: string, id: string): string {
  return path.join(profile.configDir, 'projects', projectDirName(cwd), `${id}.jsonl`);
}

function historyDir(profile: Profile, id: string): string {
  return path.join(profile.configDir, 'file-history', id);
}

/** Các session của profile trong những thư mục cho trước, mới nhất trước. */
export function listSessions(profile: Profile, cwds: string[]): Session[] {
  const sessions: Session[] = [];
  for (const cwd of cwds) {
    const dir = path.join(profile.configDir, 'projects', projectDirName(cwd));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.slice(0, -'.jsonl'.length);
      if (!name.endsWith('.jsonl') || !SESSION_ID_RE.test(id)) {
        continue;
      }
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0) {
        sessions.push({ id, cwd, mtime: stat.mtimeMs, title: readTitle(file, stat.size) });
      }
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

export function sessionMtime(profile: Profile, session: Session): number | undefined {
  try {
    return fs.statSync(sessionFile(profile, session.cwd, session.id)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Copy conversation (và checkpoint nếu có) từ profile này sang profile khác, ghi đè bản ở đích.
 * Ghi ra file tạm rồi rename để CLI không bao giờ đọc phải file copy dở.
 */
export function copySession(from: Profile, to: Profile, session: Session): void {
  const src = sessionFile(from, session.cwd, session.id);
  const dest = sessionFile(to, session.cwd, session.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);

  const history = historyDir(from, session.id);
  if (fs.existsSync(history)) {
    fs.cpSync(history, historyDir(to, session.id), { recursive: true, force: true });
  }
}

/** Tiêu đề hiển thị: ai-title mới nhất, nếu không có thì prompt gần nhất. Chỉ đọc phần cuối file. */
function readTitle(file: string, size: number): string | undefined {
  const TAIL = 256 * 1024;
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"') && !line.includes('"last-prompt"')) {
      continue;
    }
    try {
      const d = JSON.parse(line);
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') {
        aiTitle = d.aiTitle;
      } else if (d.type === 'last-prompt' && typeof d.lastPrompt === 'string') {
        lastPrompt = d.lastPrompt;
      }
    } catch {
      // dòng đầu của phần tail có thể bị cắt giữa chừng
    }
  }
  const title = (aiTitle ?? lastPrompt)?.replace(/\s+/g, ' ').trim();
  return title ? (title.length > 80 ? `${title.slice(0, 79)}…` : title) : undefined;
}

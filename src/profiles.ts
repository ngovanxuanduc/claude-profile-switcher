import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Tên của profile gốc của Claude Code (~/.claude, không đặt CLAUDE_CONFIG_DIR). */
export const DEFAULT_PROFILE = 'default';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface Profile {
  name: string;
  /** Thư mục cấu hình. Với profile gốc là ~/.claude. */
  configDir: string;
  /** true = profile gốc: không đặt CLAUDE_CONFIG_DIR. */
  builtin: boolean;
}

/** Thông tin hiển thị, không phải bí mật. Token nằm trong Keychain, không bao giờ được đọc. */
export interface AccountInfo {
  email?: string;
  organization?: string;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export class ProfileStore {
  constructor(private readonly rootSetting: () => string) {}

  get root(): string {
    return path.resolve(expandHome(this.rootSetting()));
  }

  builtin(): Profile {
    return { name: DEFAULT_PROFILE, configDir: path.join(os.homedir(), '.claude'), builtin: true };
  }

  list(): Profile[] {
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && d.name !== DEFAULT_PROFILE)
        .map((d) => d.name)
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    return [this.builtin(), ...names.map((n) => this.custom(n))];
  }

  get(name: string): Profile | undefined {
    return this.list().find((p) => p.name === name);
  }

  validateName(name: string): string | undefined {
    if (!NAME_RE.test(name)) {
      return 'Chỉ dùng a-z, 0-9, "-" hoặc "_" (tối đa 32 ký tự, bắt đầu bằng chữ/số).';
    }
    if (name === DEFAULT_PROFILE) {
      return `"${DEFAULT_PROFILE}" là tên dành riêng cho ~/.claude.`;
    }
    if (fs.existsSync(path.join(this.root, name))) {
      return 'Profile này đã tồn tại.';
    }
    return undefined;
  }

  create(name: string, sharedItems: string[]): Profile {
    const error = this.validateName(name);
    if (error) {
      throw new Error(error);
    }
    // 0o700: chỉ user hiện tại đọc được, umask không làm giảm quyền này.
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const profile = this.custom(name);
    fs.mkdirSync(profile.configDir, { mode: 0o700 });

    const source = this.builtin().configDir;
    for (const item of sharedItems) {
      if (path.basename(item) !== item) {
        continue; // chỉ nhận tên mục, không nhận đường dẫn
      }
      const target = path.join(source, item);
      if (fs.existsSync(target)) {
        fs.symlinkSync(target, path.join(profile.configDir, item));
      }
    }
    return profile;
  }

  remove(profile: Profile): void {
    // Chỉ xoá đúng một thư mục con trực tiếp của root, tránh xoá nhầm ~/.claude hay nơi khác.
    if (profile.builtin || path.dirname(profile.configDir) !== this.root) {
      throw new Error(`Không thể xoá profile "${profile.name}".`);
    }
    // rmSync không đi theo symlink nên các mục dùng chung trong ~/.claude vẫn an toàn.
    fs.rmSync(profile.configDir, { recursive: true, force: true });
  }

  accountInfo(profile: Profile): AccountInfo {
    const file = profile.builtin
      ? path.join(os.homedir(), '.claude.json')
      : path.join(profile.configDir, '.claude.json');
    try {
      const account = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount;
      return {
        email: typeof account?.emailAddress === 'string' ? account.emailAddress : undefined,
        organization: typeof account?.organizationName === 'string' ? account.organizationName : undefined,
      };
    } catch {
      return {};
    }
  }

  private custom(name: string): Profile {
    return { name, configDir: path.join(this.root, name), builtin: false };
  }
}

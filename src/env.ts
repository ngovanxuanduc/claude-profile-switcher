import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Profile } from './profiles';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const VAR = 'CLAUDE_CONFIG_DIR';

/**
 * Áp profile cho cửa sổ hiện tại.
 *
 * - Panel Claude Code: extension của Anthropic khởi chạy CLI với `{...process.env}` của
 *   extension host. Mỗi cửa sổ VS Code có extension host riêng, nên đổi process.env ở đây
 *   chỉ ảnh hưởng cửa sổ này.
 * - Terminal tích hợp: không kế thừa env của extension host, nên dùng
 *   environmentVariableCollection.
 */
export function applyToWindow(profile: Profile, terminalEnv: vscode.EnvironmentVariableCollection): void {
  terminalEnv.clear();
  if (profile.builtin) {
    delete process.env[VAR];
  } else {
    process.env[VAR] = profile.configDir;
    terminalEnv.replace(VAR, profile.configDir);
  }
  terminalEnv.description = `Claude account: ${profile.name}`;
}

/** Env cho tiến trình con chạy dưới một profile cụ thể. */
export function envFor(profile: Profile): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (profile.builtin) {
    delete env[VAR];
  } else {
    env[VAR] = profile.configDir;
  }
  return env;
}

/** Lệnh shell (zsh/bash) chạy claude dưới một profile, bất kể env của terminal. */
export function shellCommandFor(profile: Profile, args: string[]): string {
  const prefix = profile.builtin ? `env -u ${VAR}` : `${VAR}=${shellQuote(profile.configDir)}`;
  return [prefix, shellQuote(claudeBinary()), ...args.map(shellQuote)].join(' ');
}

/** Ưu tiên binary đi kèm extension Claude Code, sau đó mới đến `claude` trong PATH. */
export function claudeBinary(): string {
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (ext) {
    const candidates = [
      path.join(ext.extensionPath, 'resources', 'native-binaries', `${process.platform}-${process.arch}`, 'claude'),
      path.join(ext.extensionPath, 'resources', 'native-binary', 'claude'),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (found) {
      return found;
    }
  }
  return 'claude';
}

/**
 * Mở (resume) một conversation trong panel Claude Code. Dùng chung command với URI
 * `vscode://anthropic.claude-code/open?session=<id>` của extension Claude Code.
 */
export async function openClaudeSession(sessionId: string): Promise<void> {
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!ext) {
    throw new Error('Chưa cài extension Claude Code.');
  }
  await ext.activate();
  await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
}

export function isClaudeExtensionActive(): boolean {
  return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.isActive ?? false;
}

/** true nếu user setting của extension Claude Code đang tự đặt CLAUDE_CONFIG_DIR (sẽ ghi đè profile). */
export function claudeSettingOverridesConfigDir(): boolean {
  const vars = vscode.workspace.getConfiguration('claudeCode').get<unknown>('environmentVariables');
  if (Array.isArray(vars)) {
    return vars.some((v) => v?.name === VAR);
  }
  return typeof vars === 'object' && vars !== null && VAR in vars;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

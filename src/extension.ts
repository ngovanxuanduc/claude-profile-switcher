import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  applyToWindow,
  claudeBinary,
  claudeSettingOverridesConfigDir,
  envFor,
  isClaudeExtensionActive,
  shellCommandFor,
} from './env';
import { DEFAULT_PROFILE, Profile, ProfileStore } from './profiles';

const execFileAsync = promisify(execFile);

/** globalState: map "workspace key" -> tên profile. */
const WORKSPACE_MAP_KEY = 'workspaceProfiles';
/** globalState: profile dùng cho workspace chưa gán và cửa sổ trống. */
const DEFAULT_KEY = 'defaultProfile';

type WorkspaceMap = Record<string, string>;

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration('claudeProfiles');
  const store = new ProfileStore(() => config().get<string>('root', '~/.claude-profiles'));
  const log = vscode.window.createOutputChannel('Claude Profiles', { log: true });
  const status = vscode.window.createStatusBarItem('claudeProfiles.status', vscode.StatusBarAlignment.Left, 100);
  status.name = 'Claude Profile';
  status.command = 'claudeProfiles.switch';
  context.subscriptions.push(log, status);

  let active: Profile = store.builtin();

  const workspaceMap = () => context.globalState.get<WorkspaceMap>(WORKSPACE_MAP_KEY, {});
  const defaultName = () => context.globalState.get<string>(DEFAULT_KEY, DEFAULT_PROFILE);

  function resolveActive(): Profile {
    const key = workspaceKey();
    const name = (key && workspaceMap()[key]) || defaultName();
    const profile = store.get(name);
    if (!profile) {
      log.warn(`Profile "${name}" không còn tồn tại, dùng "${DEFAULT_PROFILE}".`);
      return store.builtin();
    }
    return profile;
  }

  function refresh(): void {
    active = resolveActive();
    applyToWindow(active, context.environmentVariableCollection);
    log.info(`Cửa sổ này dùng profile "${active.name}" (${active.builtin ? '~/.claude' : active.configDir})`);
    render();
  }

  function render(): void {
    const info = store.accountInfo(active);
    const mapped = isMappedHere(active.name);
    status.text = `$(account) ${active.name}`;
    status.backgroundColor = info.email ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Claude account:** ${info.email ?? '_chưa đăng nhập_'}\n\n`);
    if (info.organization) {
      md.appendMarkdown(`**Tổ chức:** ${info.organization}\n\n`);
    }
    md.appendMarkdown(`**Profile:** \`${active.name}\` ${mapped ? '(gán cho workspace này)' : '(mặc định)'}\n\n`);
    md.appendMarkdown(`**Thư mục:** \`${active.configDir}\`\n\n`);
    md.appendMarkdown('_Bấm để chuyển account._');
    status.tooltip = md;
    status.show();
  }

  function isMappedHere(name: string): boolean {
    const key = workspaceKey();
    return !!key && workspaceMap()[key] === name;
  }

  async function setWorkspaceProfile(name: string): Promise<void> {
    const key = workspaceKey();
    if (!key) {
      await context.globalState.update(DEFAULT_KEY, name);
      return;
    }
    await context.globalState.update(WORKSPACE_MAP_KEY, { ...workspaceMap(), [key]: name });
  }

  async function pickProfile(placeholder: string, opts: { allowCreate?: boolean; excludeBuiltin?: boolean } = {}) {
    type Item = vscode.QuickPickItem & { profile?: Profile; create?: boolean };
    const items: Item[] = store
      .list()
      .filter((p) => !(opts.excludeBuiltin && p.builtin))
      .map((p) => {
        const info = store.accountInfo(p);
        return {
          label: `${p.name === active.name ? '$(check)' : '$(account)'} ${p.name}`,
          description: info.email ?? 'chưa đăng nhập',
          detail: p.builtin ? '~/.claude (mặc định của Claude Code)' : p.configDir,
          profile: p,
        };
      });
    if (opts.allowCreate) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(add) Tạo profile mới…', create: true });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
    if (picked?.create) {
      return createProfile();
    }
    return picked?.profile;
  }

  async function createProfile(): Promise<Profile | undefined> {
    const name = await vscode.window.showInputBox({
      title: 'Tạo Claude profile',
      prompt: `Thư mục sẽ được tạo trong ${store.root}`,
      placeHolder: 'vd: work, client-a',
      validateInput: (v) => store.validateName(v.trim()),
    });
    if (!name) {
      return undefined;
    }
    const profile = store.create(name.trim(), config().get<string[]>('sharedItems', []));
    log.info(`Đã tạo profile "${profile.name}" tại ${profile.configDir}`);
    return profile;
  }

  function login(profile: Profile): void {
    const terminal = vscode.window.createTerminal({ name: `Claude login: ${profile.name}`, isTransient: true });
    terminal.show();
    terminal.sendText(shellCommandFor(profile, ['auth', 'login', '--claudeai']));
    void vscode.window
      .showInformationMessage(
        `Đăng nhập account cho profile "${profile.name}" trong trình duyệt. ` +
          'Nếu trình duyệt đang đăng nhập claude.ai bằng account khác, hãy đăng xuất trên web trước. ' +
          'Xong thì bấm Reload Window.',
        'Reload Window',
      )
      .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
  }

  async function promptReload(message: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
    if (choice) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async function afterSwitch(profile: Profile): Promise<void> {
    if (!store.accountInfo(profile).email) {
      const choice = await vscode.window.showInformationMessage(
        `Profile "${profile.name}" chưa đăng nhập. Đăng nhập ngay?`,
        'Đăng nhập',
        'Reload Window',
      );
      if (choice === 'Đăng nhập') {
        login(profile);
      } else if (choice === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }
    await promptReload(
      `Cửa sổ này đã chuyển sang "${profile.name}". Reload Window để panel Claude Code dùng account mới ` +
        '(các phiên đang mở vẫn chạy account cũ).',
    );
  }

  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      void vscode.window.showErrorMessage(`Claude Profiles: ${msg}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeProfiles.switch',
      run(async () => {
        const target = workspaceKey() ? 'workspace này' : 'cửa sổ trống (account mặc định)';
        const profile = await pickProfile(`Chọn Claude account cho ${target}`, { allowCreate: true });
        if (!profile) {
          return;
        }
        const before = active.name;
        await setWorkspaceProfile(profile.name);
        refresh();
        if (active.name !== before) {
          await afterSwitch(active);
        } else {
          void vscode.window.showInformationMessage(`Đã gán "${profile.name}" cho ${target}.`);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.setDefault',
      run(async () => {
        const profile = await pickProfile(`Account mặc định cho workspace chưa gán (hiện tại: ${defaultName()})`);
        if (!profile) {
          return;
        }
        await context.globalState.update(DEFAULT_KEY, profile.name);
        const before = active.name;
        refresh();
        if (active.name !== before) {
          await afterSwitch(active);
        } else {
          void vscode.window.showInformationMessage(`Account mặc định: "${profile.name}".`);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.create',
      run(async () => {
        const profile = await createProfile();
        if (!profile) {
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `Đã tạo profile "${profile.name}".`,
          'Dùng cho workspace này & đăng nhập',
          'Chỉ đăng nhập',
        );
        if (choice === 'Dùng cho workspace này & đăng nhập') {
          await setWorkspaceProfile(profile.name);
          refresh();
        }
        if (choice) {
          login(profile);
        }
        render();
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.login',
      run(async () => {
        const profile = await pickProfile('Đăng nhập account cho profile nào?');
        if (profile) {
          login(profile);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.remove',
      run(async () => {
        const profile = await pickProfile('Xoá profile nào?', { excludeBuiltin: true });
        if (!profile) {
          return;
        }
        const info = store.accountInfo(profile);
        const confirm = await vscode.window.showWarningMessage(
          `Xoá profile "${profile.name}"?`,
          {
            modal: true,
            detail:
              `Account: ${info.email ?? 'chưa đăng nhập'}\n` +
              `Sẽ đăng xuất (xoá token trong Keychain) rồi xoá thư mục:\n${profile.configDir}\n\n` +
              'Lịch sử chat và cấu hình của profile này sẽ mất. Không thể hoàn tác.',
          },
          'Xoá',
        );
        if (confirm !== 'Xoá') {
          return;
        }
        try {
          await execFileAsync(claudeBinary(), ['auth', 'logout'], { env: envFor(profile), timeout: 30_000 });
          log.info(`Đã đăng xuất profile "${profile.name}".`);
        } catch (err) {
          log.warn(`Đăng xuất "${profile.name}" thất bại (có thể chưa đăng nhập): ${err}`);
        }
        store.remove(profile);

        const map = workspaceMap();
        for (const key of Object.keys(map)) {
          if (map[key] === profile.name) {
            delete map[key];
          }
        }
        await context.globalState.update(WORKSPACE_MAP_KEY, map);
        if (defaultName() === profile.name) {
          await context.globalState.update(DEFAULT_KEY, DEFAULT_PROFILE);
        }

        const wasActive = active.name === profile.name;
        refresh();
        if (wasActive) {
          await promptReload(`Đã xoá "${profile.name}". Cửa sổ này chuyển về "${active.name}".`);
        } else {
          void vscode.window.showInformationMessage(`Đã xoá profile "${profile.name}".`);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.openFolder',
      run(async () => {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(active.configDir));
      }),
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeProfiles.root')) {
        refresh();
      }
    }),

    // Cập nhật email trên status bar sau khi đăng nhập/đăng xuất.
    vscode.window.onDidChangeWindowState((s) => s.focused && render()),
  );

  refresh();

  if (isClaudeExtensionActive()) {
    log.warn('Extension Claude Code đã kích hoạt trước extension này; nếu sai account, hãy Reload Window.');
  }
  if (claudeSettingOverridesConfigDir()) {
    void vscode.window
      .showWarningMessage(
        'Setting "claudeCode.environmentVariables" đang đặt CLAUDE_CONFIG_DIR và sẽ ghi đè profile. Hãy xoá biến này khỏi setting.',
        'Mở Settings',
      )
      .then(
        (c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCode.environmentVariables'),
      );
  }
}

export function deactivate(): void {}

/** Khoá định danh workspace: file .code-workspace, hoặc thư mục đầu tiên. */
function workspaceKey(): string | undefined {
  return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString();
}

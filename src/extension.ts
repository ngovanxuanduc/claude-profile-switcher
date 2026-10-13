import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  applyToWindow,
  claudeBinary,
  claudeSettingOverridesConfigDir,
  envFor,
  isClaudeExtensionActive,
  openClaudeSession,
  shellCommandFor,
} from './env';
import { DEFAULT_PROFILE, Profile, ProfileStore } from './profiles';
import { copySession, listSessions, Session, sessionMtime } from './sessions';

const execFileAsync = promisify(execFile);

/** globalState: map "workspace key" -> tên profile. */
const WORKSPACE_MAP_KEY = 'workspaceProfiles';
/** globalState: profile dùng cho workspace chưa gán và cửa sổ trống. */
const DEFAULT_KEY = 'defaultProfile';

/** globalState: map "workspace key" -> account đang mượn tạm (ưu tiên hơn WORKSPACE_MAP_KEY). */
const BORROW_KEY = 'borrowedProfiles';
/** globalState: conversation cần mở lại sau khi Reload Window. */
const PENDING_OPEN_KEY = 'pendingOpenSession';
/** Bỏ qua yêu cầu mở lại nếu cửa sổ không reload trong khoảng này. */
const PENDING_OPEN_TTL = 5 * 60_000;

type WorkspaceMap = Record<string, string>;

interface Borrow {
  /** Account gốc của workspace, sẽ quay về khi trả. */
  home: string;
  borrowed: string;
  session: Session;
  since: number;
}
type BorrowMap = Record<string, Borrow>;

interface PendingOpen {
  key: string;
  session: Session;
  /** Copy lại nếu bản ở `from` được ghi thêm sau lần copy trước reload. */
  from: string;
  to: string;
  at: number;
}

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
  const borrowMap = () => context.globalState.get<BorrowMap>(BORROW_KEY, {});

  function currentBorrow(): Borrow | undefined {
    const key = workspaceKey();
    return key ? borrowMap()[key] : undefined;
  }

  async function setBorrow(borrow: Borrow | undefined): Promise<void> {
    const key = workspaceKey();
    if (!key) {
      return;
    }
    const map = { ...borrowMap() };
    if (borrow) {
      map[key] = borrow;
    } else {
      delete map[key];
    }
    await context.globalState.update(BORROW_KEY, map);
  }

  function resolveActive(): Profile {
    const key = workspaceKey();
    const name = currentBorrow()?.borrowed ?? ((key && workspaceMap()[key]) || defaultName());
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
    const borrow = currentBorrow();
    status.text = borrow ? `$(arrow-swap) ${active.name} (mượn)` : `$(account) ${active.name}`;
    status.command = borrow ? 'claudeProfiles.returnHome' : 'claudeProfiles.switch';
    status.backgroundColor = !info.email
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : borrow
        ? new vscode.ThemeColor('statusBarItem.prominentBackground')
        : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Claude account:** ${info.email ?? '_chưa đăng nhập_'}\n\n`);
    if (info.organization) {
      md.appendMarkdown(`**Tổ chức:** ${info.organization}\n\n`);
    }
    if (borrow) {
      md.appendMarkdown(`**Profile:** \`${active.name}\` (mượn tạm, account gốc: \`${borrow.home}\`)\n\n`);
    } else {
      md.appendMarkdown(`**Profile:** \`${active.name}\` ${mapped ? '(gán cho workspace này)' : '(mặc định)'}\n\n`);
    }
    md.appendMarkdown(`**Thư mục:** \`${active.configDir}\`\n\n`);
    md.appendMarkdown(borrow ? `_Bấm để trả về \`${borrow.home}\`._` : '_Bấm để chuyển account._');
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

  async function pickProfile(
    placeholder: string,
    opts: { allowCreate?: boolean; excludeBuiltin?: boolean; exclude?: string } = {},
  ) {
    type Item = vscode.QuickPickItem & { profile?: Profile; create?: boolean };
    const items: Item[] = store
      .list()
      .filter((p) => !(opts.excludeBuiltin && p.builtin) && p.name !== opts.exclude)
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

  function sessionItem(s: Session): vscode.QuickPickItem & { session: Session } {
    return {
      label: s.title ?? s.id,
      description: relativeTime(s.mtime),
      detail: workspaceCwds().length > 1 ? s.cwd : undefined,
      session: s,
    };
  }

  /** Ghi lại conversation cần mở, rồi Reload Window. Sau reload, openPending() mở lại nó. */
  async function reloadAndOpen(session: Session, from: Profile, to: Profile): Promise<void> {
    const pending: PendingOpen = {
      key: workspaceKey()!,
      session,
      from: from.name,
      to: to.name,
      at: Date.now(),
    };
    await context.globalState.update(PENDING_OPEN_KEY, pending);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * Chạy đồng bộ lúc kích hoạt, trước khi panel Claude Code kịp khởi chạy CLI: CLI cũ có thể đã ghi
   * thêm vào conversation sau lần copy trước reload, nên copy lại nếu bản nguồn mới hơn.
   */
  function takePending(): PendingOpen | undefined {
    const pending = context.globalState.get<PendingOpen>(PENDING_OPEN_KEY);
    // globalState dùng chung mọi cửa sổ: chỉ nhận yêu cầu của đúng workspace này.
    if (!pending || pending.key !== workspaceKey()) {
      return undefined;
    }
    void context.globalState.update(PENDING_OPEN_KEY, undefined);
    if (Date.now() - pending.at > PENDING_OPEN_TTL) {
      return undefined;
    }
    const from = store.get(pending.from);
    const to = store.get(pending.to);
    if (from && to) {
      const src = sessionMtime(from, pending.session) ?? 0;
      const dest = sessionMtime(to, pending.session) ?? 0;
      if (src > dest) {
        try {
          copySession(from, to, pending.session);
          log.info(`Đã copy lại conversation ${pending.session.id} (bản ở "${from.name}" mới hơn).`);
        } catch (err) {
          log.warn(`Copy lại conversation thất bại: ${err}`);
        }
      }
    }
    return pending;
  }

  async function openPending(pending: PendingOpen): Promise<void> {
    const label = pending.session.title ?? pending.session.id;
    try {
      await openClaudeSession(pending.session.id);
      log.info(`Đã mở lại conversation ${pending.session.id} bằng account "${active.name}".`);
    } catch (err) {
      log.warn(`Không tự mở được conversation: ${err}`);
      void vscode.window.showInformationMessage(
        `Mở panel Claude Code, gõ /resume và chọn "${label}" để tiếp tục bằng account "${active.name}".`,
      );
    }
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
        if (currentBorrow()) {
          // Gán account mới cho workspace thì thôi mượn; conversation không được copy về.
          log.info(`Bỏ trạng thái mượn "${currentBorrow()!.borrowed}" của workspace này.`);
          await setBorrow(undefined);
        }
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
        const borrows = { ...borrowMap() };
        for (const key of Object.keys(borrows)) {
          if (borrows[key].home === profile.name || borrows[key].borrowed === profile.name) {
            delete borrows[key];
          }
        }
        await context.globalState.update(BORROW_KEY, borrows);

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
      'claudeProfiles.borrow',
      run(async () => {
        if (!workspaceKey() || workspaceCwds().length === 0) {
          throw new Error('Cần mở một thư mục hoặc workspace thì mới mượn account được.');
        }
        const sessions = listSessions(active, workspaceCwds());
        if (sessions.length === 0) {
          throw new Error(`Account "${active.name}" chưa có conversation nào trong workspace này.`);
        }
        const picked = await vscode.window.showQuickPick(sessions.map(sessionItem), {
          title: 'Mượn tạm account khác (1/2)',
          placeHolder: 'Conversation nào cần chat tiếp bằng account khác?',
          matchOnDescription: true,
        });
        if (!picked) {
          return;
        }
        const borrow = currentBorrow();
        const home = borrow?.home ?? active.name;
        const target = await pickProfile(`Mượn account nào để chat tiếp? (account gốc: ${home})`, {
          exclude: active.name,
        });
        if (!target) {
          return;
        }
        if (!store.accountInfo(target).email) {
          const choice = await vscode.window.showWarningMessage(
            `Profile "${target.name}" chưa đăng nhập. Đăng nhập xong thì chạy lại lệnh này.`,
            'Đăng nhập',
          );
          if (choice) {
            login(target);
          }
          return;
        }
        const confirm = await vscode.window.showInformationMessage(
          `Chat tiếp "${picked.label}" bằng account "${target.name}"?`,
          {
            modal: true,
            detail:
              `Conversation sẽ được copy sang profile "${target.name}" và cửa sổ sẽ Reload. ` +
              `Bản ở "${active.name}" vẫn được giữ nguyên.\n\n` +
              `Khi account gốc "${home}" dùng lại được, bấm status bar (hoặc lệnh "Trả về account gốc") ` +
              'để mang conversation về.\n\n' +
              'Lưu ý: account mới không có prompt cache, lượt chat đầu sẽ tốn token đọc lại toàn bộ context. ' +
              'Conversation dài thì nên /compact trước.',
          },
          'Chuyển & Reload',
        );
        if (!confirm) {
          return;
        }
        copySession(active, target, picked.session);
        log.info(`Đã copy conversation ${picked.session.id} từ "${active.name}" sang "${target.name}".`);
        // Mượn đúng account gốc thì coi như đã trả.
        await setBorrow(
          target.name === home
            ? undefined
            : { home, borrowed: target.name, session: picked.session, since: Date.now() },
        );
        await reloadAndOpen(picked.session, active, target);
      }),
    ),

    vscode.commands.registerCommand(
      'claudeProfiles.returnHome',
      run(async () => {
        const borrow = currentBorrow();
        if (!borrow) {
          void vscode.window.showInformationMessage('Workspace này không mượn account nào.');
          return;
        }
        const home = store.get(borrow.home);
        if (!home) {
          await setBorrow(undefined);
          refresh();
          throw new Error(`Account gốc "${borrow.home}" không còn tồn tại; đã bỏ trạng thái mượn.`);
        }
        // Conversation được mượn, cùng các conversation mới tạo/được chat thêm trong lúc mượn.
        const candidates = listSessions(active, workspaceCwds()).filter(
          (s) => s.id === borrow.session.id || s.mtime >= borrow.since,
        );
        let toCopy: Session[] = [];
        if (candidates.length > 0) {
          const picked = await vscode.window.showQuickPick(
            candidates.map((s) => ({ ...sessionItem(s), picked: true })),
            {
              title: `Trả về account gốc "${home.name}"`,
              placeHolder: 'Chọn conversation mang về (bỏ chọn hết nếu không cần mang về)',
              canPickMany: true,
            },
          );
          if (!picked) {
            return;
          }
          toCopy = picked.map((p) => p.session);
        }
        for (const s of toCopy) {
          // Account gốc cũng được chat thêm (ở cửa sổ khác) sau khi mượn: hỏi trước khi ghi đè.
          const homeMtime = sessionMtime(home, s);
          if (homeMtime !== undefined && homeMtime > borrow.since) {
            const choice = await vscode.window.showWarningMessage(
              `"${s.title ?? s.id}" ở account gốc "${home.name}" cũng đã thay đổi sau khi mượn.`,
              { modal: true, detail: 'Ghi đè thì phần chat thêm ở account gốc sẽ mất.' },
              'Ghi đè',
              'Bỏ qua',
            );
            if (choice === undefined) {
              return;
            }
            if (choice === 'Bỏ qua') {
              continue;
            }
          }
          copySession(active, home, s);
          log.info(`Đã copy conversation ${s.id} từ "${active.name}" về "${home.name}".`);
        }
        const from = active;
        await setBorrow(undefined);
        const reopen = toCopy.find((s) => s.id === borrow.session.id) ?? toCopy[0];
        if (reopen) {
          await reloadAndOpen(reopen, from, home);
        } else {
          refresh();
          await promptReload(`Đã trả về account gốc "${home.name}". Reload Window để panel Claude Code dùng lại account này.`);
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

  const pending = takePending();
  refresh();
  if (pending) {
    void openPending(pending);
  }

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

/** Các thư mục Claude Code có thể dùng làm cwd của session trong cửa sổ này. */
function workspaceCwds(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function relativeTime(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) {
    return 'vừa xong';
  }
  if (min < 60) {
    return `${min} phút trước`;
  }
  const hours = Math.round(min / 60);
  return hours < 24 ? `${hours} giờ trước` : `${Math.round(hours / 24)} ngày trước`;
}

/** Khoá định danh workspace: file .code-workspace, hoặc thư mục đầu tiên. */
function workspaceKey(): string | undefined {
  return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString();
}

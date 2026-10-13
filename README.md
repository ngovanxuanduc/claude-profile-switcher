# Claude Profile Switcher

Extension VS Code để chuyển qua lại nhiều account Claude Code (gói Pro/Max, đăng nhập OAuth) trên macOS.
Extension làm việc cùng extension **Claude Code for VS Code** của Anthropic.

- Mỗi **workspace** (hoặc cửa sổ) được gán một account. Mở repo nào thì tự dùng account đã gán cho repo đó.
- Nhiều cửa sổ có thể chạy **nhiều account song song**.
- Status bar luôn hiện account đang dùng. Ô status bar có nền vàng nghĩa là profile chưa đăng nhập.

## Cách hoạt động

| Thành phần | Cơ chế |
|---|---|
| Profile | Mỗi profile là một thư mục `~/.claude-profiles/<tên>` (quyền `700`), dùng làm `CLAUDE_CONFIG_DIR`. Profile `default` là `~/.claude` gốc. |
| Panel Claude Code | Extension Claude Code chạy CLI với `process.env` của extension host. Mỗi cửa sổ VS Code có extension host riêng. Extension này kích hoạt sớm (`*`) và đặt `CLAUDE_CONFIG_DIR` cho đúng cửa sổ đó. |
| Terminal tích hợp | Biến được đặt qua `environmentVariableCollection`, nên gõ `claude` trong terminal cũng dùng đúng account. |
| Credentials | Do Claude CLI tự lưu trong **macOS Keychain**, mỗi thư mục cấu hình một mục riêng (`Claude Code-credentials-<hash>`). Extension này **không bao giờ đọc hay lưu token**, chỉ đọc email và tên tổ chức trong `.claude.json` để hiển thị. |
| Gán workspace với profile | Lưu trong `globalState` của VS Code, không ghi vào `.vscode/settings.json` của repo. |

## Cài đặt

Yêu cầu: macOS, VS Code 1.94 trở lên, Node 18 trở lên, đã cài extension Claude Code for VS Code.

```bash
./build.sh --install     # nâng version (0.1.0 -> 0.1.1), build .vsix và cài vào VS Code
```

Sau đó Reload Window.

### Build bản mới

Script `build.sh` tự chạy `npm install` (nếu chưa có `node_modules`), nâng version trong `package.json`, compile rồi đóng gói thành `claude-profile-switcher-<version>.vsix`. Script không tạo commit hay tag.

| Lệnh | Tác dụng |
|---|---|
| `./build.sh` | Nâng patch (vd `0.1.0` → `0.1.1`) rồi build. |
| `./build.sh minor` / `./build.sh major` | Nâng minor (`0.2.0`) / major (`1.0.0`). |
| `./build.sh 0.3.0` | Đặt version cụ thể. |
| `./build.sh --no-bump` | Giữ nguyên version, chỉ build lại. |
| Thêm `--install` | Cài luôn file `.vsix` vừa build vào VS Code. |

Làm tay không dùng script:

```bash
npm version 0.1.1 --no-git-tag-version   # đổi version, không tạo commit/tag
npm run compile
npm run package                          # tạo claude-profile-switcher-0.1.1.vsix
code --install-extension claude-profile-switcher-0.1.1.vsix
```

Sau khi cài, chạy **Reload Window**.

## Chạy thử khi phát triển

1. Mở thư mục này trong VS Code.
2. Nhấn **F5**. Một cửa sổ **Extension Development Host** sẽ mở ra, extension Claude Code cũng được nạp trong cửa sổ đó.
3. Trong cửa sổ mới, mở một thư mục bất kỳ rồi làm theo phần "Sử dụng".

## Sử dụng

Mở Command Palette (`Cmd+Shift+P`), gõ `Claude Profiles`:

| Lệnh | Tác dụng |
|---|---|
| Chuyển account cho workspace này | Chọn profile cho workspace đang mở (có mục "Tạo profile mới…"). Có thể bấm vào status bar thay cho lệnh này. |
| Đặt account mặc định | Account dùng cho workspace chưa gán và cửa sổ trống. |
| Tạo profile mới | Tạo thư mục, symlink các mục dùng chung, rồi đăng nhập. |
| Đăng nhập account cho profile | Mở terminal và chạy `claude auth login --claudeai` với đúng `CLAUDE_CONFIG_DIR`. |
| Xoá profile | Chạy `claude auth logout` (xoá token khỏi Keychain), sau đó xoá thư mục. Luôn hỏi xác nhận trước. |
| Mượn tạm account khác (giữ conversation) | Chọn một conversation và một account khác. Conversation được copy sang account đó, cửa sổ reload rồi tự mở lại đúng conversation để chat tiếp. |
| Trả về account gốc (mang conversation về) | Copy các conversation đã chat trong lúc mượn về account gốc, reload rồi mở lại. Khi đang mượn, bấm status bar cũng chạy lệnh này. |
| Mở thư mục profile hiện tại | Mở thư mục trong Finder. |

Quy trình lần đầu:

1. Bấm status bar, chọn **Tạo profile mới…** và đặt tên, ví dụ `work`.
2. Chọn **Đăng nhập**. Trình duyệt mở ra, đăng nhập **đúng account** cần dùng. Nếu claude.ai trên web đang đăng nhập account khác thì đăng xuất trên web trước.
3. Chọn **Reload Window**, mở panel Claude Code và gõ `/status` để kiểm tra email.

Sau khi đổi account phải **Reload Window**: các phiên Claude đang mở vẫn chạy account cũ.

## Mượn tạm account khác

Dùng khi account A hết quota giữa chừng mà muốn chat tiếp **đúng conversation đó** bằng account B:

1. Chạy **Mượn tạm account khác**, chọn conversation, rồi chọn account B (đã đăng nhập).
2. Cửa sổ reload và mở lại conversation bằng account B. Status bar hiện `⇄ B (mượn)`.
3. Khi A dùng lại được, bấm status bar (hoặc chạy **Trả về account gốc**), chọn conversation cần mang về. Cửa sổ reload và quay về A, chat tiếp từ chỗ đã dừng ở B.

Cách hoạt động: conversation là file `projects/<cwd>/<session-id>.jsonl` trong thư mục profile, kèm checkpoint trong `file-history/<session-id>/`. Extension chỉ **copy** các file này giữa hai profile; bản ở account nguồn vẫn được giữ, token không bị đụng tới. Nếu conversation ở account gốc cũng bị chat thêm (ở cửa sổ khác) trong lúc mượn, extension sẽ hỏi trước khi ghi đè.

Lưu ý:
- Account mới không có prompt cache của account cũ, nên lượt chat đầu tiên sẽ tính token cho toàn bộ context. Conversation dài thì nên `/compact` trước khi mượn.
- Trạng thái mượn gắn với workspace. Dùng **Chuyển account cho workspace này** trong lúc mượn sẽ bỏ trạng thái mượn và không copy conversation về.

## Cấu hình

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `claudeProfiles.root` | `~/.claude-profiles` | Nơi chứa các profile. |
| `claudeProfiles.sharedItems` | `CLAUDE.md, commands, agents, skills` | Các mục trong `~/.claude` được symlink vào profile mới, để các account dùng chung chỉ dẫn và lệnh. Đặt `[]` nếu muốn tách hẳn. |

## Lưu ý

- **Không** đặt `CLAUDE_CONFIG_DIR` trong `claudeCode.environmentVariables`, vì nó sẽ ghi đè profile. Extension sẽ cảnh báo nếu phát hiện.
- Terminal ngoài VS Code (iTerm, Terminal.app) không được áp profile. Nếu cần thì dùng alias, ví dụ:
  `alias claude-work='CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/work claude'`.
- Khoá định danh workspace là file `.code-workspace`, hoặc thư mục gốc đầu tiên nếu không có file workspace. Đổi tên hoặc chuyển thư mục đi chỗ khác thì phải gán lại.
- Extension dựa vào cách extension Claude Code khởi chạy CLI (đã kiểm tra với bản 2.1.296). Nếu Anthropic thay đổi cách này, lệnh `/status` sẽ cho bạn biết ngay account có bị sai không.

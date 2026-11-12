<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-session-sync</h1>
  <p><b>Brings your Claude Code and MiniMax Code conversations into DeepSeek Harness — in the right workspace.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-session-sync/releases"><img alt="release" src="https://img.shields.io/github/v/release/borncode-app/dsh-session-sync?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="sources" src="https://img.shields.io/badge/reads-Claude%20Code%20%2B%20MiniMax%20Code-8957e5?style=flat-square">
  </p>
</div>

---

## What it does

You have conversations in **Claude Code** (`~/.claude/projects/**/*.jsonl`) and in **MiniMax Code**
(`~/.minimax/v2/sqlite/runtime-state.sqlite` plus its dated session directory). The Harness knows nothing about
them, so the work you did there is invisible here.

This plugin imports those conversations as ordinary **persisted DSH sessions**, filed under the workspace whose
folder matches the session's own working directory — and marks every one of them with the logo of the app it
came from.

The plugin follows one rule: **a workspace is keyed by its folder path**. A session recorded in
`C:\Users\you\Documents\portfolio` is imported into the DSH workspace for exactly that folder; a workspace is
created when the folder does not have one yet. The workspace's existing title is kept.

## What gets imported

| Source | Read from | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` | Main-thread user and assistant text; sidechains, tool traffic, and injected `<system-reminder>` context are skipped. The transcript's `custom-title`/`agent-name` becomes the DSH title; a mid-session `relocated` record wins as the working directory. |
| MiniMax Code | `~/.minimax/v2/sqlite/runtime-state.sqlite` | The display message rows (`user`/`assistant`) of each row in `local_runtime_sessions`; greeting and tool-result rows are skipped. The MiniMax title and `workspace_dir` are preserved. |
| DSH | Existing persisted sessions | Not copied. They are accounted as source `dsh`; a row with no map entry shows the DSH logo. |

Imported sessions are ordinary persisted DSH sessions: they appear in the sidebar, open in the Conversation view,
carry the origin logo, and can be archived or deleted like any other session. A session is never imported twice:
the state file maps every external session to a deterministic DSH session id.

## Flags (the row logo)

Each Session row shows a 14 px logo in its leading cell:

- **orange starburst** — Claude Code
- **violet M** — MiniMax Code
- **blue D** — a DSH session

The logo is drawn as inline SVG, so it matches the interface in every theme and costs one small component per idle
row. The source map is fetched once from the Host status route; a late answer re-renders every mounted row through
one shared store. A row that shows a status dot keeps that dot in the same cell (the cell is reserved for the row's
primary state), so the logo appears on idle rows.

## Control route (Host + one client slot)

The Host answers a JSON route at `/plugins/session-sync`:

- `GET` — counts per origin, the last run, both source paths.
- `POST {"action":"sync"}` — scan and import now.
- `POST {"action":"warm"}` — rebuild the projection cache for imported sessions (the sidebar reads historical
  titles from that cache).
- `POST {"action":"verify","sessionId":"…"}` — replay-validate one imported log.
- `POST {"action":"regroup","dryRun":true}` — plan the MiniMax regroup (below).
- `POST {"action":"regroup"}` — run it.
- `POST {"action":"rename-sandboxes"}` — give the remaining MiniMax sandbox workspaces their conversation's title.

Automatic sync runs 3.5 seconds after startup and then every 15 minutes. It only parses sessions whose external
fingerprint changed, so a quiet run is cheap.

## MiniMax sandboxes and the regroup

MiniMax Code stores each session's working directory as its own sandbox (`~/.minimax/sessions/<id>/workspace`), not
the folder the user was working in. The real folder only appears in the prompt — usually inside `<filepath>…</filepath>`
or as an absolute Windows path.

`regroup` reads the prompt, resolves the first path that is an existing project folder, imports the conversation
**into that folder's workspace**, and archives the sandbox copy. A path that runs into the surrounding sentence
(``C:\FO3TH`, and deliver …``) still resolves, because candidates are shortened from the right until one exists.

Refused as project folders: the home directory, hidden folders directly under it (`~/.ssh`),
`AppData\Local\Temp`, `Windows`, `node_modules`, `.git`, and anything inside another MiniMax sandbox. Only an
explicit `<filepath>` tag may name a hidden folder.

A regroup run moves conversations like this:

| Session | From the sandbox to |
|---|---|
| เลือก GitHub repo ที่เหมาะทำ portfolio | `C:\Users\you\Documents\portfolio` |
| แก้ข้อความบนภาพเป็น กรุงเทพใต้ | `C:\Users\you\Documents\presenton` |
| ย้อนวิศวกรรม C:/FO3TH เป็นแอป Android | `C:\FO3TH` |
| 查找可用 skills | `C:\FO3TH` |

The remaining MiniMax sessions name no folder in their prompt, so they stay in their sandbox workspace — which
`rename-sandboxes` renames to `Mavis · <conversation title>` instead of `mvs_<id> workspace`.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x (Web GUI) |
| Runtime | Node 24, supplied by the Harness runtime |
| Optional | Claude Code (`~/.claude`) and/or MiniMax Code (`~/.minimax`) — import whichever exist |
| Note | MiniMax Code must expose `node:sqlite` (`DatabaseSync`); without it the plugin reports `sqlite-unavailable` instead of failing the run |

## Install

```bash
git clone https://github.com/borncode-app/dsh-session-sync.git dsh-session-sync
```

Then in DSH: **Plugins** → install the bundle from that directory, or:

```
plugin_manager install_bundle target=C:\path\to\dsh-session-sync
```

Restart once. The first import happens a few seconds after startup.

## Configuration

| field | default | meaning |
|---|---|---|
| `endpoint` | `/plugins/session-sync` | Route the Client half reads and posts to |
| `autoSync` | `true` | Scan after startup and on an interval |
| `intervalMinutes` | `15` | Minimum gap between automatic runs |
| `maxTextChars` | `20000` | Per-message character budget; longer bodies are truncated visibly |
| `claudeRoot` | `~/.claude/projects` | Claude Code transcript root |
| `minimaxDatabase` | `~/.minimax/v2/sqlite/runtime-state.sqlite` | MiniMax Code runtime database |

## Files

| file | role |
|---|---|
| `index.js` | Host row: scanning, conversion, persistence, workspace accounting, status route |
| `lib/convert.mjs` | Pure transcript → DSH event conversion and title/id helpers |
| `lib/sources.mjs` | Claude JSONL and MiniMax sqlite readers, project-folder inference |
| `client.js` | The row logo component and its one-shot source-map store |
| `cordis.patch.yml` | Bundle patch |
| `state.json` | Import map and last-run report (written at runtime, not tracked) |
| `scripts/repair-titles.mjs` | Repair tool for the first build's `session/title` source |
| `scripts/reframe-sessions.mjs` | Rebuild the two-frame Zstandard layout of a log |
| `scripts/flag-titles.mjs` | Add the `[Claude Code]` / `[MiniMax Code]` title prefix (superseded by the logo) |
| `scripts/strip-prefixes.mjs` | Remove those prefixes from the logs |
| `scripts/reappend-titles.mjs` | Append a fresh title event so the projection cache picks up a corrected title |
| `locale/{en,th,zh}.json` | Plugin title and description |
| `icon.svg` | Plugin icon |
| `test/convert.test.mjs` | Conversion smoke test (no Harness required) |
| `test/sources.test.mjs` | Project-folder inference tests |

Run the tests with `npm test` (plain `node --test`, no Harness needed).

## Limitations

- The import is a snapshot of the text conversation. Tool calls, tool results, reasoning blocks, and attachments are
  not replayed, so a first run stays fast and the imported log stays readable.
- An external session that receives more messages after it was imported is left at its imported revision; only new
  sessions are added by later runs. Deleting `state.json` and the imported DSH sessions re-imports afresh.
- Imported logs are replay-validated with the persistence reader; the plugin exposes `POST {action:"verify"}` on
  its route for the same check.
- A session whose recorded folder no longer exists is skipped and reported in the last-run issues instead of
  inventing a workspace path.
- MiniMax Code must expose `node:sqlite` (`DatabaseSync`) to the Host; the plugin reports `sqlite-unavailable`
  instead of failing the whole run when it does not.

## ภาษาไทย

Plugin นี้ **ดึงบทสนทนาที่คุณเคยคุยใน Claude Code และ MiniMax Code เข้ามาใน DSH** โดยจัดเก็บเข้า workspace
ที่ตรงกับโฟลเดอร์ที่ session นั้นทำงานอยู่ — และติดป้ายโลโก้กำกับว่ามาจากแอปไหน

| แหล่งที่มา | อ่านจาก |
|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (ข้าม sidechain, tool traffic และ `<system-reminder>`) |
| MiniMax Code | `~/.minimax/v2/sqlite/runtime-state.sqlite` (เอาแถวข้อความ `user`/`assistant` เท่านั้น) |

- session ที่ import แล้วเป็น **session ปกติของ DSH** — เห็นใน sidebar, เปิดอ่านได้, archive/delete ได้ตามปกติ
- import ซ้ำไม่ได้: `state.json` เก็บ map ของ session ภายนอก → id ของ session ใน DSH
- โลโก้ในแถว: ⭐ ส้ม = Claude Code, M ม่วง = MiniMax Code, D น้ำเงิน = DSH
- **regroup** ช่วยกรณี MiniMax เก็บ session ไว้ใน sandbox ของตัวเอง — มันอ่าน prompt หา path ที่เป็นโฟลเดอร์โปรเจกต์จริง
  แล้วย้ายไปเข้า workspace ของโฟลเดอร์นั้น (ปฏิเสธพาธเสี่ยง เช่น home dir, `Windows`, `node_modules`, `.git`)
- sync อัตโนมัติหลังเปิดแอป ~3.5 วินาที แล้วทุก 15 นาที (ข้ามไฟล์ที่ไม่เปลี่ยน)
- **ข้อจำกัด**: import เฉพาะข้อความ ไม่ดึง tool call / tool result / reasoning / ไฟล์แนบ, และ session ที่ถูก import ไปแล้ว
  จะไม่อัปเดตตามที่คุยต่อในแอปต้นทาง (ลบ `state.json` + session ที่ import แล้วเพื่อ import ใหม่)

ติดตั้ง: `git clone` แล้ว `plugin_manager install_bundle target=<path>` ใน DSH รีสตาร์ทหนึ่งครั้ง

## License

[MIT](LICENSE) © 2026 BornCode

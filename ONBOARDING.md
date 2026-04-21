# Welcome to Houzs / Hookka ERP

## How We Use Claude

Based on the last 30 days of usage:

Work Type Breakdown:
  Build Feature  ███████████████░░░░░  75%
  Plan / Design  █████░░░░░░░░░░░░░░░  25%

Top Skills & Commands:
  _none tracked yet — team uses ad-hoc prompts + attached spec docs_

Top MCP Servers:
  Claude Preview    ████████████████████  226 calls
  Claude in Chrome  █████████████████░░░  198 calls
  Cowork Session    ██░░░░░░░░░░░░░░░░░░   18 calls
  Notion            █░░░░░░░░░░░░░░░░░░░    8 calls

## Your Setup Checklist

### Codebases
- [ ] **houzs-erp** — the active ERP app (React + Vite + TypeScript, deployed to Cloudflare Pages at `houzs-erp-4r4.pages.dev`). Main workspace right now — Sales Orders, SO Details, SKU Costing (4 categories), Variant Maintenance.
- [ ] **hookka-erp-vite** — reference/sibling app. The `/products` page here is the visual pattern we copy into houzs-erp. Good to have running on port 3000 while working on houzs-erp (port 3200).
- [ ] **hookka-erp-spec** — spec + scratch workspace (this is the folder you're probably opening Claude Code from).
- [ ] **glove-tracker** — `github.com/weisiang329-eng/glove-tracker`. Separate tracker project.

### MCP Servers to Activate
- [ ] **Claude Preview** — launches the dev server and streams screenshots/console/network back to Claude. Used constantly for iterating on UI (226 calls last month). Configure per repo in `.claude/launch.json` with a `name`, `runtimeExecutable: "npm"`, `runtimeArgs: ["run", "dev"]`, and a `port`.
- [ ] **Claude in Chrome** — drives a real Chrome browser (navigate, click, screenshot, read console). Used for checking deployed URLs and manual flow walkthroughs. Install the Chrome extension and sign in.
- [ ] **Cowork Session (`ccd_session`)** — adds chapter/task markers to your Claude Code session timeline. Ships with the Cowork plugin — no separate setup.
- [ ] **Notion** — read/write Notion pages from Claude (fetching specs, updating docs). Auth via the Notion MCP connector in your Claude settings.

### Skills to Know About
- **`/team-onboarding`** — generates this guide for new teammates (you just ran it).
- **Superpowers skills** — `~/.claude/skills/superpowers-skills/` has skills for brainstorming, executing plans, systematic debugging, TDD, etc. Run `~/.claude/skills/superpowers-skills/skills/using-skills/find-skills` to list them.
- **Anthropic skills** — `docx`, `pdf`, `pptx`, `xlsx`, `canvas-design`, `frontend-design`, `skill-creator`. We use `xlsx` a lot to turn supplier/sales Excel exports into seed data.
- **`/schedule`, `/loop`** — recurring/scheduled tasks if you need automation.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->

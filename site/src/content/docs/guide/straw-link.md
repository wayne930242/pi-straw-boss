---
title: Straw Link
description: "Towers across computers: a team of teammates' computers, end-to-end encrypted through a relay."
---

Straw Link connects the towers of teammates' computers that work on the same project.
A tower writes to the tower of a teammate's computer (`tower_send` with `device`), reads the teammates' work boards, and sees their bases beside its own on the page.
Messages go through a relay ([straw-relay](https://github.com/wayne930242/straw-relay)), signed by the sending device and encrypted with the team's keys.

On each computer the sb server holds the link, so no pi session has to stay open for it.

## A team

1. **Set it up.** On the page, Settings → Teams → **Set up Straw Link**, or `/boss link on` in pi.
2. **Create a team** for a project folder with the relay's origin and its one-time team token: Settings → Teams → Create, or `/boss link create <relay> <dir>`.
3. **Invite** a teammate: the page shows the invite as a QR code and as text, valid for 10 minutes; in pi, `/boss link invite <team>` shows the text on a private screen.
4. **Join** on the teammate's computer: paste the invite (or `/boss link join @file`) and pick the project folder. The page shows four safety words; the inviter picks the matching set among decoys to approve the join.

Admins remove a device, change a role, and rotate the team key; anyone leaves the team. They are on the same Settings → Teams page, and typed in pi each is asked on this computer first:

| Act | In pi |
| --- | --- |
| Change a device's trust | `/boss link trust <device> <level>` |
| Change a role | `/boss link role <team> <device> admin\|member` |
| Remove a device | `/boss link remove <team> <device>` |
| Rotate the team key | `/boss link rotate <team>` |

## Trust

Each computer decides how far it trusts a teammate's messages, per device (`link.trust` in the [configuration](/pi-straw-boss/docs/reference/configuration/), or the page's roster):

| Level | What the turn a teammate's message starts may do here |
| --- | --- |
| `reply` (the default) | Read the project's tracked files, search inside the project, read the tower list and the work board, and answer the sender. Any other tool call opens a confirm on this computer, in the terminal or on the page. |
| `forward` | The same, and the sender's computer may answer that confirm too. |
| `dispatch` | Nothing is held: the tower acts on the request with its full tools. |

At `reply` and `forward`, a call that names a credential path (`~/.ssh`, `~/.aws`, `.env*`, keys) is refused outright, not confirmed.
`link_request` is blocked at every level.

A teammate's message is never the boss's instruction: later local turns see it marked as a peer's request.
`link_request` (create, invite, join, trust, and the rest) is an agent's request for one of these actions; it never runs unasked, and the boss approves it in a dialog.

## Unattended devices

An **unattended device** is a computer nobody sits at (a build box, a server) that takes work from teammates' computers over Straw Link.
It runs the sb server, which holds the link, with no boot pi session, and a controller invites it from the page.
On a box several developers share, a unit's questions and notices go only to the controller that dispatched it and to the team's admins.

A controller can also **operate** a box: its towers, mains, and workers show as bases on the controller's page, with their live terminals, for typing, Escape, and stopping a main, as far as the box's own policy allows.

A box's card names each main by its kind and its tower's runs, in the words of the local page ([Concepts](/pi-straw-boss/docs/guide/concepts/#kinds)); its finished tower runs sit in a closed fold, *Tower runs*.

See [Setting up an unattended device](/pi-straw-boss/docs/guide/unattended-device/).

## In pi

`/boss link` lists this computer's teams, members, and waiting join requests; the other `/boss link` lines answer confirms and forwarded questions, make, show and cancel invites, run the admin acts above, and stop a unit on a box.
See [Commands](/pi-straw-boss/docs/reference/commands/#straw-link).

The rules are in [Straw Link](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#straw-link-towers-across-computers-the-link-holder) and [Straw Link operate](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#straw-link-operate-an-attended-computer-drives-an-unattended-box).

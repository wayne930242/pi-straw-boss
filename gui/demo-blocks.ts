// Demo content for `npm run gui:dev` and the tests: a Markdown document with every block kind of pi-better-show (doc cards), and a chat message with a form, chips, a table, and a tree.
// The fences are written with `~~~` so this file stays readable as a template literal.

const fence = (text: string) => text.replace(/^~~~/gm, "```");

export const DEMO_REVIEW_PICKS = fence(`~~~review
title: Choose the release layout
pickMode: grouped
items:
  - {name: Compact, group: Header}
  - {name: Spacious, group: Header}
  - {name: List, group: Changelog}
  - {name: Timeline, group: Changelog}
~~~

~~~review
title: Which previews should we publish?
pickMode: multi
items:
  - {name: Desktop}
  - {name: Tablet}
  - {name: Phone}
~~~`);

export const DEMO_BLOCKS_DOC = fence(`# Release plan

Every kind of block, as an agent would write it. 這一頁同時有中文與英文內容。

> [!WARNING] Heads up
> This **overwrites** the cache, see [the runbook](https://example.com/runbook).
>
> - back up first
> - then run \`make release\`

> [!TIP]
> 備份完成後再執行，可以隨時回復。

~~~cards
- {title: Speed, tone: ok, body: "**2x** faster than the old path"}
- {title: Risk, tone: warn, body: "Needs a migration window"}
- {title: Cost, tone: risk, body: "Doubles the cache memory"}
- {title: Neutral, body: "No tone, plain card"}
~~~

~~~options
- title: SQLite
  recommended: true
  body: Embedded, zero setup
  pros: [simple, fast]
  cons: [single writer]
- title: Postgres
  body: A server to run
  pros: [concurrent writers]
  cons: [more to operate, needs backups]
~~~

~~~form
title: Decide the store
questions:
  - name: store
    label: Which store?
    required: true
    hint: Pick one
    choices:
      - SQLite
      - {value: pg, label: Postgres, note: heavier, recommended: true}
  - name: extras
    label: Extras
    type: multi
    other: Anything else
    choices: [TTL, WAL, Backups]
  - name: why
    label: Why that one?
~~~

~~~review
title: Landing page
pick: true
columns: 2
items:
  - {name: A, label: dark header, image: a.svg, body: "Calm, **high contrast**"}
  - {name: B, label: light header, image: b.svg}
  - {name: C, label: prototype, page: proto.html, height: 220}
~~~

~~~mindmap
- Release
  - Build
    - bundle
    - sign
  - Ship
    - tag
    - announce
  - Verify
~~~

~~~suggest
- Go ahead
- {label: Not now, text: "Not now, ask me tomorrow"}
- 先看差異
~~~

~~~checklist
title: Before release
items:
  - {label: Run tests, checked: true}
  - {name: bump-version-and-tag, label: Bump version, note: semver}
  - {label: 更新 CHANGELOG}
~~~

~~~table
columns:
  - name
  - {name: size, label: Size, type: number}
  - {name: day, label: Shipped, type: date}
rows:
  - [alpha, 1204, 2026-03-01]
  - [beta, 2, 2026-01-15]
  - [gamma, 87, 2026-02-09]
  - [item 10, 7, 2026-04-01]
  - [item 9, 8, 2026-05-01]
sort: -size
filter: true
~~~

~~~steps
items:
  - {title: Design, status: done, when: Mon}
  - {title: Build, status: doing, when: Tue, body: "Two of **four** services left"}
  - {title: Legal review, status: blocked, body: Waiting on the vendor}
  - {title: Ship, status: todo}
~~~

~~~stats
- {label: Users, value: "1,204", delta: "+4%", tone: ok}
- {label: Errors, value: "3", delta: "-2", tone: ok, note: last hour}
- {label: Latency p95, value: 420 ms, delta: "+60 ms", tone: risk}
- {label: Builds, value: "18"}
~~~

~~~diff
diff --git a/cache.ts b/cache.ts
--- a/cache.ts
+++ b/cache.ts
@@ -1,4 +1,5 @@
 export function get(key: string) {
-  return store.get(key);
+  const hit = store.get(key);
+  return hit ?? load(key);
 }
~~~

~~~mermaid
graph TD
  A[Start] --> B{Ok?}
  B -->|yes| C[Done]
  B -->|no| D[Fix]
  D --> B
~~~

~~~tree
release/
  src/ {focus} # one package, four entries
    core/ # parser and text, no DOM
      parse.ts
      validate.ts {new} # checks answers
    elements/ {changed} # web components
      tree.ts {new} # the **tree** block
      old-table.ts {removed}
      legacy/ # untouched, starts closed
        grid.ts
        sheet.ts
    server/ {risk} # reads \`.env\` at start
      deep/
        deeper/
          deepest/
            leaf.ts {changed} # opens its path
  docs/
    guide.md
    notes.md
  tests/
  \u2026 12 more
  README.md {changed}
~~~

${DEMO_REVIEW_PICKS}
`);

/** A reply in the comms log: a form, quick replies, and a table. */
export const DEMO_CHAT_BLOCKS = fence(`I can ship the ledger fix today or wait for the window. Pick what you want, and I will carry on.

~~~form
title: Ship the ledger fix
submit: Send to billing-main
questions:
  - name: when
    label: When?
    required: true
    choices:
      - {value: now, label: Today, recommended: true}
      - {value: window, label: In the Friday window, note: safest}
  - name: note
    label: Anything I should watch?
~~~

~~~suggest
- Go ahead
- {label: Not now, text: "Not now, ask me tomorrow"}
~~~

~~~table
columns:
  - step
  - {name: rounds, label: Rounds, type: number}
  - result
rows:
  - [lint, 3, ok]
  - [unit, 41, ok]
  - [e2e, 12, 1 failing]
~~~

Here is what the fix touches, with the files I changed marked:

~~~tree
ledger/
  src/
    fix.ts {changed} # rounds the refund once
    refund.ts {risk} # the caller I could not test
  tests/
    fix.test.ts {new}
  CHANGELOG.md {changed}
~~~
`);

/** A picture for a review block's `image` in the demo: a dark page for A, a light one for the rest. */
export const demoImage = (ref: string) => {
	const dark = ref.startsWith("a");
	return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${dark ? "#1f2335" : "#e8e6df"}"/><rect x="20" y="20" width="280" height="26" fill="${dark ? "#7dcfff" : "#3b4261"}"/><rect x="20" y="64" width="190" height="14" fill="#868dba"/><rect x="20" y="90" width="240" height="14" fill="#868dba"/></svg>`)}`;
};

# dsh-memory

Persistent memory for DeepSeek Harness, backed by MongoDB vectors and with
**zero dependency on a model provider**. It works with any model that talks to
DSH, because everything happens on the host: retrieval, context injection and
tools.

## What it does

1. **Captures** every human message and every assistant reply (tool results are
   excluded) and stores it with its own embedding.
2. **Recalls**: before a step that carries new human input, it searches for the
   most relevant fragments and injects them into the conversation as a
   `<system-reminder>`. They are data, not instructions.
3. **Informs the model** in three places: a short section in the system prompt,
   a header on the injected block, and the tool descriptions.
4. **Tools**: `memory_search`, `memory_save`, `memory_forget`, `memory_stats`.

## Automatic provisioning

On activation the plugin prepares everything by itself:

| Backend | What it does |
|---|---|
| `auto` (default) | If Docker answers, it starts **Atlas Local**; otherwise it launches a local `mongod` |
| `atlas` | Forces Atlas Local; fails when Docker is unavailable |
| `local` | Forces a private `mongod` process |
| `external` | Connects only; provisions nothing |

In Atlas mode it starts Docker Desktop if it is installed but stopped, runs
`docker pull mongodb/mongodb-atlas-local:8.0` when the image is missing, creates
or starts the `dsh-memory-atlas` container publishing `30018 -> 27017`, waits for
Mongo and creates the `memory_vector` index (`$vectorSearch`, cosine, 1024 dims).

Progress is written to `~/.dsh/memory/status.json`. Activation never blocks
startup: capture and recall wait until the backend is ready. The file is
rewritten after every `memory_save` and at most every 15 s after a capture, so
`documents` and `lastCaptureAt` do not freeze.

## Installation

`dsh-memory` is a DSH **bundle**: `package.json` declares
`dsh.bundle.patch: ./cordis.patch.yml`, so the profile plugin manager appends the
package to `dsh.profile.bundles` and composes the layer that holds the `memory`
entry. There are no runtime dependencies: the MongoDB driver ships bundled in
`lib/mongodb.bundle.cjs`, and there is no `prepare` or `postinstall` (pnpm 11
blocks those on dependencies installed from git).

### With the plugin manager (recommended)

Web → sidebar → **Plugins** → install, with the spec that matches your source:

| Source | Spec |
|---|---|
| GitHub (public) | `github:OWNER/dsh-memory` |
| GitHub (private, SSH) | `git+ssh://git@github.com/OWNER/dsh-memory.git` |
| npm registry | `dsh-memory` (if published) |
| Local path | `file:C:\path\to\dsh-memory` |

The `desktop` profile is owned by the Electron application, so
`dsh plugin --profile desktop …` answers *"profile "desktop" is managed
exclusively by the Electron application"*: install from the Plugins page (or
through the `plugin_manager` tool), not from the CLI.

### By hand, without the manager

Copy the folder (without `node_modules`) to
`~/.dsh/profiles/desktop/plugins/dsh-memory` and add its entry to
`~/.dsh/profiles/desktop/cordis.patch.yml`. Note: a new entry must live inside
`insert:`; declaring it on its own makes the loader answer
`entry "memory" not found` and skip it.

```yaml
- insert:
    - id: memory
      name: './plugins/dsh-memory/index.mjs'
      config:
        backend: auto
        mongoPort: 30018
```

⚠️ The two routes are **alternatives, not additive**: an installed bundle plus a
manual entry leaves two fibers with the same `id: memory` registering the same
four tools.

With the manual route the desktop app **does not hot-reload the host patch**:
restart DeepSeek Harness once. Sessions are kept. With the manager, a profile
that has HMR applies the layer live; if it does not, the result reports
`restart-required`. Verification:

```powershell
Get-Content ~/.dsh/memory/status.json
mongosh "mongodb://127.0.0.1:30018/?directConnection=true" --eval 'db.getSiblingDB("dsh_memory").memories.countDocuments()'
```

After the restart `status.json` must carry `role: "host"` and the `pid` of the
host process. If `role` is `test`, a script wrote it and activation is still
pending.

## Configuration

Every key is optional; these are the defaults.

| Key | Default | Meaning |
|---|---|---|
| `backend` | `auto` | `auto`, `atlas`, `local`, `external` |
| `mongoUri` | `mongodb://127.0.0.1:30018/?directConnection=true` | Connection string |
| `database` | `dsh_memory` | Database |
| `mongoPort` | `30018` | Host port (Atlas mapping or local `mongod`) |
| `atlasImage` | `mongodb/mongodb-atlas-local:8.0` | Image to use |
| `atlasContainer` | `dsh-memory-atlas` | Container name |
| `atlasVolume` | `dsh_memory_atlas` | Docker volume (persistent data) |
| `autoStartMongo` | `true` | Launch a local `mongod` when needed |
| `mongodPath` | `C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe` | Local binary |
| `vectorSearch` | `true` | Create/use the `$vectorSearch` index on Atlas |
| `vectorIndex` | `memory_vector` | Index name |
| `dim` | `1024` | Embedding dimensions (changing it means recreating the index) |
| `scope` | `global` | `global` recalls across projects; `workspace` filters by `cwd` |
| `recallTopK` | `6` | Fragments injected per message |
| `recallMaxChars` | `3500` | Budget for the injected block |
| `recallMinScore` | `0.16` | Relevance threshold |
| `recallTimeoutMs` | `2500` | If Mongo takes longer, the turn answers without memory |
| `captureUser` / `captureAssistant` | `true` | What gets indexed |
| `captureMaxChars` | `8000` | Per-document clipping |
| `announce` | `true` | Announcement section in the system prompt |
| `dockerDesktopPath` | `C:\Program Files\Docker\Docker\Docker Desktop.exe` | To start it when stopped |
| `role` | `host` | Label of the process writing `status.json` (`test` in scripts and tests) |
| `statusPath` | `~/.dsh/memory/status.json` | State file path; tests use a temporary one |

The `apply()` registration report is written to `apply.json`, next to
`status.json`. It lists the phases that registered (`capture`, `recall`,
`tool:*`, `announce`) and the ones that failed, with their message.

## How it ranks

```
score = 0.62 * cosine(query, doc)
      + 0.28 * normalised textScore ($text, Spanish)
      + 0.10 * recency (45-day half-life)
      + 0.08 if pinned
```

Candidates come from `$vectorSearch` (Atlas) and from the text index; the whole
collection is never scanned. Cosine is recomputed in Node over the stored
vector, so the Vector index only speeds up candidate generation.

## Vendored driver (why there is a 1.5 MB `.cjs`)

The DSH host installs a `ResolutionRouter` that rewrites bare specifiers into
its own module tree. On Node 24 that router fails to resolve packages local to
the profile:

```
TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
    at ResolutionRouter.routeScoped (.../dsh-app-boot/lib/index.js:1423)
```

It affects both `import 'mongodb'` and `require('mongodb')`, because the driver
is CJS and its internal `require` calls also travel through the router. That is
why the driver is compiled into a single CJS bundle: at runtime only Node
builtins remain, and those bypass package resolution.

Regenerate the bundle after upgrading `mongodb`:

```powershell
cd ~/dev/dsh-memory          # repo/package root
npm install --no-audit --no-fund   # installs mongodb (devDependency, only for this)
# esbuild is not a package dependency: use whichever copy you have
& <path-to>\esbuild.cmd `
  node_modules\mongodb\lib\index.js `
  --bundle --platform=node --format=cjs --target=node20 `
  --outfile=lib\mongodb.bundle.cjs `
  --external:kerberos --external:@mongodb-js/zstd --external:snappy `
  --external:mongodb-client-encryption --external:aws4 `
  --external:@aws-sdk/credential-providers --external:gcp-metadata `
  --external:socks --external:bson-ext
```

## Embedding

`lib/embed.mjs` implements a **deterministic, dependency-free** embedding:
signed hashing of unigrams, bigrams and character 4-grams, sublinear term
frequency and L2 normalisation. Advantages: no downloads, no API, reproducible.
Honest limit: it is **lexical**, not semantic; two sentences that say the same
thing with different words may not come close. For personal use the hybrid with
`$text` covers most cases.

If you ever want semantic quality, the extension point is `embed()`: replace it
with a call to an OpenAI-compatible endpoint and reindex (same `dim`, or recreate
the index).

## Privacy

- Data stays on your machine: Docker volume `dsh_memory_atlas` or
  `~/.dsh/mongo/data`.
- User and assistant messages are stored; **not** tool results, images or
  attachments.
- Nothing is sent to any embedding provider.
- `memory_forget(id)` deletes one document; to wipe everything:
  `db.getSiblingDB("dsh_memory").memories.deleteMany({})`.

## Operations

```powershell
# state (role: "host" = plugin alive; "test" = a script wrote it)
Get-Content ~/.dsh/memory/status.json

# container
docker ps --filter name=dsh-memory-atlas
docker logs --tail 50 dsh-memory-atlas

# vector index
mongosh "mongodb://127.0.0.1:30018/?directConnection=true" --eval 'db.getSiblingDB("dsh_memory").memories.listSearchIndexes()'

# activation and logic tests (throwaway database, temporary status.json)
cd ~/dev/dsh-memory
npm test

# end-to-end smoke against Atlas Local, with a real vector index
$env:MEMORY_BACKEND="external"; node scripts/smoke.mjs
```

## Known issues

- **`entry "memory" not found`**: the entry is declared on its own instead of
  inside `- insert:`. Fixed in the installation example.
- **`status.json` says `ready` but the `memory_*` tools do not exist**: check
  `role`. If it is `test`, a script wrote it and the host never imported the
  module; the reliable signal is `role: "host"`, the four registered tools and
  the `dsh-memory` section in the system prompt. A script must never point at the
  real database. To find out what failed inside `apply()`, read the `apply.json`
  written next to `status.json`: it lists the registered phases (`capture`,
  `recall`, `tool:*`, `announce`) and the first failure with its message. Every
  phase is isolated, so a failure in `announce` no longer leaves the plugin
  without tools.
- **`failed to import` / `pending (waiting for services)`**: the runtime could
  not import the plugin. If the message mentions `ResolutionRouter` or
  `createRequire.resolve.paths`, the driver's CJS bundle is missing or was
  regenerated badly. If it mentions services, `inject` must be an array
  (`['tools']`), not a `{required, optional}` object.
- **The plugin does not show up after editing the patch**: restart the app; the
  desktop profile does not hot-reload the host patch.
- **`open //./pipe/dockerDesktopLinuxEngine`**: Docker Desktop is stopped. The
  plugin tries to start it; if it cannot, it falls back to a local `mongod`.
- **Slow first run**: `docker pull` of ~1.5 GB. The state reflects it in
  `status.json` (`phase: pulling-image`).
- **`vectorIndexReady: false`**: the index is still building or failed; recall
  keeps working with text + recency.
- **Changing `dim`**: the index must be dropped and the data reindexed; old
  vectors stop being comparable.
- **Spanish `$text`**: the index uses `default_language: spanish`; English
  queries still work, with less stemming.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

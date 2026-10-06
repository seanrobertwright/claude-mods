# Running Laya on this Windows machine

Research for #80, a ticket on the System One map (#79).
It answers what Laya takes to run as a mod's System One model on this Windows 11 Pro machine.
Answered from primary sources only, as of Laya 0.3.28 (the PyPI release of 2026-10-05) and the Laya repository at commit `a4a8921`.
Nothing was installed and no model was downloaded.
The facts about this machine were read from Windows itself; every latency and memory figure below comes from Laya's own measurements on other hardware.

How sources are cited:

- **[laya]** is the Laya repository at commit `a4a8921`, cited by file and symbol.
- **[pypi]** is the PyPI metadata for `laya` 0.3.28.
- **[hf-api]** is the Hugging Face model API for the checkpoint repositories, read for file sizes only.
- **[ts-api]**, **[ts-models]**, **[ts-confidence]** and **[ts-sdk]** are TypeSafe's documentation pages for Jev.
- **[hf-cache]** and **[pytorch-2.7]** are the Hugging Face cache guide and the PyTorch 2.7 release post.
- **[host]** is this machine, read with CIM, `nvidia-smi`, `py -0p` and `Get-NetTCPConnection` on 2026-10-05.

The URLs are in the sources list at the end.

## Short answer

- **Install.** A Python 3.10+ virtual environment and `pip install "laya[serve]"`.
  On Windows the default torch wheel from PyPI is CPU-only [laya: `.github/workflows/ci.yml` job `test-windows`].
  The weights come from Hugging Face on first start, into `%USERPROFILE%\.cache\huggingface\hub` unless `HF_HOME` or `HF_HUB_CACHE` moves it [hf-cache].
  The default server preloads every checkpoint, about 2.4 GB of files [hf-api].
- **Running.** `laya-serve` takes no command-line flags; it reads environment variables only [laya: `laya/serve.py` `main`].
  It binds `0.0.0.0:8000` by default; `LAYA_HOST` and `LAYA_PORT` change that.
  **On this machine port 8000 is already held** on `0.0.0.0` by an unrelated FastAPI app [host].
  So a default `laya-serve` should fail to bind here (not tried), and a mod must not assume that `http://127.0.0.1:8000` is Laya.
- **Detection.** `GET /health` cannot tell a Laya server apart.
  A Laya with `LAYA_API_KEY` set answers an unauthenticated caller `{"status": "ok"}` and nothing else [laya: `laya/serve.py` `LIVENESS_ONLY`].
  The unrelated app on this machine's port 8000 also answers `/health` with a 200 [host].
  The unambiguous probe is `GET /openapi.json`: laya-serve's `info.title` is `laya-serve` and its `paths` include `/v1/systemone` [laya: `laya/serve.py` `create_app`].
  It needs no bearer and runs no inference.
- **CPU, latency, memory.** Laya picks CUDA, then MPS, then XPU, then CPU [laya: `laya/mcp/device.py` `resolve_device`].
  With the default Windows wheel that means CPU.
  Laya's own CPU measurements are a few hundred milliseconds for a request of a few questions.
  They also show roughly 1.15 to 2.3 GB of RSS per resident checkpoint, and 7 to 23 seconds to rebuild a checkpoint on CPU (sections 2 and 3).
  None of this was measured on this machine.
- **Protocol.** Same path, same question shapes and same answer keys as Jev.
  The differences are listed in section 5.
  They are the `model` field, the extra response fields, the confidence formula, the limits, the error codes (`503`, never `429`/`529`), a batch route Jev does not document, and no `GET /v1/models`.
- **Lifetime.** laya-serve is a foreground console program.
  Laya ships no Windows service; its long-running recipes are a NixOS systemd module and a Docker Compose service with `restart: unless-stopped`.
  It runs one forward pass at a time: a second client waits, and past `LAYA_MAX_CONCURRENT` (16) admitted requests the rest get `503` with `Retry-After: 1`.

## 1. This machine

| Item | Value [host] |
| --- | --- |
| CPU | AMD Ryzen 9 5950X, 16 cores, 32 logical processors |
| RAM | 128 GB |
| GPU | NVIDIA GeForce RTX 5060 Ti, 16 GB, compute capability 12.0, driver 610.47 |
| Python | `python` on PATH is 3.14.8; 3.11, 3.12 and 3.13 are also installed (`py -0p`) |
| laya-serve | not installed |
| Port 8000 | listening on `0.0.0.0` by an unrelated FastAPI app run by `python` |

The app on port 8000 answers `GET /health` with `200 {"status":"healthy"}` and a `server: uvicorn` header.
Its `GET /openapi.json` carries its own `info.title`, which is not `laya-serve`.

## 2. Install

### Package and Python

- `laya` 0.3.28 requires Python `>=3.10` and depends on `torch>=2.0.0`, `transformers>=4.48.0`, `safetensors`, `huggingface_hub` and `numpy` [pypi] [laya: `pyproject.toml`].
- The `serve` extra adds `fastapi>=0.110.0`, `uvicorn>=0.27.0` and `python-multipart` [laya: `pyproject.toml`].
  The `laya-serve` command (`laya.serve:main`) needs that extra to run [laya: `pyproject.toml` `[project.scripts]`].
- These steps are the README's Windows PowerShell steps with Python 3.11, with the `[serve]` extra added [laya: `README.md` "Installation details", "Self-Hosting"]:

  ```powershell
  py -3.11 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install "laya[serve]"
  .\.venv\Scripts\python.exe -I -c "import laya; print(laya.__version__)"
  ```

- Laya's Windows CI lane runs Python 3.11 and installs torch plainly.
  Its comment says "On Windows the default PyPI wheel is already CPU-only, so installing torch plainly is both correct and what a user gets" [laya: `.github/workflows/ci.yml` job `test-windows`].
  That lane runs the server's test suite (`tests/test_serve.py`) on Windows.
- This machine's default `python` is 3.14.
  The README says a Windows + Python 3.14 model-construction crash was fixed in Laya 0.3.7 and verified on a Windows 11 setup [laya: `README.md` "Installation details"].
  3.11 is the version Laya's own Windows CI uses.

### GPU on this machine

- Device selection is automatic in the order CUDA, MPS, XPU, CPU, and `LAYA_DEVICE` overrides it [laya: `laya/mcp/device.py` `resolve_device`] [laya: `README.md` "Command line"].
- To use the RTX 5060 Ti, a CUDA build of torch has to be installed before Laya, from PyTorch's own index [laya: `README.md` "Installation details"].
- The card reports compute capability 12.0 [host], which is NVIDIA's Blackwell generation.
  PyTorch added Blackwell support and pre-built CUDA 12.8 wheels in 2.7 [pytorch-2.7].
  Whether Laya runs on this card with such a build was not tried.
- A GPU it cannot use is not an error: "an `Agent` that asks for a GPU it cannot get falls back to CPU silently" [laya: `laya/serve.py` module docstring].
  `GET /health` reports the device a checkpoint really computes on (section 4).
- Do not set `LAYA_CPU_AMP=bf16` here.
  The 0.3.28 notes say the Windows lane's bf16 legs "are skipped on a Windows CPU, where they hit an uncatchable SIGILL (#949)" [laya: `README.md` "What's new in 0.3.28"].

### Weights and cache

- The checkpoints are named in `DEFAULT_MODELS`: `english` is the root of the Hub repository `convaiinnovations/laya`, while `multilingual` and `typed-decisions` are subfolders of it [laya: `laya/router.py` `DEFAULT_MODELS`].
  The code comment says "only the requested subfolder is downloaded".
- Sizes at Hub revision `7b928d8` [hf-api]:

  | Checkpoint | Largest files |
  | --- | --- |
  | `english` | `model.safetensors`, about 843 MB |
  | `multilingual` | `model.safetensors`, about 644 MB, plus a 34 MB `tokenizer.json` |
  | `typed-decisions` | `model.safetensors`, about 843 MB |
  | the whole repository | about 2.37 GB |

- Laya's README describes the parameter counts as about 421M for English and typed-decisions and about 322M for multilingual [laya: `README.md` "Installation details"].
- The cache is Hugging Face's own: `~/.cache/huggingface/hub` by default, moved by `HF_HOME` or `HF_HUB_CACHE` [hf-cache] [laya: `README.md` "Installation details"].
- On Windows, the cache's symlinks need Developer Mode or an administrator Python; the guide calls this "a known limitation especially on Windows" [hf-cache].
- Laya's Docker CPU quickstart asks for 8 GB of RAM and 10 GB of free disk [laya: `docs/docker.md`].
  The bare `pip` install states no figure; the size of the torch wheel was not checked.

### First start

First start was not timed here.
It is the download, then a build of each preloaded checkpoint:

- laya-serve preloads before it listens.
  `main` calls `create_app()`, which calls `build_router()`, which calls `Router.preload` when `LAYA_PRELOAD` is on (the default), all before `uvicorn.run` binds the port [laya: `laya/serve.py` `main`, `create_app`, `build_router`].
  Until every preloaded checkpoint is built, the port is closed and a client gets "connection refused", exactly as if nothing were running.
- Reloading an evicted checkpoint on CPU is measured at a 7.4 s median [laya: `README.md` "Production Preload & Memory"].
  Issue #172 measured 20 to 23 s per request when a checkpoint had to be rebuilt on CPU [laya: `laya/serve.py` `_resolve_max_loaded`].
- Laya's Compose healthcheck allows `start_period: 10m` for a container that downloads and preloads [laya: `compose.http.yaml`].
- With `LAYA_PRELOAD=0` nothing is built before the port opens, and the first request pays the download and the build instead [laya: `laya/serve.py` `build_router`] [laya: `docs/http-api.md` "GET /health"].

## 3. Running laya-serve

### Configuration

`main` reads no command-line arguments, so `laya-serve --port 9000` does not change the port; everything comes from the environment [laya: `laya/serve.py` `main`].

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAYA_HOST` | `0.0.0.0` | bind address |
| `LAYA_PORT` | `8000` | bind port; anything but an integer 1 to 65535 stops the server with a message (`_resolve_port`) |
| `LAYA_DEVICE` | auto | torch device for every checkpoint; a preference, not a guarantee |
| `LAYA_PRELOAD` | `1` | build the checkpoints at startup |
| `LAYA_MODELS` | all | comma list to preload; others still load on demand |
| `LAYA_THREADS` | torch default | cap on torch intra-op threads; keep it at or below physical cores |
| `LAYA_AUTO_TASK` | `0` | let routing reach `typed-decisions` |
| `LAYA_DEFAULT_MODEL` | `english` | checkpoint for a state with no language evidence; an unknown name stops the server |
| `LAYA_MAX_LOADED` | `2` | checkpoints resident at once |
| `LAYA_IDLE_UNLOAD_SECONDS` | `0` (off) | unload checkpoints after this many idle seconds |
| `LAYA_API_KEY` | none | when set, require `Authorization: Bearer <key>` |
| `LAYA_ROOT_PATH` | none | public URL prefix behind a reverse proxy |
| `LAYA_LOG_LEVEL` | `info` | uvicorn log level |
| `LAYA_MAX_CONCURRENT` | `16` | requests admitted past auth at once; the rest get `503` |
| `LAYA_MAX_TOKEN_BUDGET` | `8192` | cap on a request's `max_len` and `head_max_len` |
| `LAYA_MAX_BATCH_TOKENS` | `131072` | tokens one batch forward pass may collate; larger batches are split |
| `LAYA_JEV_STRICT` | `0` | answer with the strict Jev contract only (section 5) |

Sources: [laya: `laya/serve.py` module docstring, `_resolve_port`, `build_router`, `_resolve_max_batch_tokens`] [laya: `docs/http-api.md` "Configuration"].
`LAYA_CUDA_AMP` and `LAYA_CPU_AMP` choose the autocast dtype inside the model [laya: `laya/agent.py` `_cuda_amp_dtype`, `_cpu_amp_dtype`].

The Docker Compose service sets different defaults from bare `laya-serve`.
It uses `LAYA_PRELOAD=0`, `LAYA_DEVICE=cpu`, and publishes the port on `127.0.0.1` only, "because the API has no authentication until `LAYA_API_KEY` is set" [laya: `compose.http.yaml`].

### A configuration for this machine

This is a recommendation, not something the sources prescribe.

```powershell
$env:LAYA_HOST    = "127.0.0.1"  # the API has no authentication by default
$env:LAYA_PORT    = "8001"       # an example; 8000 is taken here
$env:LAYA_MODELS  = "english"    # preload one checkpoint; multilingual loads on demand
$env:LAYA_THREADS = "16"         # the physical core count
.\.venv\Scripts\laya-serve.exe
```

- `127.0.0.1` keeps the unauthenticated API off the network, as Laya's own Compose file does.
- The default `LAYA_MODELS` preloads every checkpoint, which downloads all of them and keeps all of them resident; `Router.preload` raises the resident cap to hold what it builds [laya: `laya/serve.py` `_resolve_max_loaded`].
- `LAYA_THREADS` matters on this CPU.
  The docs warn that "oversubscribing the logical/hyperthread count is a large regression" [laya: `laya/serve.py` module docstring].
  On a 56-thread Xeon, 16 threads was the fastest setting (366 ms), and 56 threads took 1266 ms [laya: `LOCAL_SETUP.md` "Measured performance"].

### Latency on CPU

Laya's CPU numbers come from a 2019 Mac Pro with a 56-thread Intel Xeon, not from this machine:

| Measurement | Value | Source |
| --- | --- | --- |
| one `predict()`, 4 questions, short email, 28 threads | `english` 453 ms, `multilingual` 192 ms, `typed-decisions` 441 ms | [laya: `LOCAL_SETUP.md` "Measured performance"] |
| a preloaded `Router`, per request | 193 to 464 ms on CPU, 32.8 ms on a T4 GPU | [laya: `README.md` "Production Preload & Memory"] |
| one row (one question) at `max_len` 512, `english` | about 127 to 142 ms | [laya: `laya/serve.py` comment on `DEFAULT_MAX_BATCH_TOKENS`] |
| a request that has to rebuild its checkpoint | 20 to 23 s, against 49 to 136 ms resident | [laya: `laya/serve.py` `_resolve_max_loaded`] |

Cost grows with the number of questions, because each question is a row of its own [laya: `docs/http-api.md` "Response"].
Every successful answer carries `Server-Timing: inference;dur=<ms>` and `X-Inference-Time-Ms` headers, so a mod can log the real figure [laya: `laya/serve.py` `create_app`].

### Memory

- The `english` checkpoint on CPU held a peak RSS of 1151 MB, flat from 32 to 128 rows [laya: `laya/serve.py` comment on `DEFAULT_MAX_BATCH_TOKENS`].
- `RemoteRouter`'s docstring prices one resident checkpoint at 1.3 GB per process [laya: `laya/mcp/remote.py` `RemoteRouter`].
- On the macOS test machine a single resident checkpoint sat at 2.3 GB of RSS [laya: `LOCAL_SETUP.md` "What the soak check found"].
- Nothing is freed while idle by default (`LAYA_IDLE_UNLOAD_SECONDS=0`).
  With it set, the model references and device caches are released, but "the process allocator may retain RAM pages, so process RSS need not fall by the size of the checkpoint" [laya: `docs/http-api.md` "Configuration"].

This machine has 128 GB of RAM [host], so memory is not the constraint here.

## 4. Detecting a Laya server

### The exact /health response

`health` in `create_app` answers in one of two shapes [laya: `laya/serve.py` `create_app`, `LIVENESS_ONLY`]:

- **`LAYA_API_KEY` set and the bearer missing or wrong:** `200 {"status": "ok"}` and nothing else.
  A wrong bearer is still a 200, never a 401 [laya: `docs/http-api.md` "GET /health"].
- **No key set, or the right bearer:** the full payload.

```json
{"status": "ok", "loaded": ["english", "multilingual"], "revisions": {"english": "...", "multilingual": "..."},
 "device": "cuda", "device_is_preference": false,
 "checkpoint_devices": {"english": "cuda", "multilingual": "cuda"},
 "cpu_fallbacks": {"english": {"count": 0, "last_reason": null}, "multilingual": {"count": 0, "last_reason": null}}}
```

That sample is from [laya: `docs/http-api.md` "GET /health"].
With idle unloading on, the full payload adds `idle_unload_seconds` and `idle_seconds`.

- `status` is `ok` "whenever the process answers at all. It says nothing about the checkpoints."
- `loaded` is empty until a checkpoint is built, and again after an idle unload.
- `device` is where a resident checkpoint really computes; `device_is_preference` is `true` only while nothing is resident.

### Why /health is not enough

- A keyed Laya gives an unauthenticated caller only `{"status": "ok"}`, a shape any server can return.
- Laya's own playground server, `examples/server.py`, also listens on `127.0.0.1:8000` by default.
  It also answers `GET /health` with `{"status": "ok"}` (or `"loading"`) plus a `config` block.
  But it serves `/predict`, not `/v1/systemone` [laya: `examples/server.py` `health`, `main`].
- On this machine an unrelated app answers `GET /health` on port 8000 with a 200 and `server: uvicorn` [host].
  The `server` header is uvicorn's, so every uvicorn app sends it.

### Signals that identify laya-serve

| Signal | What laya-serve gives | Needs the bearer? | Source |
| --- | --- | --- | --- |
| `GET /openapi.json`, `info.title` | `"laya-serve"` | no | [laya: `laya/serve.py` `create_app`] |
| `GET /openapi.json`, `paths` | `/health`, `/v1/systemone`, `/v1/systemone/batch` | no | [laya: `laya/serve.py` `create_app`] |
| `POST /v1/systemone`, response `model` | always `"laya-rl-agent"`; the checkpoint is in `routing.model` | yes, when a key is set | [laya: `docs/http-api.md` "Response"] [laya: `laya/agent.py` `Agent`] |
| response headers | `Server-Timing: inference;dur=…` and `X-Inference-Time-Ms` | yes, when a key is set | [laya: `laya/serve.py` `create_app`] |
| `GET /v1/models` | no such route, so FastAPI's 404 (Jev lists its models here) | no | [laya: `laya/serve.py` `create_app`] [ts-models] |

`create_app` builds `FastAPI(title="laya-serve", …)` and leaves FastAPI's default `/openapi.json` route on.
Laya's own tests read `/openapi.json` from the app [laya: `tests/test_serve.py` `test_root_path_from_environment_updates_openapi_and_keeps_routes`].
`create_app` passes no `version`, so `info.version` is FastAPI's default, and the Laya package version is not visible over HTTP.

A recommended probe, for #86 to decide on:

1. `GET {base}/openapi.json`; require a 200, a JSON object, `info.title === "laya-serve"`, and `/v1/systemone` among `paths`.
   This needs no bearer, costs no inference, and works whether or not `LAYA_API_KEY` is set.
2. Then `GET {base}/health` for readiness.
   A full payload with an empty `loaded` means the first request will pay a checkpoint build.

The `/openapi.json` content above is read from the code and FastAPI's defaults; it was not observed from a running laya-serve.

## 5. Protocol differences from Jev

| Topic | Jev | Laya |
| --- | --- | --- |
| Decision route | `POST /v1/systemone` [ts-api] | `POST /v1/systemone` [laya: `laya/serve.py` `create_app`] |
| Batch route | none in the API reference [ts-api] | `POST /v1/systemone/batch`: `{states, questions}` in, `{results, total_usage}` out, 64 states at most [laya: `README.md` "Self-Hosting"] |
| Model list | `GET /v1/models` [ts-models] | none |
| Auth | bearer required [ts-api] | none unless `LAYA_API_KEY` is set; with no key set, any `Authorization` header is ignored [laya: `laya/serve.py` `create_app`] |
| `model` in the request | required; `jev-latest`, `jev-preview` or a versioned id [ts-api] [ts-models] | optional; `english`, `multilingual`, `typed-decisions`, their aliases and published Hub ids pin a checkpoint; `jev-1`, `convaiinnovations/laya` and other unknown names auto-route; a path or unpublished `org/repo` is `422` [laya: `laya/serve.py` `_resolve_model`] |
| `model` in the response | the versioned id that answered, such as `jev-1.13.0` [ts-models] | the constant `laya-rl-agent`; the checkpoint is in `routing.model` [laya: `docs/http-api.md` "Response"] |
| Extra response fields | none | root `routing`; per answer `answer_confidence` and `action`; `confidence` on `noul`; `usage` truncation facts; all removed by `LAYA_JEV_STRICT=1` [laya: `laya/serve.py` `_project_jev_strict`] |
| `confidence` | choice `(n·p_max − 1)/(n − 1)`; score a distance-weighted formula; none on `noul` [ts-confidence] [ts-api] | choice and score `1 − H(p)/log(k)`; `noul` `max(p_yes, p_no)`; thresholds do not transfer [laya: `docs/http-api.md` "Confidence"] |
| `usage.output_tokens` | counted (for example 20) [ts-api] | always `0` [laya: `docs/http-api.md` "Response"] |
| Choice options | up to 255 [ts-api] | `413` past 100 per question or 512 across questions; the option prompt has a 192-token budget on `english` and 256 on the others, so around 20 described options start to be trimmed, and options that cannot fit are `422` [laya: `laya/serve.py` `_check_request_limits`] [laya: `README.md` "Self-Hosting"] |
| Score levels | at least two, up to 10 [ts-api] | `413` past 32; a `null` level is `422` [laya: `laya/serve.py` `_check_request_limits`] |
| Questions per request | no limit stated in the pages read | `413` past 64 [laya: `laya/serve.py` `MAX_QUESTIONS`] |
| State size | 64k tokens per request, 32k for the state plus the longest question [ts-models] | `413` past 50,000 characters or a 2 MiB body [laya: `docs/http-api.md` "Limits"]; the model reads a 512-token window on `english` and 1,024 on `multilingual` by default, and reports any cut in `usage.truncated` [laya: `laya/serve.py` `_BATCH_ROW_TOKENS_ASSUMED`] [laya: `README.md` "Quickstart"] [laya: `docs/http-api.md` "Response"] |
| Error codes | `401`, `422`, `429`, `529` [ts-api] | `400` (malformed body), `401`, `413`, `422`, `500` (always `inference failed`), `503` with `Retry-After: 1` [laya: `docs/http-api.md` "Errors"] |
| Throughput | rate limits of 100K tokens/s and 80 requests/s [ts-models] | one forward pass at a time (section 6) |
| Choice `criteria` | a map of option to description [ts-api] | the map, or a list of labels [laya: `laya/agent.py` `Agent._check_question`] |

## 6. Lifetime and concurrency

### Two clients at once

- Inference runs on a single-worker thread pool behind one `asyncio.Lock`, so one forward pass runs at a time [laya: `laya/serve.py` `create_app`].
  A second client's request waits for the first to finish; it is queued, not refused.
- An admission semaphore of `LAYA_MAX_CONCURRENT` (16) is checked before any body byte is read.
  It does not wait: a request that finds every slot taken gets `503 {"detail": "server busy, try again later"}` with `Retry-After: 1` [laya: `laya/serve.py` `create_app`].
- `GET /health` stays responsive during inference, because the forward pass is off the event loop [laya: `docs/http-api.md` "GET /health"].
- The batch route shares the same gate and admission [laya: `docs/http-api.md` "Concurrency model"].

### As a background process on Windows

- `main` runs uvicorn in the foreground of a console process [laya: `laya/serve.py` `main`].
  Laya ships no Windows service, installer or Task Scheduler recipe.
- The long-running setups Laya does ship:
  - A NixOS module that runs laya-serve as a hardened systemd unit [laya: `README.md` "Nix / NixOS"].
  - A Docker Compose service with `restart: unless-stopped`, a `/health` healthcheck and a loopback-only port [laya: `compose.http.yaml`].
    On Windows that means Docker Desktop, and a GPU there "requires Docker Desktop's supported WSL2 GPU setup" [laya: `docs/docker.md`].
- Outside Laya's sources, and not tried here: a Task Scheduler task at log-on that sets the variables and starts `laya-serve.exe` from the venv.
  A service wrapper such as NSSM or WinSW would be the other route, since a console program is not a Windows service by itself.
- On stop, the app drains its inference pool [laya: `laya/serve.py` `create_app` `lifespan`].
- `main` already carries one Windows-specific fix: it sets `TCP_NODELAY` itself, because on Windows asyncio does not, and Nagle's algorithm delayed small responses (#620) [laya: `laya/serve.py` `main`].

## 7. What this changes for other tickets

- **#86 (Laya detection).**
  Detection has to check identity, not liveness, because this machine already answers on the default port with something else.
  The base URL has to be configurable, since Laya's default port is already taken here.
  A closed port can mean "not running" or "still preloading".
  A first request to a lazily loaded server can take seconds to minutes, so the mod needs its own timeout.
  The map notes that `$.http.fetch` has no timeout option.
- **#85 (key location).**
  The names already in use are TypeSafe's SDK variables `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` [ts-sdk].
  Laya's own MCP server talks to a running laya-serve when `LAYA_BASE_URL` is set, with a timeout from `LAYA_REMOTE_TIMEOUT` that defaults to 300 s [laya: `laya/mcp/remote.py` module docstring, `_timeout_from_env`].
  The server's bearer is `LAYA_API_KEY`.
  The TypeSafe SDK's default timeout is 10 s [ts-sdk].
- **#87 (precedence and privacy).**
  A Laya bound to `127.0.0.1` keeps the state on the machine.
  The Jev bearer must never be sent to the Laya URL.
  A Laya with no key ignores it, and the process at that URL may not be Laya at all, as on this machine.
  Confidence thresholds do not carry over between the two backends (section 5).
  A gated mod needs a threshold per backend, or must gate on `probabilities`.
  Busy handling differs too: Laya answers `503`, while Jev answers `429` or `529`.

## 8. Open questions

These are things the sources do not settle and that were not tried on this machine.

1. **Latency and RSS of laya-serve on this Ryzen 9 5950X.**
   Every figure in section 3 is from other hardware.
2. **Whether a CUDA build of torch runs Laya on the RTX 5060 Ti** (compute capability 12.0).
3. **Whether torch publishes a Windows wheel for Python 3.14** that Laya 0.3.28 runs on.
   The README's 3.14 note is about model construction only.
4. **How long the first start takes here**: the download at this connection's speed, plus the builds.
5. **The exact `/openapi.json` body**, which is read from the code, not observed.
6. **Whether Windows Defender Firewall prompts** when laya-serve binds `0.0.0.0`.
7. **How much disk the Hugging Face cache uses on Windows** without Developer Mode.
8. **Whether loading `english` from the root of the repository also downloads the subfolders.**

## Sources

- [laya] Laya repository at commit `a4a8921`: <https://github.com/NandhaKishorM/laya/tree/a4a8921afebfd852bba0000475cfb6ab737a124c>.
  Files used: `laya/serve.py`, `laya/router.py`, `laya/agent.py`, `laya/mcp/device.py`, `laya/mcp/remote.py`, `examples/server.py`, `tests/test_serve.py`, `pyproject.toml`, `compose.http.yaml`, `.github/workflows/ci.yml`, `README.md`, `LOCAL_SETUP.md`, `docs/http-api.md`, `docs/docker.md`.
- [pypi] `laya` on PyPI: <https://pypi.org/project/laya/> (JSON: <https://pypi.org/pypi/laya/json>).
- [hf-api] Hugging Face model API: <https://huggingface.co/api/models/convaiinnovations/laya?blobs=true>.
- [ts-api] TypeSafe API reference: <https://docs.typesafe.ai/api.md>.
- [ts-models] TypeSafe models: <https://docs.typesafe.ai/models.md>.
- [ts-confidence] TypeSafe confidence: <https://docs.typesafe.ai/confidence.md>.
- [ts-sdk] TypeSafe Python SDK constants: <https://docs.typesafe.ai/sdk/python/api/constants.md>.
- [hf-cache] Hugging Face cache guide: <https://huggingface.co/docs/huggingface_hub/guides/manage-cache>.
- [pytorch-2.7] PyTorch 2.7 release: <https://pytorch.org/blog/pytorch-2-7/>.
- [host] This machine, read on 2026-10-05.

# Changelog

## [0.1.58](https://github.com/tmac1973/haruspex/compare/v0.1.57...v0.1.58) (2026-07-22)


### Features

* **agent:** guarantee requests fit context with a self-calibrating pre-send guard ([f6f675e](https://github.com/tmac1973/haruspex/commit/f6f675e6ba80820b9c3e7d1155c5a27238c3d391))
* **agent:** image embedding, python lint, sampling tweaks ([d328f43](https://github.com/tmac1973/haruspex/commit/d328f43e7594f7720078b0fb7499b3bd5807bb9c))
* **agent:** image embedding, python lint, sampling tweaks ([395515a](https://github.com/tmac1973/haruspex/commit/395515a3c130e8e4f72ba4b455797d8c4884a133))
* **agent:** nudge after 3 consecutive run_python failures ([0acda1a](https://github.com/tmac1973/haruspex/commit/0acda1aa6841635bc4f5771a8c4390ce9ba4bba0))
* **agent:** show why a turn stopped (turn limit vs gave up) with a Continue action ([#147](https://github.com/tmac1973/haruspex/issues/147)) ([479fb90](https://github.com/tmac1973/haruspex/commit/479fb9061092777ed3fa4d179b47ab13ccaa599f))
* **chat:** click-to-enlarge for inline image thumbnails ([7ca4aea](https://github.com/tmac1973/haruspex/commit/7ca4aea11dfb980d81a355eb5d63cd8f43831f3f))
* **chat:** persist messageSteps to DB so inline images survive restart ([d7a3fb7](https://github.com/tmac1973/haruspex/commit/d7a3fb724fbd509cffdfa3ddf4d1a9ee1f4236bb))
* **code:** add exclude/count/files-only/context to code_grep ([5cbcd07](https://github.com/tmac1973/haruspex/commit/5cbcd07a4ce06c2c15fd30e2e60525d06a559952))
* **feedback:** add in-app feedback button and diagnostics export ([49a2aa1](https://github.com/tmac1973/haruspex/commit/49a2aa1e0d3e206f1e7394534bb215050f3e403e))
* **feedback:** in-app feedback button + diagnostics export ([6c7ad8e](https://github.com/tmac1973/haruspex/commit/6c7ad8e37aa38456f87882544e745c164d478218))
* global working dir + per-message tok/s indicator ([65a18e6](https://github.com/tmac1973/haruspex/commit/65a18e69a725f2a8acd06a7a36c3724420feb7a5))
* guided planning job type + reusable ask_user_question primitive ([#162](https://github.com/tmac1973/haruspex/issues/162)) ([b11c58c](https://github.com/tmac1973/haruspex/commit/b11c58ce4c088aa94e0cebbbc35cc975a5396a22))
* **inference:** add OpenRouter as a first-class cloud backend ([#168](https://github.com/tmac1973/haruspex/issues/168)) ([6d8c566](https://github.com/tmac1973/haruspex/commit/6d8c5667c687bb498f1cf6285bb2f8f0fe89ce75))
* **inference:** app-level queue so chat + jobs don't head-of-line block ([901bdf5](https://github.com/tmac1973/haruspex/commit/901bdf54934ea3425eaac51554b68260ce45f88c))
* **inference:** consume llama-toolchest capability discovery ([#130](https://github.com/tmac1973/haruspex/issues/130)) ([9400c22](https://github.com/tmac1973/haruspex/commit/9400c22b5b895e46dfb30cd1047dbea8e06d3553))
* **inference:** predictive VRAM context cap + allow-spill toggle ([#181](https://github.com/tmac1973/haruspex/issues/181)) ([d371857](https://github.com/tmac1973/haruspex/commit/d371857b5dbe6793d6979320ad9f12659097c5c0))
* **inference:** scope the admission queue per provider lane ([#163](https://github.com/tmac1973/haruspex/issues/163)) ([8eccdc6](https://github.com/tmac1973/haruspex/commit/8eccdc6b6d71f8936f9421383ade765909896d9b))
* **inference:** support multiple remote server URLs ([#129](https://github.com/tmac1973/haruspex/issues/129)) ([bef06be](https://github.com/tmac1973/haruspex/commit/bef06be59cdb946c7ec7a98ffee9c7c66bc3178b))
* job-step timers, 256K context option, settings card order fix ([#180](https://github.com/tmac1973/haruspex/issues/180)) ([59ff503](https://github.com/tmac1973/haruspex/commit/59ff50352cd61c5d78f9275a9e3d9280864818d9))
* **jobs:** add jobs CRUD + editor UI (phase 14 step 2) ([f764f1b](https://github.com/tmac1973/haruspex/commit/f764f1be9ff46b38f01d6d2eda40dd7de950655c))
* **jobs:** audit mode, prompt catalog, and per-job remote model overrides ([3481253](https://github.com/tmac1973/haruspex/commit/3481253ba29b4a823ad0a502927574eea4080aca))
* **jobs:** autonomous_coding job type — unattended ralph loop over a plan directory ([#175](https://github.com/tmac1973/haruspex/issues/175)) ([4cfa4eb](https://github.com/tmac1973/haruspex/commit/4cfa4eb284d5aef08ca2bdc9c0810dba87066c5c))
* **jobs:** convert job types to a plugin registry with a type_config column ([#174](https://github.com/tmac1973/haruspex/issues/174)) ([8c1f02c](https://github.com/tmac1973/haruspex/commit/8c1f02c1b70b84c91341ffe1ffcc27a4dd7e63a7))
* **jobs:** crash recovery for orphaned runs (phase 14 step 6) ([21f43a5](https://github.com/tmac1973/haruspex/commit/21f43a5e910c9840718ede0cf51877a2e1883e5b))
* **jobs:** delete runs from history sidebar ([44c6d38](https://github.com/tmac1973/haruspex/commit/44c6d38537cefb69c2b51cccf457d42282028fb7))
* **jobs:** delete runs from history sidebar — single and bulk ([40d7479](https://github.com/tmac1973/haruspex/commit/40d7479f1c669a0439f10d69cc98d2dea20a8e78))
* **jobs:** manual single-step run via ephemeral agent loop (phase 14 step 3) ([221b168](https://github.com/tmac1973/haruspex/commit/221b168e96829a712c1b2c3666d15a4926935c8f))
* **jobs:** multi-step pipelines with prior-output prepend (phase 14 step 4) ([56953a3](https://github.com/tmac1973/haruspex/commit/56953a319f782159290d11c0226e8bff4806e343))
* **jobs:** persist runs + browsable history pane (phase 14 step 5) ([e16cf8f](https://github.com/tmac1973/haruspex/commit/e16cf8f429b3725c98d9ee3358766df7c8125e8c))
* **jobs:** Phase 14 — Jobs tab (saved prompts, multi-step pipelines, in-app scheduling) ([6b2dd4c](https://github.com/tmac1973/haruspex/commit/6b2dd4c88d89f1028771bdbe31ad085fbc6ea773))
* **jobs:** scheduler + FIFO queue (phase 14 step 7) ([42ba17f](https://github.com/tmac1973/haruspex/commit/42ba17f9e9559538541bcb77b0a643df7793ae1f))
* **jobs:** single model-source selector + shared ModeSelector radio cards ([#170](https://github.com/tmac1973/haruspex/issues/170)) ([84c541d](https://github.com/tmac1973/haruspex/commit/84c541de3462e6fbeffdd3cf84a3a907e143d98d))
* **models:** Unsloth-only lineup, legacy migration, VRAM-aware context, correct sampling ([#142](https://github.com/tmac1973/haruspex/issues/142)) ([d005549](https://github.com/tmac1973/haruspex/commit/d005549ea62323e95e93fda578dbc4c0142244e8))
* phase-boundary verification, runner-executed, with repair cycles ([#190](https://github.com/tmac1973/haruspex/issues/190)) ([baafee4](https://github.com/tmac1973/haruspex/commit/baafee4f0b43bff1554a70b4f160e172c524f016))
* review remediation 2026-07 — responsiveness, UX recovery, a11y, provider descriptor ([#178](https://github.com/tmac1973/haruspex/issues/178)) ([f5f6888](https://github.com/tmac1973/haruspex/commit/f5f68888a72fc1f0d4bf9fd3fedbd4edf06e6ac8))
* **sandbox:** auto-install imports + de-stale tool descriptions ([65069b1](https://github.com/tmac1973/haruspex/commit/65069b1ccaee59d13e02a23e32ac5806fcf16b94))
* **sandbox:** bidirectional working-dir ↔ MEMFS sync before each run ([3d0e9b4](https://github.com/tmac1973/haruspex/commit/3d0e9b4201949a8fc7c6e5a90c0367863cdf535e))
* **sandbox:** bundle plotly.js so plotly renders with zero network ([79068ca](https://github.com/tmac1973/haruspex/commit/79068ca0a9f7dda87180e0dea6a70a6b1d7777df))
* **sandbox:** bundle pygame-ce/bokeh/altair workspace wheels (step 2) ([56f9344](https://github.com/tmac1973/haruspex/commit/56f9344893ac2df45a08fdb9b33764d84ff22de3))
* **sandbox:** bundle Pyodide stack locally + split install/exec timeout ([8516e21](https://github.com/tmac1973/haruspex/commit/8516e2158f6b90423b45a03cd026c1e7dd732c5b))
* **sandbox:** bundle Pyodide stack locally + split install/exec timeout ([6badfd2](https://github.com/tmac1973/haruspex/commit/6badfd20110a8d66f119b0955531c39c9454ae0f))
* **sandbox:** bundle requests + plotly for offline use ([e3a104b](https://github.com/tmac1973/haruspex/commit/e3a104bd09449d3ab8f687df3889ad04ccd5cba6))
* **sandbox:** gate legacy fs_write_pdf/pptx on sandbox setting; default off ([c084ea2](https://github.com/tmac1973/haruspex/commit/c084ea250d042945a3e08c7f32824708c78083d7))
* **sandbox:** iframe runtime MVP — protocol, manager, init.py (step 3) ([825895d](https://github.com/tmac1973/haruspex/commit/825895d9581ad36c31fa2fcf7875a0c6b311ee5b))
* **sandbox:** mirror memfs ↔ host writes, deletes, and workdir changes ([959df16](https://github.com/tmac1973/haruspex/commit/959df169955d04f044ef4e54802da0fb664a1aab))
* **sandbox:** patch builtins.open so native Python writes reach disk ([130a68c](https://github.com/tmac1973/haruspex/commit/130a68ca70c7292cfc3fe8347c39c0f2b45119b0))
* **sandbox:** pdf/pptx via fpdf2 + python-pptx in pyodide sandbox ([02dbbba](https://github.com/tmac1973/haruspex/commit/02dbbba164b6ed454ac7a1874a4c28ba5036643b))
* **sandbox:** pdf/pptx via python-pptx + fpdf2, behind sandbox toggle ([e3da620](https://github.com/tmac1973/haruspex/commit/e3da620d3d49dc63066cce81ca61b6aeb7c2a507))
* **sandbox:** per-chat approval modal before run_python ([55635cc](https://github.com/tmac1973/haruspex/commit/55635ccee5800812db5a8fcf1acc908496705c3d))
* **sandbox:** per-chat iframe pool with LRU (step 5) ([a117ccf](https://github.com/tmac1973/haruspex/commit/a117ccf3676e74855067c609058a7e2355819c13))
* **sandbox:** port FS bridge into iframe — save/delete/fetch/sync (step 4) ([9ef58f7](https://github.com/tmac1973/haruspex/commit/9ef58f72fab00e15d184be03a76dfc3e8bd48bd3))
* **sandbox:** render interactive HTML artifacts inline as srcdoc iframes (step E) ([05a9321](https://github.com/tmac1973/haruspex/commit/05a9321d4bf99ddf19616f620bea0fdf97178595))
* **sandbox:** restore Python session on chat switch via tool-call replay ([579815d](https://github.com/tmac1973/haruspex/commit/579815d4567d24986aceb0d7bf7e75fb877e6e68))
* **sandbox:** retry-on-ImportError for transitive deps ([e860ddd](https://github.com/tmac1973/haruspex/commit/e860ddd51577053fe762c7cb97c5b52e8dca805c))
* **sandbox:** route pyodide.http.pyfetch through Rust + app proxy ([c7f06c7](https://github.com/tmac1973/haruspex/commit/c7f06c731a89b7d28a90c2de1d5ef4c2732ca568))
* **sandbox:** ruff pre-run lint pass + compress failed run_python steps ([024eeee](https://github.com/tmac1973/haruspex/commit/024eeee064014f33c751e39d94773761734e2ce1))
* **sandbox:** ruff pre-run lint pass + compress failed run_python steps ([1d4acf7](https://github.com/tmac1973/haruspex/commit/1d4acf7a18c0750768bada18f36ed40a6c3c13f0))
* **sandbox:** Run-again + Cancel buttons on run_python steps (step F) ([401a364](https://github.com/tmac1973/haruspex/commit/401a364aa648f8c224f64c5c020af51224533098))
* **sandbox:** settings panel — enable toggle, approval mode, timeout ([5d73b9f](https://github.com/tmac1973/haruspex/commit/5d73b9f719ed418f76a9f6e8f08c21ce1180539e))
* **sandbox:** spike pygame-ce in Tauri iframe (step 1) ([fc5cc6c](https://github.com/tmac1973/haruspex/commit/fc5cc6c57e7d52d08fdf77ed9e78e9e85238099b))
* **sandbox:** swap run_python / install_package / reset to IframePool (step 6) ([ab5e084](https://github.com/tmac1973/haruspex/commit/ab5e084be6690297a6bd6c1c4408bbd2444fc6da))
* **sandbox:** syntax-highlight run_python code in tool-step view + global hljs theme ([75c5420](https://github.com/tmac1973/haruspex/commit/75c5420b70fea67016d734a0b42f9dec6228ad24))
* **sandbox:** system-prompt file-I/O guidance, gated on sandbox + workdir ([b6a6a43](https://github.com/tmac1973/haruspex/commit/b6a6a43eb8685fb4b6c7ae9b0eac050efe914d21))
* **search:** add Startpage + Yahoo (Google/Bing-sourced) to the no-browser rotation ([#151](https://github.com/tmac1973/haruspex/issues/151)) ([15119d8](https://github.com/tmac1973/haruspex/commit/15119d8fd8dbcf4866d6d73ddd3f6e62f4942720))
* **search:** track per-engine statistics with session + lifetime scopes ([c94562d](https://github.com/tmac1973/haruspex/commit/c94562da9f005a0da5fbc97d26d33f5d3445fdc9))
* **server:** capture llama-server crash telemetry ([2205bed](https://github.com/tmac1973/haruspex/commit/2205bedb94922415b0d78768811a8c388678b676))
* **server:** capture llama-server crash telemetry ([f2be88b](https://github.com/tmac1973/haruspex/commit/f2be88be29d31a1247ae74129605dab71008f8b5))
* **settings:** add custom system prompt and make gear icon toggle ([89f76d8](https://github.com/tmac1973/haruspex/commit/89f76d8d3ff97da4798dcb9628102166d5937c3f))
* **settings:** add custom system prompt and make gear icon toggle ([9d7861e](https://github.com/tmac1973/haruspex/commit/9d7861e892f5db7ed4387d8302c8c0e155b8b2ad))
* **settings:** organize into left-rail categories and add per-tab log clear ([7f75d8c](https://github.com/tmac1973/haruspex/commit/7f75d8cc8e22e410851d068bf949d52ec42738a7))
* **settings:** organize into left-rail categories and add per-tab log clear ([7e0dff1](https://github.com/tmac1973/haruspex/commit/7e0dff1cd542fff2ed303d0964cbfc1134b35a0f))
* settle the autonomous-coding verification contract in preflight ([#188](https://github.com/tmac1973/haruspex/issues/188)) ([a6e3c25](https://github.com/tmac1973/haruspex/commit/a6e3c25ab0ad63561d0cc19d4fa1fef22e1884c2))
* Shell-assistant Code mode — coding agent in the live terminal ([#132](https://github.com/tmac1973/haruspex/issues/132)) ([bb7eef6](https://github.com/tmac1973/haruspex/commit/bb7eef627e8f5ae2f781a1e4c1e1367568719f86))
* **shell, audio:** mic input in shell + F1/F2/F3 global media hotkeys ([b00557f](https://github.com/tmac1973/haruspex/commit/b00557ff99dd89eec298f96a424e035a9fd16d33))
* **shell:** add Shell tab with PTY-backed terminal (15a) ([258b549](https://github.com/tmac1973/haruspex/commit/258b5491babfbcbe7fce18fbc1686fc90228ca72))
* **shell:** chat composer in the sidebar for follow-up questions ([5b244af](https://github.com/tmac1973/haruspex/commit/5b244afce95badd7dc8c0512f7a129b6f7ec742b))
* **shell:** collapse the attached shell preamble in user messages ([57e497e](https://github.com/tmac1973/haruspex/commit/57e497e91132558fbf5b0197fcd89fe6e5eceb40))
* **shell:** confirm dialog when Run is clicked on a risky command ([ce81085](https://github.com/tmac1973/haruspex/commit/ce8108544c2a4ae547511806afab73e2c72308a5))
* **shell:** Ctrl+\` swaps focus between terminal and assistant composer ([3d03c49](https://github.com/tmac1973/haruspex/commit/3d03c4948b7b2737ce498d53ff8069f055a04822))
* **shell:** Ctrl+Shift+C / Ctrl+Shift+V + right-click copy/paste ([a534eaf](https://github.com/tmac1973/haruspex/commit/a534eafff2475389c20917935366480077459a5b))
* **shell:** default Run auto-submit to off ([1eb72c0](https://github.com/tmac1973/haruspex/commit/1eb72c0ab2b6dc190651d17304d1d711380fd039))
* **shell:** detach shell tabs into their own windows ([c8b4e7d](https://github.com/tmac1973/haruspex/commit/c8b4e7d9f7fabedecdde017d36ef53aeb6722b87))
* **shell:** head+tail truncate captured outputs before sending to model ([85a5c5b](https://github.com/tmac1973/haruspex/commit/85a5c5bebea4fe07070e0d61ba461b59b080cedc))
* **shell:** in-distro WSL context capture (17d-2) ([7d4f261](https://github.com/tmac1973/haruspex/commit/7d4f261d3b41108173d09d4d371fd1e515b07005))
* **shell:** interactive terminal control tools (input, read, interrupt) ([#143](https://github.com/tmac1973/haruspex/issues/143)) ([c02eccc](https://github.com/tmac1973/haruspex/commit/c02ecccf6315e6d423b3aedbe005ab2af97c130d))
* **shell:** macOS port + in-flight capture + overflow hint ([feeafda](https://github.com/tmac1973/haruspex/commit/feeafda5370605bbb5ad5306d676fbfc001a6b4c))
* **shell:** macOS port + in-flight capture + overflow hint ([33d6479](https://github.com/tmac1973/haruspex/commit/33d647903580e4a9392f5ae7a3dbc6f346553a97))
* **shell:** multiple shell tabs + detachable windows on a shared inference queue ([b1c1c62](https://github.com/tmac1973/haruspex/commit/b1c1c626b78c470f58e80a0a04d5c99282d61934))
* **shell:** multiple shell tabs in one window ([577eb71](https://github.com/tmac1973/haruspex/commit/577eb717b0eb335f7fc43370bd19235fc45c7eac))
* **shell:** open the Shell tab on Windows (17e) ([bcd01d8](https://github.com/tmac1973/haruspex/commit/bcd01d801acb163d0080e07372886b8641316ef9))
* **shell:** opt-in fs_write + tighten shell-mode tool allowlist ([7d77013](https://github.com/tmac1973/haruspex/commit/7d770139a579c1958ad039de855613f76aa6e301))
* **shell:** OSC 133 integration + context capture + debug overlay (15b) ([76dd5af](https://github.com/tmac1973/haruspex/commit/76dd5af51be79e9086f8bb4607dcb7497fc3913c))
* **shell:** paste button + risky-command badges (15e) ([977ba83](https://github.com/tmac1973/haruspex/commit/977ba837ebb537f9277b4ddbdb182eb0e489da3f))
* **shell:** per-command Run buttons + optional Run auto-submit ([9ac1d07](https://github.com/tmac1973/haruspex/commit/9ac1d0734d5b25d9d077dc68769d8dd4a290568a))
* **shell:** per-command Run buttons + optional Run auto-submit ([b6f13ec](https://github.com/tmac1973/haruspex/commit/b6f13ec0619191c2b0a7db6572856dd8a5ba6923))
* **shell:** placeholder card on non-Linux until cross-platform lands ([1a3479a](https://github.com/tmac1973/haruspex/commit/1a3479ae1d2b7c23694636e2ca79e03bf0792e1f))
* **shell:** PowerShell OSC 133 injection (17c capture) ([b36063f](https://github.com/tmac1973/haruspex/commit/b36063ffac9338e9c8cf60c71f8cd9c349deaf11))
* **shell:** PowerShell variant of the Code-mode prompt (17c-3) ([f63a8b4](https://github.com/tmac1973/haruspex/commit/f63a8b4bfe5b03b6329d30b02a82d003c3dea720))
* **shell:** PowerShell/Windows risk patterns ([d2d73c3](https://github.com/tmac1973/haruspex/commit/d2d73c31d60e2a072dbf67685f311298a2ea17f1))
* **shell:** route spawn through ShellSelection (17b spawn rewiring) ([08b24bb](https://github.com/tmac1973/haruspex/commit/08b24bb63caa5d0856681d22e281078f04498388))
* **shell:** Run button on suggested commands + resizable sidebar ([85602d9](https://github.com/tmac1973/haruspex/commit/85602d917c9b477a1dc2161395ed6c77969995a0))
* **shell:** run_command background/watch options + 30s default timeout ([#149](https://github.com/tmac1973/haruspex/issues/149)) ([6a10614](https://github.com/tmac1973/haruspex/commit/6a106146096d64e5e895a9bbac5ca42375db80bc))
* **shell:** Run/Paste cards for PowerShell suggestions ([a187ae6](https://github.com/tmac1973/haruspex/commit/a187ae6bf3dec6527e86704454d1f81e6ef80ebd))
* **shell:** settings section + README + maintenance.md docs (15f) ([d54e06a](https://github.com/tmac1973/haruspex/commit/d54e06a5e32a11e21687fc1845a9b7f48f36f6e8))
* **shell:** shell agent driver + chat sidebar (15d) ([90ae325](https://github.com/tmac1973/haruspex/commit/90ae325b1ccfb0eef6991ea9fa1758efeaa3db17))
* **shell:** shell catalog + selection model (17b backend) ([2da2536](https://github.com/tmac1973/haruspex/commit/2da2536614b6d1d82c01b0a7d0ca92b1bbd72f30))
* **shell:** shell picker UI (completes 17b) ([fbd24bb](https://github.com/tmac1973/haruspex/commit/fbd24bb2ba188e2e5ea480a68aa8b80994619a43))
* **shell:** Shell tab — interactive terminal + AI troubleshooting sidebar ([cfa3129](https://github.com/tmac1973/haruspex/commit/cfa31292e338d8ec9895a85178b9ef4e1145e163))
* **shell:** shell-mode fs_read tools with absolute paths (15c) ([00d6780](https://github.com/tmac1973/haruspex/commit/00d678032201a2dcb3bb11d68fd41442b832a398))
* **shell:** show tokens/second on shell assistant messages ([f28c2fe](https://github.com/tmac1973/haruspex/commit/f28c2fe18275690321ad73ffacae138fb8c11ac5))
* **shell:** show tokens/second on shell assistant messages ([812ac32](https://github.com/tmac1973/haruspex/commit/812ac320b490ad7d0484861b572ccdaa5d47f169))
* **shell:** submit recent commands to assistant (button + F4); Run auto-submit off by default ([de21a5a](https://github.com/tmac1973/haruspex/commit/de21a5ad5c297c775ba10b3b827468b58a42c720))
* **shell:** submit recent commands to assistant via button + F4 ([2da9c8c](https://github.com/tmac1973/haruspex/commit/2da9c8c660389a726e11066452a684d277ab1cc0))
* **shell:** surface tool calls in the sidebar like the chat tab does ([b095300](https://github.com/tmac1973/haruspex/commit/b0953003e752821341900f39fad6f1642f123e2d))
* **shell:** Windows PTY baseline behind a dev flag (17a) ([a9cd117](https://github.com/tmac1973/haruspex/commit/a9cd1174a2b88725ea52b2c16b83292459b6a328))
* **shell:** Windows session context for the badge (17c-2) ([c6831bc](https://github.com/tmac1973/haruspex/commit/c6831bc4aae2484753317736e6a023c28e3263b7))
* **shell:** WSL OSC 133 injection (17d-1) ([df00cbc](https://github.com/tmac1973/haruspex/commit/df00cbc84a88e37f24555c4ebdb7a29cc0f3024a))
* **tools:** honest failure icons + absorb avoidable first-try failures ([3b62ab2](https://github.com/tmac1973/haruspex/commit/3b62ab2912ecef98a2f4e98e5c85b205f032aa00))
* **tools:** honest failure icons + absorb avoidable first-try tool failures ([81acebd](https://github.com/tmac1973/haruspex/commit/81acebd1e6d5922f55626e608afb2bf9850f261e))
* **ui:** add AI safety notice to the startup dialog ([22aa6ab](https://github.com/tmac1973/haruspex/commit/22aa6ab357fd4276d760280b98feec2b2075ea44))
* **ui:** add pretty/raw toggle to debug and tools log viewers ([e5af341](https://github.com/tmac1973/haruspex/commit/e5af3412e0a624eeca5388a714d1428d07baae46))
* **ui:** keyboard-shortcuts help modal (F1) + document hotkeys ([5317a4e](https://github.com/tmac1973/haruspex/commit/5317a4eba448dae4e7d1f7d550f8b9b158af927e))
* **ui:** keyboard-shortcuts help modal (F1) + document hotkeys ([c2f96f4](https://github.com/tmac1973/haruspex/commit/c2f96f418b83dc2142f153805dfd927c952a21e9))
* **ui:** per-step log accordion + collapsible failed code blocks ([16611ba](https://github.com/tmac1973/haruspex/commit/16611bac80812c3b441ee1517fda32f1c8c94bd7))
* **ui:** pretty/raw toggle for debug and tools log viewers ([abdb62d](https://github.com/tmac1973/haruspex/commit/abdb62d44d5f574b21598ea23231281c9111bcd3))
* **ui:** show "new version available" link and indent code/log boxes ([98cb72e](https://github.com/tmac1973/haruspex/commit/98cb72ee3c84b50e8a74d1eb1785e2f3f5e89f50))
* **ui:** show per-message tokens-per-second indicator ([f0dc987](https://github.com/tmac1973/haruspex/commit/f0dc9875f4c6850a3738f15afb8dc83c2f8a00c5))
* **ui:** show remote model in header badge + reasoning toggle ([4e3c9b6](https://github.com/tmac1973/haruspex/commit/4e3c9b62a0be720facfb4c81eea5d19119b7c70e))
* **ui:** show remote model name in header badge and add reasoning toggle ([d86b54f](https://github.com/tmac1973/haruspex/commit/d86b54fb5f2dea5a4c19ed10cef40a6762be2ea2))
* **ui:** warm-neutral + teal UI refresh (design handoff implementation) ([#179](https://github.com/tmac1973/haruspex/issues/179)) ([ae744e4](https://github.com/tmac1973/haruspex/commit/ae744e493a45d7d1f8850bc9cd4c961a83f7c637))
* **vision:** terminal snapshot tool + drag-drop/paste image attachments ([#144](https://github.com/tmac1973/haruspex/issues/144)) ([29ff67b](https://github.com/tmac1973/haruspex/commit/29ff67b8d6b7db6cd7cc5e2ca00e84ba67aed117))
* **workdir:** make working directory a global persisted state ([4b0e7a6](https://github.com/tmac1973/haruspex/commit/4b0e7a6d5487ddaa19cd20ee5e795dc61a44b941))
* **workspace:** Workspace tab + active-chat wiring (step 7) ([41e78aa](https://github.com/tmac1973/haruspex/commit/41e78aa86efcb5c583be14179b56dac754a696b3))


### Bug Fixes

* **agent:** cancel takes effect mid-tool, not just between tool calls ([7de9c22](https://github.com/tmac1973/haruspex/commit/7de9c22cf28961b347e17cd51f858cdc5570e52a))
* **agent:** don't count blocked web reads against the turn budget ([#166](https://github.com/tmac1973/haruspex/issues/166)) ([872956f](https://github.com/tmac1973/haruspex/commit/872956fa34ab47f6b14f9942b3d5e36f16b27193))
* **agent:** re-stream when post-tools reply is thinking-only ([#126](https://github.com/tmac1973/haruspex/issues/126)) ([f40aadc](https://github.com/tmac1973/haruspex/commit/f40aadcd9e35fed08a478f7fcc1a1ccc57ed8315))
* **agent:** recover when model narrates instead of acting after nudges ([2cde23c](https://github.com/tmac1973/haruspex/commit/2cde23cf23e0a0c0a60c3fc9e2866a8634320bb1))
* **agent:** recover when model narrates instead of acting after nudges ([90fe2fb](https://github.com/tmac1973/haruspex/commit/90fe2fb2ca3e08e1828f6636eb22d7c056830efc))
* **agent:** salvage tool calls Qwen3 wraps in &lt;tool_call&gt;&lt;function=...&gt; form ([f26146b](https://github.com/tmac1973/haruspex/commit/f26146bc8d9b1cfa5ee6d276bc83c71474ae6807))
* **agent:** survive sidecar restarts + trim research_url context bloat ([#184](https://github.com/tmac1973/haruspex/issues/184)) ([a89da35](https://github.com/tmac1973/haruspex/commit/a89da35f79c4ea534fd5055b5da7162862af44c6))
* **audio:** defensive guards against USB hot-swap state corruption ([929b807](https://github.com/tmac1973/haruspex/commit/929b8070857fcb24f807cc9bdb322fedf5492956))
* **audio:** F2/F3 media hotkeys no-op in packaged builds ([6ed5445](https://github.com/tmac1973/haruspex/commit/6ed544536f6fed7201bd4daec2e23ff58603ea5d))
* **audio:** F2/F3 media hotkeys no-op in packaged builds ([1254d80](https://github.com/tmac1973/haruspex/commit/1254d800c85c03a7ef69f20a61b250e3cdffa933))
* **audio:** restore default_input_device for the System Default case ([8289fff](https://github.com/tmac1973/haruspex/commit/8289fffd666bbf7558a69388a5ebb63a23d4895b))
* **backend:** transactional replace_messages, non-blocking rate limit ([e2f7115](https://github.com/tmac1973/haruspex/commit/e2f71151f6f6412c6d397a82df8bf8d28fe50019))
* **build:** emit web workers as ES modules ([ba6b099](https://github.com/tmac1973/haruspex/commit/ba6b099b2d318926ac925ef6879b63e44a46bb99))
* **build:** emit web workers as ES modules ([576a9b6](https://github.com/tmac1973/haruspex/commit/576a9b6bbe4c8dd11a6ecd8cb3d813aea1748248))
* **build:** exclude src-tauri from the Vite dev watcher (Windows EBUSY) ([868a7fa](https://github.com/tmac1973/haruspex/commit/868a7fae6c2c0833ddb1cd9c7ac0e321d2b69d70))
* **build:** ship a working Vulkan backend in Linux releases ([#122](https://github.com/tmac1973/haruspex/issues/122)) ([faae5e1](https://github.com/tmac1973/haruspex/commit/faae5e18e3b601b7b08d8f99837ed0f15045d240))
* **build:** silence ts-rs serde-attr parse warnings ([933b22f](https://github.com/tmac1973/haruspex/commit/933b22faa1c299d7fb3c4198dc78560068b46a66))
* **chat:** attach dropped images via Tauri's native drag-drop event ([#146](https://github.com/tmac1973/haruspex/issues/146)) ([4d475a2](https://github.com/tmac1973/haruspex/commit/4d475a25a396fc98db317ece013557c18cf0cfc6))
* **chat:** remap per-message artifacts on compaction and persist them ([521b475](https://github.com/tmac1973/haruspex/commit/521b475a1c52deec5b5ed28c4638d012d786aed8))
* **chat:** stop a stray image drop from navigating the webview (app hang) ([#145](https://github.com/tmac1973/haruspex/issues/145)) ([49161d0](https://github.com/tmac1973/haruspex/commit/49161d02f65bd9244839e5aa9224c2fc4c1816d6))
* **ci:** strip CRLF from Windows pyodide wheel resolver ([#120](https://github.com/tmac1973/haruspex/issues/120)) ([a05d73f](https://github.com/tmac1973/haruspex/commit/a05d73f2ff2a6acba1b05e212d324d2f25c45610))
* correctness batch — IMAP injection, download integrity, docx extraction, compaction artifacts ([bbd2333](https://github.com/tmac1973/haruspex/commit/bbd23331a9f114a8d7d5efedd1389e6d4196e8ae))
* debug-log digests + guided-planning phase-file validation ([#186](https://github.com/tmac1973/haruspex/issues/186)) ([a03a4fa](https://github.com/tmac1973/haruspex/commit/a03a4fadb3e6148afa3dc0fc167a523f07e5f87a))
* **email:** sanitize IMAP SEARCH filter values against CRLF injection ([21ed7f8](https://github.com/tmac1973/haruspex/commit/21ed7f82bcd145a445b7f26058d592868cff4c27))
* **fs-tools:** reject '..' traversal lexically so it holds on Windows ([7521030](https://github.com/tmac1973/haruspex/commit/75210305087041464d7cd0f9bb3b292f9f5855c4))
* **fs:** docx tag-boundary scanning, entity decoding, xlsx NaN cells ([6cc4f59](https://github.com/tmac1973/haruspex/commit/6cc4f59331221cba099c36a708290e70f92c092e))
* **guided-planning:** escape hatch, write verification, complete plans ([#165](https://github.com/tmac1973/haruspex/issues/165)) ([cf16373](https://github.com/tmac1973/haruspex/commit/cf1637347ea75f901dd7a27fd2627ebc8772eb25))
* **hardware:** detect NVIDIA VRAM and avoid iGPU shadowing ([362b30f](https://github.com/tmac1973/haruspex/commit/362b30f6569bb7a3df695e28dd17e3e31c0cc7b0))
* **hooks:** make pre-commit work from GUI git clients ([732f90a](https://github.com/tmac1973/haruspex/commit/732f90a63feeb26db1161baa11ddedfdcb78d57a))
* **inference:** save remote server URLs to the list without requiring Add ([#183](https://github.com/tmac1973/haruspex/issues/183)) ([bc279e8](https://github.com/tmac1973/haruspex/commit/bc279e8e6014de2a8e4d36973b0e0c57478b4920))
* **inference:** stop leaking Qwen sampling params and template kwargs to non-Qwen remote models ([#172](https://github.com/tmac1973/haruspex/issues/172)) ([2c77bfe](https://github.com/tmac1973/haruspex/commit/2c77bfe7ef32b9e99835ae8144166cab1e2371ba))
* **jobs:** clipped Run button + unreadable schedule dropdown ([1fc497a](https://github.com/tmac1973/haruspex/commit/1fc497a105471584c8d1ab253ba878fc9fed64ae))
* **jobs:** Run button enables on first save; working dir is optional ([8b8f140](https://github.com/tmac1973/haruspex/commit/8b8f14023c7102372615d64f9c7fef33cb4549db))
* **jobs:** Run button enables on first save; working dir is optional ([efadcf5](https://github.com/tmac1973/haruspex/commit/efadcf5fd9962f551da99bb9542704a299f7a335))
* **jobs:** run buttons hidden by shell-button CSS class collision ([5966cf4](https://github.com/tmac1973/haruspex/commit/5966cf40edca3ce027d106e4869bcdc6d0771a58))
* **jobs:** run buttons hidden by shell-button CSS class collision ([d0e7319](https://github.com/tmac1973/haruspex/commit/d0e73199b454f480ee3066b9dd762a8b86a056e9))
* **models:** persist active model selection across reloads ([42a2799](https://github.com/tmac1973/haruspex/commit/42a279907b9fad76e3ab5757a68b54a1004a4685))
* **models:** persist active model selection across reloads ([5274c31](https://github.com/tmac1973/haruspex/commit/5274c31c48b79f8343585567edd7a92fd5898d5e))
* **models:** verify downloads and restart resume when Range is ignored ([5f1fb6e](https://github.com/tmac1973/haruspex/commit/5f1fb6e858d8a5a7df2046c0c34f4e7ede274d12))
* **parser:** guard structured tool-call JSON parsing ([6b4e4c7](https://github.com/tmac1973/haruspex/commit/6b4e4c7858d528d59f4474ee13e190781d91e137))
* **proxy:** reddit-aware fetch fallback — old.reddit first, dead .json rewritten ([#177](https://github.com/tmac1973/haruspex/issues/177)) ([51d78b9](https://github.com/tmac1973/haruspex/commit/51d78b9a84da51198316fedece78644d0d61ee22))
* **proxy:** truncate fetched page text on a char boundary ([04c86ef](https://github.com/tmac1973/haruspex/commit/04c86ef98c4f059fa0e59d194bb966f3a905f2ba))
* **proxy:** truncate fetched page text on a char boundary ([f544809](https://github.com/tmac1973/haruspex/commit/f544809f042ab8e0bc25c15b35ac856ff7e72ccf))
* **refactor:** address code-review findings on the dedup branch ([673c311](https://github.com/tmac1973/haruspex/commit/673c3115fb6541d843466c03836332b0021ea892))
* **sandbox:** bump default sandbox timeout 30s → 60s ([364ad89](https://github.com/tmac1973/haruspex/commit/364ad899e842556fdcb2f8f6fd64a90098fec8da))
* **sandbox:** collapse pyfetch-pattern error to single line — \n breaks Python parser ([235bc24](https://github.com/tmac1973/haruspex/commit/235bc24d476e8dda3c7d36fd3ef3ac5e68bf43ae))
* **sandbox:** enforce sandbox switch at execution + recover stuck inference ([#160](https://github.com/tmac1973/haruspex/issues/160)) ([06a5ad6](https://github.com/tmac1973/haruspex/commit/06a5ad6a6480652a66d2db409f171fd4898992e3))
* **sandbox:** include full pyfetch await pattern in the urllib-blocked error ([1159c7d](https://github.com/tmac1973/haruspex/commit/1159c7d70159445e549d29b66218e7e645b5849a))
* **sandbox:** label bundled-wheel installs honestly ([1ba00c4](https://github.com/tmac1973/haruspex/commit/1ba00c492e682dfab527fd1c72694bfb19403c4c))
* **sandbox:** label bundled-wheel installs honestly ([8955492](https://github.com/tmac1973/haruspex/commit/89554920595c4e6d999dcf12e2ef6f682b785a2b))
* **sandbox:** make inline chart/figure display reliable ([#124](https://github.com/tmac1973/haruspex/issues/124)) ([1b105c6](https://github.com/tmac1973/haruspex/commit/1b105c6780bc7ee8ec37f72f3c414918d8188444))
* **sandbox:** make synchronous requests/urllib reach arbitrary URLs ([a7bfc9d](https://github.com/tmac1973/haruspex/commit/a7bfc9dd4cf403bab2afc623eae03d972b3d7ac3))
* **sandbox:** make synchronous requests/urllib reach arbitrary URLs ([ff0ec9b](https://github.com/tmac1973/haruspex/commit/ff0ec9b09d787dea4eade0db95032628584f634c))
* **sandbox:** package auto-install + phantom-load detector ([18275d8](https://github.com/tmac1973/haruspex/commit/18275d808a02d5b98523f78b1ed57e003876e2ae))
* **sandbox:** patch urllib/requests/httpx via pyodide-http so native HTTP works ([192e86e](https://github.com/tmac1973/haruspex/commit/192e86e3b9a324771c5ff7016ad958cdea8c5517))
* **sandbox:** point read-side FileNotFoundError at fs_read_* tools ([688f5e3](https://github.com/tmac1973/haruspex/commit/688f5e380dde78a0659c933c180a8a483d617808))
* **sandbox:** point urllib at pyfetch with a specific error when proxy on ([e32a726](https://github.com/tmac1973/haruspex/commit/e32a726e8d81ee3e724400bfe939cbb3739da270))
* **sandbox:** route script-bearing _repr_html_ to workspace, not chat ([33cf158](https://github.com/tmac1973/haruspex/commit/33cf158edf9805e622f83c299cf7478be3d7467c))
* **sandbox:** skip pyodide-http patch when an app proxy is configured ([1f21d7b](https://github.com/tmac1973/haruspex/commit/1f21d7b57f21a72bd6c78ac549fc8c20b3e44223))
* **sandbox:** start the exec timeout after boot, fix tool-doc default ([f917583](https://github.com/tmac1973/haruspex/commit/f917583c80c23afe76282020a8816bc2064f40f0))
* **sandbox:** stop run_python lint-failure loops ([326ea92](https://github.com/tmac1973/haruspex/commit/326ea92fd78caf2dd95874cff0161bd791b377ed))
* **sandbox:** stop run_python lint-failure loops ([8ed6b07](https://github.com/tmac1973/haruspex/commit/8ed6b0763c4db71cdb2f7ac78a8d595c247d95dd))
* **sandbox:** vendor pyodide-http wheel for offline boot ([405000c](https://github.com/tmac1973/haruspex/commit/405000c7decbf5e61e3cbc3174c7a928bea53801))
* **scripts:** dev-setup.sh delegates sidecar build to build-sidecars.sh ([631f0ff](https://github.com/tmac1973/haruspex/commit/631f0ffcef89a52525969ad03ed1c1604f116a50))
* **scripts:** don't let rustup's stderr abort windows-setup.ps1 ([8d5b42d](https://github.com/tmac1973/haruspex/commit/8d5b42d26c76ee39220058ce704dfb84d7b9bee3))
* **scripts:** install LLVM/libclang in windows-setup.ps1 for koko build ([0fa4db9](https://github.com/tmac1973/haruspex/commit/0fa4db92c68d19d55cc9ed32c2467f232ffa9deb))
* **scripts:** make Pyodide wheel resolver work on Windows ([4f5e9ad](https://github.com/tmac1973/haruspex/commit/4f5e9ada197de6b4d88abd00724ac1d3fbe376d4))
* **scripts:** make windows-setup.ps1 pure ASCII ([05169f0](https://github.com/tmac1973/haruspex/commit/05169f02496a8a275c578418cd7d775121467dd5))
* **search:** stop the auto-rotation rate-limit death spiral ([#150](https://github.com/tmac1973/haruspex/issues/150)) ([2c29de7](https://github.com/tmac1973/haruspex/commit/2c29de7961e89da3c5eba490a8872d510672fd4d))
* **security:** re-validate redirect hops and close IPv6 SSRF gaps ([8748277](https://github.com/tmac1973/haruspex/commit/8748277d69b237f0b7da4e3a94ce5f093d23ef5f))
* **security:** sanitize LLM-derived HTML before render and set a CSP ([ed4d38d](https://github.com/tmac1973/haruspex/commit/ed4d38deb329738880ac5c8ec3c851cd25af10fb))
* **security:** truncate user-derived text on char boundaries ([929e8f8](https://github.com/tmac1973/haruspex/commit/929e8f8584d989478cf07ef92395b7e46f0644ef))
* **security:** XSS sanitization + CSP, SSRF redirect validation, char-boundary panics ([0de44a3](https://github.com/tmac1973/haruspex/commit/0de44a3d7c7436a7eae8bbcc788b9453f6947919))
* **shell:** always set TERM=xterm-256color for PTY sessions ([837d47d](https://github.com/tmac1973/haruspex/commit/837d47ddd4b9ba6bd4707f63da423059e08853bd))
* **shell:** always set TERM=xterm-256color for PTY sessions ([e6b23bc](https://github.com/tmac1973/haruspex/commit/e6b23bcd899fbd4803a24d89b68c8b2f337c1b6f))
* **shell:** attach in-flight session scrollback to assistant context ([#161](https://github.com/tmac1973/haruspex/issues/161)) ([6c80c35](https://github.com/tmac1973/haruspex/commit/6c80c356b431b0565f31f5eb2c1ced6544807d0b))
* **shell:** badge now distinguishes "no integration" from "no captures yet" ([00c664e](https://github.com/tmac1973/haruspex/commit/00c664e665779837f507e504469792751150d6e9))
* **shell:** bash hook was eating the C marker for every command after the first ([6b1500a](https://github.com/tmac1973/haruspex/commit/6b1500a04513ac43b518c49d284848f5633b1762))
* **shell:** bias assistant toward web search over training data ([61d8625](https://github.com/tmac1973/haruspex/commit/61d862545277fe144f6d35594017f01cec895d54))
* **shell:** buffer PTY output until the frontend attaches to avoid a startup-query race ([f6607d3](https://github.com/tmac1973/haruspex/commit/f6607d3ad431d11226496ff65c95ffa34c651342))
* **shell:** capture the real command line and post-command cwd ([43c353f](https://github.com/tmac1973/haruspex/commit/43c353f780d9dc2cfd9089fadb48aa0fe0ced356))
* **shell:** clean scrollback handoff + hotkeys in detached windows ([cfa663f](https://github.com/tmac1973/haruspex/commit/cfa663fa923d44474b6b026bf5053e93822bb4ba))
* **shell:** clippy while_let_loop on completed_command_count ([55e1383](https://github.com/tmac1973/haruspex/commit/55e1383912478b5fc6763b9a6cd89c3bc616d53d))
* **shell:** coach the agent away from read-retry loops + double-writes ([596fffc](https://github.com/tmac1973/haruspex/commit/596fffcd5b916f7be1e7299de545318c62bab53b))
* **shell:** correct garbled fish capture on the Shell tab ([d0aa9f9](https://github.com/tmac1973/haruspex/commit/d0aa9f9db74fe239bf41012bf7fd040008e7630a))
* **shell:** correct garbled fish capture on the Shell tab ([a44d039](https://github.com/tmac1973/haruspex/commit/a44d03996bfc632f5f380b2afd989186ed82d4dd))
* **shell:** dispose xterm input listeners on restart (keystroke duplication) ([00afccb](https://github.com/tmac1973/haruspex/commit/00afccb6dbe7629a34cad64c105ff122ed5ce91d))
* **shell:** harden bash hook and scope context menu to the terminal pane ([5eba813](https://github.com/tmac1973/haruspex/commit/5eba81356e5888509becd258f93646b9fb769edb))
* **shell:** keep PTY alive when opening settings ([5e0a566](https://github.com/tmac1973/haruspex/commit/5e0a5666af3427374d37ee3eaf875bd57819eb22))
* **shell:** launch PowerShell with -ExecutionPolicy Bypass for the hook ([811c887](https://github.com/tmac1973/haruspex/commit/811c887da896085763f047f80d677dfc4d47d927))
* **shell:** make paste reliable and add middle-click primary paste ([#125](https://github.com/tmac1973/haruspex/issues/125)) ([731ba4f](https://github.com/tmac1973/haruspex/commit/731ba4fd25d1edb595f30e5bde4f380162bb14b4))
* **shell:** map WSL /mnt paths to Windows for the fs tools ([56c8815](https://github.com/tmac1973/haruspex/commit/56c8815e531be1d84d688aa59e9356c4ba4e4175))
* **shell:** normalize Windows cwd from OSC 7 ('/C:/...' -&gt; 'C:\\...') ([2f2f710](https://github.com/tmac1973/haruspex/commit/2f2f710c5a8de895ae540f4dd2273a96eaaec529))
* **shell:** open the sidebar the moment F2 starts recording ([518dce1](https://github.com/tmac1973/haruspex/commit/518dce10afaf603cfb19573d504e6782f06ba3b3))
* **shell:** persist PTY across settings + search-first assistant prompt ([b401045](https://github.com/tmac1973/haruspex/commit/b4010455515d938c32b03fd8a7cd56334d81f737))
* **shell:** persist PTY across tab switches ([483da0e](https://github.com/tmac1973/haruspex/commit/483da0e933379095a655153c98058ddd37a290aa))
* **shell:** proportion detached window to terminal + sidebar ([a55566c](https://github.com/tmac1973/haruspex/commit/a55566ce1573bc43a4760f6510e6a2f4677893ff))
* **shell:** release F1/F2/F3 from xterm so app hotkeys actually fire ([b92228c](https://github.com/tmac1973/haruspex/commit/b92228cfd76a99027e8ef3f4cea7879a276884c1))
* **shell:** reset command session-approval on New Chat ([47da02a](https://github.com/tmac1973/haruspex/commit/47da02af98d0988fa5428dca8745873a1f237c4e))
* **shell:** resolve relative fs_* paths against the shell cwd ([f04e838](https://github.com/tmac1973/haruspex/commit/f04e838743e9f1c687cbbad4887afe19c8eec5fc))
* **shell:** resolve relative fs_* paths against the shell cwd ([1f5f198](https://github.com/tmac1973/haruspex/commit/1f5f1987d2eb271f47c2576d21796fdaf024f31e))
* **shell:** resolve shell-integration dir from source first in dev ([c641375](https://github.com/tmac1973/haruspex/commit/c641375b0e0b73d333e3d1d575522a78ef3f4f1c))
* **shell:** Restart shell button + integration status badge ([8edc254](https://github.com/tmac1973/haruspex/commit/8edc25403dc45b8d8530a5e6e6328483464e4bd4))
* **shell:** retain tool-call history across Code-mode turns ([f2f1309](https://github.com/tmac1973/haruspex/commit/f2f13092b2221281e3987012f7a0927c8ae4837d))
* **shell:** route one-shot run_command through the session shell (17d-3) ([395b24d](https://github.com/tmac1973/haruspex/commit/395b24d604911deaa2169c94f00c19119b3c7ff1))
* **shell:** Run auto-submit on long-lived/detached sessions ([409046d](https://github.com/tmac1973/haruspex/commit/409046d1a516ceb6a8f1b4023ef15741170affdb))
* **shell:** run clipboard reads off the main thread ([#128](https://github.com/tmac1973/haruspex/issues/128)) ([77f61e1](https://github.com/tmac1973/haruspex/commit/77f61e1b35c05c33b42662a3de69ad6496131d03))
* **shell:** show thinking indicator while a turn is processing ([7ef2653](https://github.com/tmac1973/haruspex/commit/7ef26532d051aa6e5ecf73481b9013d8ca3a9c25))
* **shell:** stop the assistant sidebar from freezing on long Code-mode sessions ([#176](https://github.com/tmac1973/haruspex/issues/176)) ([e73e179](https://github.com/tmac1973/haruspex/commit/e73e179431794cb1aedffd1442b829d111ae45e5))
* **shell:** strip AppImage libs from spawned shell's LD_LIBRARY_PATH ([3b6738d](https://github.com/tmac1973/haruspex/commit/3b6738d8b2c822214df91a9e29a3e2945861b05d))
* **shell:** strip AppImage libs from spawned shell's LD_LIBRARY_PATH ([15cb6c3](https://github.com/tmac1973/haruspex/commit/15cb6c3d04d8a82025703b194cb035fee7e53e06))
* **shell:** strip comments and inject suggested commands via bracketed paste ([0453317](https://github.com/tmac1973/haruspex/commit/0453317a609edd388ef6ac165cd8ab73c7e3d0a1))
* **shell:** suppress preexec for DEBUG firings about to call our hooks ([df2d17e](https://github.com/tmac1973/haruspex/commit/df2d17ec50102810ce6bf5e609e49cd2fcf6822a))
* **shell:** tolerate CRLF in the WSL-sourced hook + force LF via gitattributes ([581d583](https://github.com/tmac1973/haruspex/commit/581d58304144b2ae760329f1b0663a27db5a5e11))
* **shell:** update context indicator on shell turns ([9a81cd3](https://github.com/tmac1973/haruspex/commit/9a81cd3bd8a5ef9c030ef7fd3c31aa3e80d325a0))
* **shell:** warn on risky commands for Paste, not just Run ([68d4a27](https://github.com/tmac1973/haruspex/commit/68d4a278b23b0d464a2527e5ab7a0b3eb175b21e))
* **shell:** warn on risky commands for Paste, not just Run ([fe35a40](https://github.com/tmac1973/haruspex/commit/fe35a40548549186a6e2c72c0df2198aafefea02))
* silence two benign console/build warnings ([aeb6aa0](https://github.com/tmac1973/haruspex/commit/aeb6aa073e657f5099711345e39a5aa11c4b6373))
* stop truncated tool calls corrupting written files ([#187](https://github.com/tmac1973/haruspex/issues/187)) ([04db30c](https://github.com/tmac1973/haruspex/commit/04db30cac387573c4e7b3d73bdb58b344fb81ef7))
* **tools:** catch more fs_write_xlsx scaffold patterns ([3458543](https://github.com/tmac1973/haruspex/commit/345854322e00b9931c07c4a7c2838cc246079d72))
* **tools:** reject scaffold input across the other fs_write_* writers ([4984c43](https://github.com/tmac1973/haruspex/commit/4984c430df5863a3038e3eda49fdb4176908fab5))
* **tools:** reject stub spreadsheet input + sharpen fs_write_xlsx description ([1aa75f2](https://github.com/tmac1973/haruspex/commit/1aa75f2b836265aafc953c5b83ca02f75e766585))
* **ui:** place the help (?) icon next to the settings gear ([0d94e26](https://github.com/tmac1973/haruspex/commit/0d94e26185916fa8f0e82617991f64a965049d0a))
* **workspace:** always render the stage div so pool.host can attach ([e1f5a5b](https://github.com/tmac1973/haruspex/commit/e1f5a5b31961cbd5d12b9440916c1ac2db1fe676))
* **workspace:** AST-rewrite sync game loops so they don't freeze the UI ([c255d18](https://github.com/tmac1973/haruspex/commit/c255d18935abc89d6239c29e95d3ba1c201cbfc2))
* **workspace:** await external scripts in show_html so plotly works ([4900fcd](https://github.com/tmac1973/haruspex/commit/4900fcd02b743496a7831d9612d5072f1c1fbcd8))
* **workspace:** inherit visibility on active iframe so it hides with tab ([83e9556](https://github.com/tmac1973/haruspex/commit/83e9556c152f2f67491d8b12deea35757d78aba5))
* **workspace:** keep WorkspaceTab mounted so pool iframes stay alive ([a87d045](https://github.com/tmac1973/haruspex/commit/a87d045bbe501c1e138296393d98293845629e93))
* **workspace:** no-op pygame Clock.tick so game loops don't freeze UI ([17839f6](https://github.com/tmac1973/haruspex/commit/17839f6294af64935888eaf251f66e02b044455b))


### Code Refactoring

* 12-phase codebase refactor ([ade0c52](https://github.com/tmac1973/haruspex/commit/ade0c525e63357ca008010f46496365ab3d1ae43))
* **agent:** dedup spill/overflow, sampling spread, recovery nudges ([c5e0ed7](https://github.com/tmac1973/haruspex/commit/c5e0ed728eb30202ec85f5f7fa149d3289232a95))
* **agent:** shared turn core + step helpers (audit step 4) ([3073d6a](https://github.com/tmac1973/haruspex/commit/3073d6a4bede61b657561304bb0dd5aabe3e8b19))
* **agent:** shared turn core + step helpers (audit step 4) ([d758b94](https://github.com/tmac1973/haruspex/commit/d758b9490cede8a614235b300142adbcd098d1be))
* **api,layout:** cut chatCompletion + onGlobalKeydown complexity ([55559d5](https://github.com/tmac1973/haruspex/commit/55559d599cb3b6763440235f0f7e50e3486efa60))
* **chat:** decompose sendMessage into named helpers ([4debe65](https://github.com/tmac1973/haruspex/commit/4debe65b87e8d70ea12292bd5d3222bf5db6430d))
* **chat:** extract replaySandboxCall to flatten restore loop ([3cd1bcd](https://github.com/tmac1973/haruspex/commit/3cd1bcd4abebc7051a0bf5a3e3840fdb60928eec))
* **chat:** extract sendMessage callback bundle and finalizer ([d66ac93](https://github.com/tmac1973/haruspex/commit/d66ac937fe72605cc8f470536219c40d6fbfe3bd))
* **complexity:** decompose spawn_output_reader and runIteration ([78e39a7](https://github.com/tmac1973/haruspex/commit/78e39a7508f90a80216705f34b7a37f1962f61f1))
* **config:** single-source ctx-size + searxng/voice defaults (X4/X5) ([ebc5590](https://github.com/tmac1973/haruspex/commit/ebc5590ca2d82c6184bfeb3a20633c689a40c32a))
* **config:** single-source ctx-size + searxng/voice defaults (X4/X5) ([a5f333a](https://github.com/tmac1973/haruspex/commit/a5f333af0b2feabb8fe34fefeb6006beeb77ae23))
* **db:** recover poisoned locks and move inline SQL into repository ([1bceb67](https://github.com/tmac1973/haruspex/commit/1bceb6718240919727d9f0bf9212fb082b02858d))
* **db:** simplify update_engine_stat failure-column mapping ([dddd0fc](https://github.com/tmac1973/haruspex/commit/dddd0fcec277f26a7ade2243d958a95614b2d70e))
* **db:** split monolithic db.rs into domain modules ([c435f08](https://github.com/tmac1973/haruspex/commit/c435f0888147d0e6077ce4972de4105a6d91982f))
* dedup sweep — close out the 2026-07-08 duplication audit ([#169](https://github.com/tmac1973/haruspex/issues/169)) ([88190ad](https://github.com/tmac1973/haruspex/commit/88190ad7ba6d1caa3f51ccd86799ab4ade5b5338))
* **dedupe:** extract pure-utility helpers (audit roadmap step 1) ([b5d2b83](https://github.com/tmac1973/haruspex/commit/b5d2b83a91e4d454cef3f049934af49070ba8a7a))
* **dedupe:** pure-utility helpers (audit roadmap step 1) ([0552a47](https://github.com/tmac1973/haruspex/commit/0552a4708d649436c979ac297f8096ba5e13b68c))
* extract shared Modal and ModalButton components ([cd20417](https://github.com/tmac1973/haruspex/commit/cd204171d54b16fa0e730415191d37c083d1212d))
* extract sidecar_utils for shared infra ([46d90dd](https://github.com/tmac1973/haruspex/commit/46d90dd38d3311b221ef299699c205c12a376bbc))
* **F10:** extract python.worker message dispatch + test harness ([da28a01](https://github.com/tmac1973/haruspex/commit/da28a0196dac5c4c2444ba1f7b0541bd49930224))
* **F10:** worker-manager onMessage dispatch table + tests ([3e6f097](https://github.com/tmac1973/haruspex/commit/3e6f097f68a1a200db7f264dfe4d0b1ae0deffd8))
* **F12:** extract + test search_auto engine ordering ([a220af5](https://github.com/tmac1973/haruspex/commit/a220af5a1837567345d4fa536223adb7ce74c154))
* **F15:** simplify coerce/diagnose/stepLabel + add tests ([879feb9](https://github.com/tmac1973/haruspex/commit/879feb973faf131455ad0c7fb28807e2b0a03948))
* **F9:** extract + test download_file resume/speed math ([3fc4331](https://github.com/tmac1973/haruspex/commit/3fc433115bf9be6dcf583ab609ec93e03b3b7cf5))
* finish complexity audit — deferred items + warning sweep ([0dde89a](https://github.com/tmac1973/haruspex/commit/0dde89ab888a0b29c6e4afa793160189c294cbe8))
* **fs_tools,code:** share dir-listing and file-walk loops ([0da5d3d](https://github.com/tmac1973/haruspex/commit/0da5d3d1cb4c3060c1dda4f05737a2eec6e43637))
* **fs_tools,db:** dedup ODF manifest prologue + JobSummary query ([f208ee7](https://github.com/tmac1973/haruspex/commit/f208ee733ec129125c1a19deba0c473bfe0636f9))
* **fs_tools:** complete module split — docx/odt/pptx/odp/pdf_write ([fb463cf](https://github.com/tmac1973/haruspex/commit/fb463cf3a4ae61e2bcbf385560506d68eeed8f79))
* **fs_tools:** decompose build_pptx and slim build_pdf ([75f58b0](https://github.com/tmac1973/haruspex/commit/75f58b024b2044700cf5c5b8039eaf8a9aac7b3c))
* **fs_tools:** dedup the document writers ([e3123e8](https://github.com/tmac1973/haruspex/commit/e3123e855f5074ddbe5311a5340ae13636d53d6e))
* **fs_tools:** dedupe build_pdf page-break + font-set logic ([7b4ed85](https://github.com/tmac1973/haruspex/commit/7b4ed8535209f4dee6df3a2f722cf16846142dc7))
* **fs_tools:** extract paragraph emit helpers in docx + odt ([a28b658](https://github.com/tmac1973/haruspex/commit/a28b658bb74374a976709beb3eb5d8408589bf54))
* **fs_tools:** extract path, images, markdown_inline modules ([7a83453](https://github.com/tmac1973/haruspex/commit/7a83453f8cc357fea48a9126675ffb4c0e7a8bf7))
* **fs_tools:** extract text, pdf_read, download, xlsx modules ([faddd20](https://github.com/tmac1973/haruspex/commit/faddd201acac9710790bb0bf334d97285a6bbed7))
* **fs_tools:** share ODF + OOXML scaffolding + image-index (step 3b) ([9ca5fda](https://github.com/tmac1973/haruspex/commit/9ca5fda78ad18fd52feb4f116f663160a0d8effa))
* **fs_tools:** share ODF + OOXML scaffolding + image-index (step 3b) ([00f5e77](https://github.com/tmac1973/haruspex/commit/00f5e777e1e8f819c43946faa2dd09caab34274d))
* **fs_tools:** share write-tail/size-caps/sizing/test helpers (step 3a) ([bd6bf8d](https://github.com/tmac1973/haruspex/commit/bd6bf8d049c156262ec5a96a212bdec9e2f0c4ba))
* **fs_tools:** share write-tail/size-caps/sizing/test helpers (step 3a) ([84c4c37](https://github.com/tmac1973/haruspex/commit/84c4c37b70197b465d9c317122821ae52d2be915))
* **fs_tools:** wrap_to_width delegates to wrap_styled_words ([016971e](https://github.com/tmac1973/haruspex/commit/016971e175453b409cafbac5ef9546f4928afe15))
* **inference:** move the inference queue into Rust ([99449a1](https://github.com/tmac1973/haruspex/commit/99449a18436e7b57ed0f33340ca36c1503fc9ad8))
* **inference:** share probe types + model-pick precedence ([df7e8a1](https://github.com/tmac1973/haruspex/commit/df7e8a131abbc8fa69c591d81e1851c60cace103))
* **ipc:** generate boundary TS types from Rust via ts-rs ([85149a6](https://github.com/tmac1973/haruspex/commit/85149a63ea160bb57504b7cade21091b08f4a1c1))
* **ipc:** single-source ports + dedupe fetch-timeout (step 6) ([436c4bf](https://github.com/tmac1973/haruspex/commit/436c4bfd551666356cf83994eeaba1dd27e293d9))
* **ipc:** single-source ports + dedupe fetch-timeout (step 6) ([88f3acf](https://github.com/tmac1973/haruspex/commit/88f3acf6aeb2d83ef38fc1cbf46250ac73e1d5eb))
* **ipc:** typed Rust→TS bindings (ts-rs) + command-name drift guard ([94c70fe](https://github.com/tmac1973/haruspex/commit/94c70fea77da8de1f2e189765681cdf21bc2c22b))
* **iteration:** clear residual complexity warnings ([496b62b](https://github.com/tmac1973/haruspex/commit/496b62b613636ddac5fe67bbbebafe8e025f0081))
* **jobs:** extract runJobTurn for the per-job inference-slot turn ([b84736c](https://github.com/tmac1973/haruspex/commit/b84736c10f21c30618cf665945a0351ef1d8b74d))
* **jobs:** shared JobStepCard + global status-pill (C1/C5) ([2c48fa9](https://github.com/tmac1973/haruspex/commit/2c48fa9364a49263757aa9fee9d9b11f81675d13))
* **jobs:** shared JobStepCard + global status-pill (C1/C5) ([02604f3](https://github.com/tmac1973/haruspex/commit/02604f36c9ac9a941c15bbca7e39a73fd4ff59af))
* **loop:** extract NudgeState class ([faf1217](https://github.com/tmac1973/haruspex/commit/faf1217c9490dd500d2d4ce5518a40586c1732d4))
* **loop:** extract runIteration + LoopContext + LoopState ([26bebdb](https://github.com/tmac1973/haruspex/commit/26bebdbabb5a92a903cdb543da1d717a585bcd87))
* **modals:** migrate Help + Startup onto shared Modal (C6) ([61af260](https://github.com/tmac1973/haruspex/commit/61af260c2ce02f82bbd51fee14ef3ee08a9d62a4))
* **modals:** migrate Help + Startup onto shared Modal (C6) ([3dc234e](https://github.com/tmac1973/haruspex/commit/3dc234ee47450ab6697e5640a7ec63c86afec5ba))
* **models:** extract hardware detection into hardware.rs (A2) ([ea3bdfe](https://github.com/tmac1973/haruspex/commit/ea3bdfef43670407b9078682ce854e49f452674c))
* **models:** extract shared download_to_partial helper ([865dcb0](https://github.com/tmac1973/haruspex/commit/865dcb09889728ca7e74722bf3bab43666f66397))
* **models:** share model-download progress listener lifecycle ([358567f](https://github.com/tmac1973/haruspex/commit/358567f5e9d196efdbd5959906099ff88f1f508c))
* **models:** table-driven hardware recommendation thresholds ([472cd11](https://github.com/tmac1973/haruspex/commit/472cd11202c2c00625c4ed549991aad0afaff4d6))
* polish pass — eslint guardrails, error surfacing, helpers ([17c7661](https://github.com/tmac1973/haruspex/commit/17c7661526b3aab0e857563ea8d3ac0eed45fdc7))
* **proxy/search:** extract shared scrape_engine helper ([ec05995](https://github.com/tmac1973/haruspex/commit/ec059957e226573fc0eca28ba407bd3b863c50a2))
* **proxy:** share fetch-client builder + non-2xx status mapper ([7dac3d5](https://github.com/tmac1973/haruspex/commit/7dac3d592649d09eec8a2399649ed1f293ff57ea))
* **proxy:** split god module, invert db dependency, dedupe engine plumbing ([db7fe78](https://github.com/tmac1973/haruspex/commit/db7fe78c89ef0ffc790142f1d09aa8527895cb98))
* **proxy:** split god module, invert db dependency, dedupe engines ([205c327](https://github.com/tmac1973/haruspex/commit/205c327800d28024dedf22afcdb027108b5c5245))
* **proxy:** split proxy.rs into module tree ([a865bed](https://github.com/tmac1973/haruspex/commit/a865bedae2f4460155baf0cd5df554878ac1234b))
* remediate code-complexity audit (god-functions, db split, doc-builder DRY) ([0e0b947](https://github.com/tmac1973/haruspex/commit/0e0b947652cd6d85af5c5386b296f54976babb8c))
* **routes:** extract ConversationSidebar component ([6c0b4c1](https://github.com/tmac1973/haruspex/commit/6c0b4c11c20e02af338144606e4af5e55d4092e2))
* **rust:** sidecar spawn/reader + fs read-guard dedup (loose ends) ([2652edb](https://github.com/tmac1973/haruspex/commit/2652edb0657fc0556dfd76fca9a7eb03fcb582dd))
* **rust:** sidecar spawn/reader + fs read-guard dedup (loose ends) ([0685b33](https://github.com/tmac1973/haruspex/commit/0685b336407483bc843f73d2547a3994b642d60c))
* **sandbox:** decompose python worker init into boot phases ([5d995c4](https://github.com/tmac1973/haruspex/commit/5d995c46062be204dbf0550aaa42e4093b806de8))
* **sandbox:** dedup worker respond, byte coercion, run guards ([111a7e6](https://github.com/tmac1973/haruspex/commit/111a7e64b767b64ee0cda9ce550d12c17e66c83d))
* **sandbox:** pivot back to Web Worker, drop workspace tab/iframe (steps A–D) ([adeb10e](https://github.com/tmac1973/haruspex/commit/adeb10e0498bc6daa259298b7fcc462fbae55333))
* **server:** extract log_classifier module ([daa2dbd](https://github.com/tmac1973/haruspex/commit/daa2dbd15eaddde588f59d610e45036205c8c10f))
* **settings:** extract EmailSection and ModelsSection ([8435d07](https://github.com/tmac1973/haruspex/commit/8435d07432f0c626c84888c804227b52156d2846))
* **settings:** shared .settings-section scaffolding (C2) ([2e1aed3](https://github.com/tmac1973/haruspex/commit/2e1aed3d75950c5a3d6ef97f62e1a5505cdfa3d4))
* **settings:** shared .settings-section scaffolding (C2) ([9c1539f](https://github.com/tmac1973/haruspex/commit/9c1539fbfb5a2abc0bd471b37f41d809c54f76da))
* **setup:** decompose runTestQuery streaming + polling tangle ([23a7817](https://github.com/tmac1973/haruspex/commit/23a781706d84875378a112f8e5f8ca2b7a5fc0c2))
* **shell,email:** share session spawn + text truncation/collapse ([9065126](https://github.com/tmac1973/haruspex/commit/90651268d4649545c165139e15dae19a92a585a3))
* **shell:** auto-attach recent shell activity instead of explicit submit ([012aba9](https://github.com/tmac1973/haruspex/commit/012aba9c099bf7f3f1915ebeb616c6794af9e7a0))
* **shell:** dedupe command-line resolution (B/C markers) ([59b4972](https://github.com/tmac1973/haruspex/commit/59b497217abc84736b8fa0c8a74d136bccabe116))
* **sidecar:** centralize loopback host + health-poll timeouts (A4) ([c7ad858](https://github.com/tmac1973/haruspex/commit/c7ad858874255c70044c81de4b01d3a2c85b5253))
* **sidecars:** share library-path/URL/kill/health helpers (step 2) ([346c4d5](https://github.com/tmac1973/haruspex/commit/346c4d509d910d3049402d29941e025ad2748426))
* **sidecars:** share library-path/URL/kill/health helpers (step 2) ([ae3a9f4](https://github.com/tmac1973/haruspex/commit/ae3a9f480532a006b8ee0831652f562f17bd4838))
* **stores:** break chat&lt;-&gt;sandbox import cycle (A1) ([314f78c](https://github.com/tmac1973/haruspex/commit/314f78cd2026b1a3381651121ee2d5489561ce99))
* **stores:** centralize db_* IPC wrappers behind dbCall ([d519c4c](https://github.com/tmac1973/haruspex/commit/d519c4c30cc2c7558e31e3d2f1e056ee8d807fee))
* **tools:** extract _helpers + adopt writeExecutor / SHEETS_SCHEMA ([d2de0f9](https://github.com/tmac1973/haruspex/commit/d2de0f97282cafc399756d5a65f81012ab993429))
* **ts:** finish errMessage + copy-action adoption (loose ends) ([df77d04](https://github.com/tmac1973/haruspex/commit/df77d048462eec37a112f2536f509f9c274f15c1))
* **ts:** finish errMessage + copy-action adoption (loose ends) ([68b9af1](https://github.com/tmac1973/haruspex/commit/68b9af19270a4d2776a627e3ac693c6f3a378c42))
* **ui:** add top-level tab shell and extract ChatView ([33ca986](https://github.com/tmac1973/haruspex/commit/33ca98669c4e5d7cbb547b669dd403f1fcfc72b3))
* **ui:** rename GpuWarningDialog to StartupNoticeDialog ([6e2f75d](https://github.com/tmac1973/haruspex/commit/6e2f75da3d9bff793620437271dd50feb77bc53e))
* **ui:** safe CSS/util dedup — success var, thin-scroll, duration, keyed copy (step 5a) ([52ec801](https://github.com/tmac1973/haruspex/commit/52ec801754e9e3eaab76a7c11ddce2e7745490db))
* **ui:** safe CSS/util dedup (step 5a) ([d634949](https://github.com/tmac1973/haruspex/commit/d634949f01422bfdf40f944428d7a74a7d55796c))
* **ui:** share stats-row builder + clickable-row a11y action ([c9d1175](https://github.com/tmac1973/haruspex/commit/c9d1175a029528f0a9f954e6b9f9c58033f05cb4))


### Documentation

* add 2026-05-14 audits and 12-phase refactor plan ([f0b3bb1](https://github.com/tmac1973/haruspex/commit/f0b3bb1c4349fdb22a87acafc24728bc3500709d))
* add AI safety / hallucination disclaimer to README ([be6d315](https://github.com/tmac1973/haruspex/commit/be6d3154e375404fbbc16bc7dfdabd151484df65))
* add maintenance.md post-refactor guide ([15c30da](https://github.com/tmac1973/haruspex/commit/15c30dad05ff7467ec82b87d35a2dcb67a82e876))
* **audit:** add architecture review ([f19ac5a](https://github.com/tmac1973/haruspex/commit/f19ac5a517c8ee86c60d731a65109df95a46038a))
* **audit:** add code complexity audit report ([f071ca8](https://github.com/tmac1973/haruspex/commit/f071ca8521fe35be0e02d3ed58949db83d9ea71c))
* **audit:** add code-duplication audit report ([732362c](https://github.com/tmac1973/haruspex/commit/732362c9e93c5ca8c0dbc3a7f29536f961c3f818))
* **audit:** add codebase review 2026-06-11 (bugs, coverage, remediation status) ([0961db8](https://github.com/tmac1973/haruspex/commit/0961db8ff0149be0bd171765b35ad65f25d24af7))
* **audit:** code-duplication audit report ([3d4d90a](https://github.com/tmac1973/haruspex/commit/3d4d90a88995c96366062a823af4d5454e58ea9d))
* **audit:** drop phantom poison-recovery follow-up ([3ba5572](https://github.com/tmac1973/haruspex/commit/3ba5572b6f5e33cee58cbc2f928694a30439821b))
* **audit:** proposal for typed Rust&lt;-&gt;TS IPC bindings (X2/X3) ([518a20d](https://github.com/tmac1973/haruspex/commit/518a20d219ca24ecf8a39e5cb40316418096de64))
* **audit:** record remediation status + outstanding items ([51b433d](https://github.com/tmac1973/haruspex/commit/51b433d09803541faecd2b38668e3e0c0bb97dea))
* **audit:** record remediation status + outstanding items ([4cbde22](https://github.com/tmac1973/haruspex/commit/4cbde22cf7b833aca1f5aa51d6cdcbe060a0b346))
* **audits:** code duplication audit (2026-06-25) ([473ea7c](https://github.com/tmac1973/haruspex/commit/473ea7c48c9cbc403c28034d4af8d74267989baa))
* **audit:** typed Rust↔TS IPC bindings proposal (X2/X3) ([21c0f48](https://github.com/tmac1973/haruspex/commit/21c0f48b2c75ac598f05055d71b955a840616376))
* broaden web research feature description in README ([739225f](https://github.com/tmac1973/haruspex/commit/739225f2d7c9e7d3b3be77fbbe5c074fa2bef5ac))
* **jobs:** add phase-14 plan for jobs tab ([0c76f5d](https://github.com/tmac1973/haruspex/commit/0c76f5df2458a2481f2cc158dbf5362ca4cca53d))
* **jobs:** add tooltips across the job editor + scheduler warning ([34624a7](https://github.com/tmac1973/haruspex/commit/34624a7271c1b49f8861907d228c33a0a71facd2))
* **jobs:** polish — prompt-size warning, tab badge, copy, maintenance.md (phase 14 step 8) ([f77569f](https://github.com/tmac1973/haruspex/commit/f77569f72389fb0e94f1d3fdd0a452f5deb49c8e))
* **plan:** account for Code mode in the phase-17 Windows plan ([2062df9](https://github.com/tmac1973/haruspex/commit/2062df9475090cd374a90244117766f5d82c9dd2))
* **plan:** add phase 15 shell tab plan ([c5282a9](https://github.com/tmac1973/haruspex/commit/c5282a9edea84694689e0463fa8d40e3a5fd8478))
* **plan:** pivot to inline-iframe rendering with Web Worker runtime ([8fb9a62](https://github.com/tmac1973/haruspex/commit/8fb9a62922fda4379e219e6952d4af087d86f31d))
* **plan:** rewrite phase 13 as unified python sandbox ([8c9d8ff](https://github.com/tmac1973/haruspex/commit/8c9d8ff6bb6a7851b0bcb240e83ab7ca426e5cf9))
* **readme:** add Jobs tab feature + note sandbox/shell-write default off ([8d39a7e](https://github.com/tmac1973/haruspex/commit/8d39a7e532c3a7574e9b7dcababb71067895fb81))
* **readme:** add Jobs tab feature + note sandbox/shell-write default off ([c8758c0](https://github.com/tmac1973/haruspex/commit/c8758c0ae8a27c0785ed9cd4db0e5ed7fb3646e4))
* **readme:** correct shell execution claim; document Code mode + job types ([#164](https://github.com/tmac1973/haruspex/issues/164)) ([c940b35](https://github.com/tmac1973/haruspex/commit/c940b353dcd94a41432deaed49fc94b017b9aae7))
* **readme:** per-platform all-in-one dev setup commands ([#154](https://github.com/tmac1973/haruspex/issues/154)) ([94d4f35](https://github.com/tmac1973/haruspex/commit/94d4f35ce98f960604c4d8d5162f81689b0a24cc))
* **shell:** reconcile macOS/Windows port plans with this session's changes ([7ef7ad1](https://github.com/tmac1973/haruspex/commit/7ef7ad1a4008fe9e61720909b28204f3a92be139))
* track the futures list in-repo ([#191](https://github.com/tmac1973/haruspex/issues/191)) ([9cf9839](https://github.com/tmac1973/haruspex/commit/9cf9839ab79a7549bf652c2097ea48366b57064d))
* trim and restructure README ([339754b](https://github.com/tmac1973/haruspex/commit/339754b591e3298084e75cf57d94b2cfa7e6c990))
* **workspace:** add phase-13 plan for interactive Python+HTML tab ([35dcea9](https://github.com/tmac1973/haruspex/commit/35dcea9704af5cb0b4fa3a55bdb5c3bf63db9418))

## [0.1.57](https://github.com/tmac1973/haruspex/compare/v0.1.56...v0.1.57) (2026-07-22)


### Features

* phase-boundary verification, runner-executed, with repair cycles ([#190](https://github.com/tmac1973/haruspex/issues/190)) ([baafee4](https://github.com/tmac1973/haruspex/commit/baafee4f0b43bff1554a70b4f160e172c524f016))
* settle the autonomous-coding verification contract in preflight ([#188](https://github.com/tmac1973/haruspex/issues/188)) ([a6e3c25](https://github.com/tmac1973/haruspex/commit/a6e3c25ab0ad63561d0cc19d4fa1fef22e1884c2))


### Bug Fixes

* debug-log digests + guided-planning phase-file validation ([#186](https://github.com/tmac1973/haruspex/issues/186)) ([a03a4fa](https://github.com/tmac1973/haruspex/commit/a03a4fadb3e6148afa3dc0fc167a523f07e5f87a))
* stop truncated tool calls corrupting written files ([#187](https://github.com/tmac1973/haruspex/issues/187)) ([04db30c](https://github.com/tmac1973/haruspex/commit/04db30cac387573c4e7b3d73bdb58b344fb81ef7))


### Documentation

* track the futures list in-repo ([#191](https://github.com/tmac1973/haruspex/issues/191)) ([9cf9839](https://github.com/tmac1973/haruspex/commit/9cf9839ab79a7549bf652c2097ea48366b57064d))

## [0.1.56](https://github.com/tmac1973/haruspex/compare/v0.1.55...v0.1.56) (2026-07-17)


### Bug Fixes

* **agent:** survive sidecar restarts + trim research_url context bloat ([#184](https://github.com/tmac1973/haruspex/issues/184)) ([a89da35](https://github.com/tmac1973/haruspex/commit/a89da35f79c4ea534fd5055b5da7162862af44c6))
* **inference:** save remote server URLs to the list without requiring Add ([#183](https://github.com/tmac1973/haruspex/issues/183)) ([bc279e8](https://github.com/tmac1973/haruspex/commit/bc279e8e6014de2a8e4d36973b0e0c57478b4920))

## [0.1.55](https://github.com/tmac1973/haruspex/compare/v0.1.54...v0.1.55) (2026-07-15)


### Features

* **inference:** predictive VRAM context cap + allow-spill toggle ([#181](https://github.com/tmac1973/haruspex/issues/181)) ([d371857](https://github.com/tmac1973/haruspex/commit/d371857b5dbe6793d6979320ad9f12659097c5c0))
* job-step timers, 256K context option, settings card order fix ([#180](https://github.com/tmac1973/haruspex/issues/180)) ([59ff503](https://github.com/tmac1973/haruspex/commit/59ff50352cd61c5d78f9275a9e3d9280864818d9))
* **jobs:** autonomous_coding job type — unattended ralph loop over a plan directory ([#175](https://github.com/tmac1973/haruspex/issues/175)) ([4cfa4eb](https://github.com/tmac1973/haruspex/commit/4cfa4eb284d5aef08ca2bdc9c0810dba87066c5c))
* **jobs:** convert job types to a plugin registry with a type_config column ([#174](https://github.com/tmac1973/haruspex/issues/174)) ([8c1f02c](https://github.com/tmac1973/haruspex/commit/8c1f02c1b70b84c91341ffe1ffcc27a4dd7e63a7))
* review remediation 2026-07 — responsiveness, UX recovery, a11y, provider descriptor ([#178](https://github.com/tmac1973/haruspex/issues/178)) ([f5f6888](https://github.com/tmac1973/haruspex/commit/f5f68888a72fc1f0d4bf9fd3fedbd4edf06e6ac8))
* **ui:** warm-neutral + teal UI refresh (design handoff implementation) ([#179](https://github.com/tmac1973/haruspex/issues/179)) ([ae744e4](https://github.com/tmac1973/haruspex/commit/ae744e493a45d7d1f8850bc9cd4c961a83f7c637))


### Bug Fixes

* **proxy:** reddit-aware fetch fallback — old.reddit first, dead .json rewritten ([#177](https://github.com/tmac1973/haruspex/issues/177)) ([51d78b9](https://github.com/tmac1973/haruspex/commit/51d78b9a84da51198316fedece78644d0d61ee22))
* **shell:** stop the assistant sidebar from freezing on long Code-mode sessions ([#176](https://github.com/tmac1973/haruspex/issues/176)) ([e73e179](https://github.com/tmac1973/haruspex/commit/e73e179431794cb1aedffd1442b829d111ae45e5))

## [0.1.54](https://github.com/tmac1973/haruspex/compare/v0.1.53...v0.1.54) (2026-07-09)


### Bug Fixes

* **inference:** stop leaking Qwen sampling params and template kwargs to non-Qwen remote models ([#172](https://github.com/tmac1973/haruspex/issues/172)) ([2c77bfe](https://github.com/tmac1973/haruspex/commit/2c77bfe7ef32b9e99835ae8144166cab1e2371ba))

## [0.1.53](https://github.com/tmac1973/haruspex/compare/v0.1.52...v0.1.53) (2026-07-09)


### Features

* **inference:** add OpenRouter as a first-class cloud backend ([#168](https://github.com/tmac1973/haruspex/issues/168)) ([6d8c566](https://github.com/tmac1973/haruspex/commit/6d8c5667c687bb498f1cf6285bb2f8f0fe89ce75))
* **jobs:** single model-source selector + shared ModeSelector radio cards ([#170](https://github.com/tmac1973/haruspex/issues/170)) ([84c541d](https://github.com/tmac1973/haruspex/commit/84c541de3462e6fbeffdd3cf84a3a907e143d98d))


### Code Refactoring

* dedup sweep — close out the 2026-07-08 duplication audit ([#169](https://github.com/tmac1973/haruspex/issues/169)) ([88190ad](https://github.com/tmac1973/haruspex/commit/88190ad7ba6d1caa3f51ccd86799ab4ade5b5338))

## [0.1.52](https://github.com/tmac1973/haruspex/compare/v0.1.51...v0.1.52) (2026-07-03)


### Features

* guided planning job type + reusable ask_user_question primitive ([#162](https://github.com/tmac1973/haruspex/issues/162)) ([b11c58c](https://github.com/tmac1973/haruspex/commit/b11c58ce4c088aa94e0cebbbc35cc975a5396a22))
* **inference:** scope the admission queue per provider lane ([#163](https://github.com/tmac1973/haruspex/issues/163)) ([8eccdc6](https://github.com/tmac1973/haruspex/commit/8eccdc6b6d71f8936f9421383ade765909896d9b))


### Bug Fixes

* **agent:** don't count blocked web reads against the turn budget ([#166](https://github.com/tmac1973/haruspex/issues/166)) ([872956f](https://github.com/tmac1973/haruspex/commit/872956fa34ab47f6b14f9942b3d5e36f16b27193))
* **guided-planning:** escape hatch, write verification, complete plans ([#165](https://github.com/tmac1973/haruspex/issues/165)) ([cf16373](https://github.com/tmac1973/haruspex/commit/cf1637347ea75f901dd7a27fd2627ebc8772eb25))
* **sandbox:** enforce sandbox switch at execution + recover stuck inference ([#160](https://github.com/tmac1973/haruspex/issues/160)) ([06a5ad6](https://github.com/tmac1973/haruspex/commit/06a5ad6a6480652a66d2db409f171fd4898992e3))
* **shell:** attach in-flight session scrollback to assistant context ([#161](https://github.com/tmac1973/haruspex/issues/161)) ([6c80c35](https://github.com/tmac1973/haruspex/commit/6c80c356b431b0565f31f5eb2c1ced6544807d0b))


### Documentation

* **readme:** correct shell execution claim; document Code mode + job types ([#164](https://github.com/tmac1973/haruspex/issues/164)) ([c940b35](https://github.com/tmac1973/haruspex/commit/c940b353dcd94a41432deaed49fc94b017b9aae7))

## [0.1.51](https://github.com/tmac1973/haruspex/compare/v0.1.50...v0.1.51) (2026-06-26)


### Features

* **agent:** show why a turn stopped (turn limit vs gave up) with a Continue action ([#147](https://github.com/tmac1973/haruspex/issues/147)) ([479fb90](https://github.com/tmac1973/haruspex/commit/479fb9061092777ed3fa4d179b47ab13ccaa599f))
* **code:** add exclude/count/files-only/context to code_grep ([5cbcd07](https://github.com/tmac1973/haruspex/commit/5cbcd07a4ce06c2c15fd30e2e60525d06a559952))
* **inference:** consume llama-toolchest capability discovery ([#130](https://github.com/tmac1973/haruspex/issues/130)) ([9400c22](https://github.com/tmac1973/haruspex/commit/9400c22b5b895e46dfb30cd1047dbea8e06d3553))
* **inference:** support multiple remote server URLs ([#129](https://github.com/tmac1973/haruspex/issues/129)) ([bef06be](https://github.com/tmac1973/haruspex/commit/bef06be59cdb946c7ec7a98ffee9c7c66bc3178b))
* **jobs:** audit mode, prompt catalog, and per-job remote model overrides ([3481253](https://github.com/tmac1973/haruspex/commit/3481253ba29b4a823ad0a502927574eea4080aca))
* **models:** Unsloth-only lineup, legacy migration, VRAM-aware context, correct sampling ([#142](https://github.com/tmac1973/haruspex/issues/142)) ([d005549](https://github.com/tmac1973/haruspex/commit/d005549ea62323e95e93fda578dbc4c0142244e8))
* **search:** add Startpage + Yahoo (Google/Bing-sourced) to the no-browser rotation ([#151](https://github.com/tmac1973/haruspex/issues/151)) ([15119d8](https://github.com/tmac1973/haruspex/commit/15119d8fd8dbcf4866d6d73ddd3f6e62f4942720))
* Shell-assistant Code mode — coding agent in the live terminal ([#132](https://github.com/tmac1973/haruspex/issues/132)) ([bb7eef6](https://github.com/tmac1973/haruspex/commit/bb7eef627e8f5ae2f781a1e4c1e1367568719f86))
* **shell:** in-distro WSL context capture (17d-2) ([7d4f261](https://github.com/tmac1973/haruspex/commit/7d4f261d3b41108173d09d4d371fd1e515b07005))
* **shell:** interactive terminal control tools (input, read, interrupt) ([#143](https://github.com/tmac1973/haruspex/issues/143)) ([c02eccc](https://github.com/tmac1973/haruspex/commit/c02ecccf6315e6d423b3aedbe005ab2af97c130d))
* **shell:** open the Shell tab on Windows (17e) ([bcd01d8](https://github.com/tmac1973/haruspex/commit/bcd01d801acb163d0080e07372886b8641316ef9))
* **shell:** PowerShell OSC 133 injection (17c capture) ([b36063f](https://github.com/tmac1973/haruspex/commit/b36063ffac9338e9c8cf60c71f8cd9c349deaf11))
* **shell:** PowerShell variant of the Code-mode prompt (17c-3) ([f63a8b4](https://github.com/tmac1973/haruspex/commit/f63a8b4bfe5b03b6329d30b02a82d003c3dea720))
* **shell:** PowerShell/Windows risk patterns ([d2d73c3](https://github.com/tmac1973/haruspex/commit/d2d73c31d60e2a072dbf67685f311298a2ea17f1))
* **shell:** route spawn through ShellSelection (17b spawn rewiring) ([08b24bb](https://github.com/tmac1973/haruspex/commit/08b24bb63caa5d0856681d22e281078f04498388))
* **shell:** run_command background/watch options + 30s default timeout ([#149](https://github.com/tmac1973/haruspex/issues/149)) ([6a10614](https://github.com/tmac1973/haruspex/commit/6a106146096d64e5e895a9bbac5ca42375db80bc))
* **shell:** Run/Paste cards for PowerShell suggestions ([a187ae6](https://github.com/tmac1973/haruspex/commit/a187ae6bf3dec6527e86704454d1f81e6ef80ebd))
* **shell:** shell catalog + selection model (17b backend) ([2da2536](https://github.com/tmac1973/haruspex/commit/2da2536614b6d1d82c01b0a7d0ca92b1bbd72f30))
* **shell:** shell picker UI (completes 17b) ([fbd24bb](https://github.com/tmac1973/haruspex/commit/fbd24bb2ba188e2e5ea480a68aa8b80994619a43))
* **shell:** Windows PTY baseline behind a dev flag (17a) ([a9cd117](https://github.com/tmac1973/haruspex/commit/a9cd1174a2b88725ea52b2c16b83292459b6a328))
* **shell:** Windows session context for the badge (17c-2) ([c6831bc](https://github.com/tmac1973/haruspex/commit/c6831bc4aae2484753317736e6a023c28e3263b7))
* **shell:** WSL OSC 133 injection (17d-1) ([df00cbc](https://github.com/tmac1973/haruspex/commit/df00cbc84a88e37f24555c4ebdb7a29cc0f3024a))
* **vision:** terminal snapshot tool + drag-drop/paste image attachments ([#144](https://github.com/tmac1973/haruspex/issues/144)) ([29ff67b](https://github.com/tmac1973/haruspex/commit/29ff67b8d6b7db6cd7cc5e2ca00e84ba67aed117))


### Bug Fixes

* **build:** exclude src-tauri from the Vite dev watcher (Windows EBUSY) ([868a7fa](https://github.com/tmac1973/haruspex/commit/868a7fae6c2c0833ddb1cd9c7ac0e321d2b69d70))
* **chat:** attach dropped images via Tauri's native drag-drop event ([#146](https://github.com/tmac1973/haruspex/issues/146)) ([4d475a2](https://github.com/tmac1973/haruspex/commit/4d475a25a396fc98db317ece013557c18cf0cfc6))
* **chat:** stop a stray image drop from navigating the webview (app hang) ([#145](https://github.com/tmac1973/haruspex/issues/145)) ([49161d0](https://github.com/tmac1973/haruspex/commit/49161d02f65bd9244839e5aa9224c2fc4c1816d6))
* **fs-tools:** reject '..' traversal lexically so it holds on Windows ([7521030](https://github.com/tmac1973/haruspex/commit/75210305087041464d7cd0f9bb3b292f9f5855c4))
* **hardware:** detect NVIDIA VRAM and avoid iGPU shadowing ([362b30f](https://github.com/tmac1973/haruspex/commit/362b30f6569bb7a3df695e28dd17e3e31c0cc7b0))
* **refactor:** address code-review findings on the dedup branch ([673c311](https://github.com/tmac1973/haruspex/commit/673c3115fb6541d843466c03836332b0021ea892))
* **scripts:** dev-setup.sh delegates sidecar build to build-sidecars.sh ([631f0ff](https://github.com/tmac1973/haruspex/commit/631f0ffcef89a52525969ad03ed1c1604f116a50))
* **scripts:** don't let rustup's stderr abort windows-setup.ps1 ([8d5b42d](https://github.com/tmac1973/haruspex/commit/8d5b42d26c76ee39220058ce704dfb84d7b9bee3))
* **scripts:** install LLVM/libclang in windows-setup.ps1 for koko build ([0fa4db9](https://github.com/tmac1973/haruspex/commit/0fa4db92c68d19d55cc9ed32c2467f232ffa9deb))
* **scripts:** make Pyodide wheel resolver work on Windows ([4f5e9ad](https://github.com/tmac1973/haruspex/commit/4f5e9ada197de6b4d88abd00724ac1d3fbe376d4))
* **scripts:** make windows-setup.ps1 pure ASCII ([05169f0](https://github.com/tmac1973/haruspex/commit/05169f02496a8a275c578418cd7d775121467dd5))
* **search:** stop the auto-rotation rate-limit death spiral ([#150](https://github.com/tmac1973/haruspex/issues/150)) ([2c29de7](https://github.com/tmac1973/haruspex/commit/2c29de7961e89da3c5eba490a8872d510672fd4d))
* **shell:** dispose xterm input listeners on restart (keystroke duplication) ([00afccb](https://github.com/tmac1973/haruspex/commit/00afccb6dbe7629a34cad64c105ff122ed5ce91d))
* **shell:** launch PowerShell with -ExecutionPolicy Bypass for the hook ([811c887](https://github.com/tmac1973/haruspex/commit/811c887da896085763f047f80d677dfc4d47d927))
* **shell:** map WSL /mnt paths to Windows for the fs tools ([56c8815](https://github.com/tmac1973/haruspex/commit/56c8815e531be1d84d688aa59e9356c4ba4e4175))
* **shell:** normalize Windows cwd from OSC 7 ('/C:/...' -&gt; 'C:\\...') ([2f2f710](https://github.com/tmac1973/haruspex/commit/2f2f710c5a8de895ae540f4dd2273a96eaaec529))
* **shell:** reset command session-approval on New Chat ([47da02a](https://github.com/tmac1973/haruspex/commit/47da02af98d0988fa5428dca8745873a1f237c4e))
* **shell:** resolve shell-integration dir from source first in dev ([c641375](https://github.com/tmac1973/haruspex/commit/c641375b0e0b73d333e3d1d575522a78ef3f4f1c))
* **shell:** retain tool-call history across Code-mode turns ([f2f1309](https://github.com/tmac1973/haruspex/commit/f2f13092b2221281e3987012f7a0927c8ae4837d))
* **shell:** route one-shot run_command through the session shell (17d-3) ([395b24d](https://github.com/tmac1973/haruspex/commit/395b24d604911deaa2169c94f00c19119b3c7ff1))
* **shell:** run clipboard reads off the main thread ([#128](https://github.com/tmac1973/haruspex/issues/128)) ([77f61e1](https://github.com/tmac1973/haruspex/commit/77f61e1b35c05c33b42662a3de69ad6496131d03))
* **shell:** tolerate CRLF in the WSL-sourced hook + force LF via gitattributes ([581d583](https://github.com/tmac1973/haruspex/commit/581d58304144b2ae760329f1b0663a27db5a5e11))


### Code Refactoring

* **agent:** dedup spill/overflow, sampling spread, recovery nudges ([c5e0ed7](https://github.com/tmac1973/haruspex/commit/c5e0ed728eb30202ec85f5f7fa149d3289232a95))
* **fs_tools,code:** share dir-listing and file-walk loops ([0da5d3d](https://github.com/tmac1973/haruspex/commit/0da5d3d1cb4c3060c1dda4f05737a2eec6e43637))
* **fs_tools,db:** dedup ODF manifest prologue + JobSummary query ([f208ee7](https://github.com/tmac1973/haruspex/commit/f208ee733ec129125c1a19deba0c473bfe0636f9))
* **fs_tools:** dedup the document writers ([e3123e8](https://github.com/tmac1973/haruspex/commit/e3123e855f5074ddbe5311a5340ae13636d53d6e))
* **fs_tools:** wrap_to_width delegates to wrap_styled_words ([016971e](https://github.com/tmac1973/haruspex/commit/016971e175453b409cafbac5ef9546f4928afe15))
* **inference:** share probe types + model-pick precedence ([df7e8a1](https://github.com/tmac1973/haruspex/commit/df7e8a131abbc8fa69c591d81e1851c60cace103))
* **jobs:** extract runJobTurn for the per-job inference-slot turn ([b84736c](https://github.com/tmac1973/haruspex/commit/b84736c10f21c30618cf665945a0351ef1d8b74d))
* **models:** extract shared download_to_partial helper ([865dcb0](https://github.com/tmac1973/haruspex/commit/865dcb09889728ca7e74722bf3bab43666f66397))
* **models:** share model-download progress listener lifecycle ([358567f](https://github.com/tmac1973/haruspex/commit/358567f5e9d196efdbd5959906099ff88f1f508c))
* **proxy/search:** extract shared scrape_engine helper ([ec05995](https://github.com/tmac1973/haruspex/commit/ec059957e226573fc0eca28ba407bd3b863c50a2))
* **proxy:** share fetch-client builder + non-2xx status mapper ([7dac3d5](https://github.com/tmac1973/haruspex/commit/7dac3d592649d09eec8a2399649ed1f293ff57ea))
* **sandbox:** dedup worker respond, byte coercion, run guards ([111a7e6](https://github.com/tmac1973/haruspex/commit/111a7e64b767b64ee0cda9ce550d12c17e66c83d))
* **shell,email:** share session spawn + text truncation/collapse ([9065126](https://github.com/tmac1973/haruspex/commit/90651268d4649545c165139e15dae19a92a585a3))
* **stores:** centralize db_* IPC wrappers behind dbCall ([d519c4c](https://github.com/tmac1973/haruspex/commit/d519c4c30cc2c7558e31e3d2f1e056ee8d807fee))
* **ui:** share stats-row builder + clickable-row a11y action ([c9d1175](https://github.com/tmac1973/haruspex/commit/c9d1175a029528f0a9f954e6b9f9c58033f05cb4))


### Documentation

* **audits:** code duplication audit (2026-06-25) ([473ea7c](https://github.com/tmac1973/haruspex/commit/473ea7c48c9cbc403c28034d4af8d74267989baa))
* **plan:** account for Code mode in the phase-17 Windows plan ([2062df9](https://github.com/tmac1973/haruspex/commit/2062df9475090cd374a90244117766f5d82c9dd2))
* **readme:** per-platform all-in-one dev setup commands ([#154](https://github.com/tmac1973/haruspex/issues/154)) ([94d4f35](https://github.com/tmac1973/haruspex/commit/94d4f35ce98f960604c4d8d5162f81689b0a24cc))

## [0.1.50](https://github.com/tmac1973/haruspex/compare/v0.1.49...v0.1.50) (2026-06-17)


### Bug Fixes

* **agent:** re-stream when post-tools reply is thinking-only ([#126](https://github.com/tmac1973/haruspex/issues/126)) ([f40aadc](https://github.com/tmac1973/haruspex/commit/f40aadcd9e35fed08a478f7fcc1a1ccc57ed8315))
* **sandbox:** make inline chart/figure display reliable ([#124](https://github.com/tmac1973/haruspex/issues/124)) ([1b105c6](https://github.com/tmac1973/haruspex/commit/1b105c6780bc7ee8ec37f72f3c414918d8188444))
* **shell:** make paste reliable and add middle-click primary paste ([#125](https://github.com/tmac1973/haruspex/issues/125)) ([731ba4f](https://github.com/tmac1973/haruspex/commit/731ba4fd25d1edb595f30e5bde4f380162bb14b4))

## [0.1.49](https://github.com/tmac1973/haruspex/compare/v0.1.48...v0.1.49) (2026-06-15)


### Bug Fixes

* **build:** ship a working Vulkan backend in Linux releases ([#122](https://github.com/tmac1973/haruspex/issues/122)) ([faae5e1](https://github.com/tmac1973/haruspex/commit/faae5e18e3b601b7b08d8f99837ed0f15045d240))

## [0.1.48](https://github.com/tmac1973/haruspex/compare/v0.1.47...v0.1.48) (2026-06-14)


### Bug Fixes

* **ci:** strip CRLF from Windows pyodide wheel resolver ([#120](https://github.com/tmac1973/haruspex/issues/120)) ([a05d73f](https://github.com/tmac1973/haruspex/commit/a05d73f2ff2a6acba1b05e212d324d2f25c45610))

## [0.1.47](https://github.com/tmac1973/haruspex/compare/v0.1.46...v0.1.47) (2026-06-14)


### Features

* **sandbox:** bundle plotly.js so plotly renders with zero network ([79068ca](https://github.com/tmac1973/haruspex/commit/79068ca0a9f7dda87180e0dea6a70a6b1d7777df))
* **sandbox:** bundle Pyodide stack locally + split install/exec timeout ([8516e21](https://github.com/tmac1973/haruspex/commit/8516e2158f6b90423b45a03cd026c1e7dd732c5b))
* **sandbox:** bundle Pyodide stack locally + split install/exec timeout ([6badfd2](https://github.com/tmac1973/haruspex/commit/6badfd20110a8d66f119b0955531c39c9454ae0f))
* **sandbox:** bundle requests + plotly for offline use ([e3a104b](https://github.com/tmac1973/haruspex/commit/e3a104bd09449d3ab8f687df3889ad04ccd5cba6))
* **server:** capture llama-server crash telemetry ([2205bed](https://github.com/tmac1973/haruspex/commit/2205bedb94922415b0d78768811a8c388678b676))
* **server:** capture llama-server crash telemetry ([f2be88b](https://github.com/tmac1973/haruspex/commit/f2be88be29d31a1247ae74129605dab71008f8b5))
* **shell:** show tokens/second on shell assistant messages ([f28c2fe](https://github.com/tmac1973/haruspex/commit/f28c2fe18275690321ad73ffacae138fb8c11ac5))
* **shell:** show tokens/second on shell assistant messages ([812ac32](https://github.com/tmac1973/haruspex/commit/812ac320b490ad7d0484861b572ccdaa5d47f169))
* **tools:** honest failure icons + absorb avoidable first-try failures ([3b62ab2](https://github.com/tmac1973/haruspex/commit/3b62ab2912ecef98a2f4e98e5c85b205f032aa00))
* **tools:** honest failure icons + absorb avoidable first-try tool failures ([81acebd](https://github.com/tmac1973/haruspex/commit/81acebd1e6d5922f55626e608afb2bf9850f261e))


### Bug Fixes

* **backend:** transactional replace_messages, non-blocking rate limit ([e2f7115](https://github.com/tmac1973/haruspex/commit/e2f71151f6f6412c6d397a82df8bf8d28fe50019))
* **build:** silence ts-rs serde-attr parse warnings ([933b22f](https://github.com/tmac1973/haruspex/commit/933b22faa1c299d7fb3c4198dc78560068b46a66))
* **chat:** remap per-message artifacts on compaction and persist them ([521b475](https://github.com/tmac1973/haruspex/commit/521b475a1c52deec5b5ed28c4638d012d786aed8))
* correctness batch — IMAP injection, download integrity, docx extraction, compaction artifacts ([bbd2333](https://github.com/tmac1973/haruspex/commit/bbd23331a9f114a8d7d5efedd1389e6d4196e8ae))
* **email:** sanitize IMAP SEARCH filter values against CRLF injection ([21ed7f8](https://github.com/tmac1973/haruspex/commit/21ed7f82bcd145a445b7f26058d592868cff4c27))
* **fs:** docx tag-boundary scanning, entity decoding, xlsx NaN cells ([6cc4f59](https://github.com/tmac1973/haruspex/commit/6cc4f59331221cba099c36a708290e70f92c092e))
* **models:** verify downloads and restart resume when Range is ignored ([5f1fb6e](https://github.com/tmac1973/haruspex/commit/5f1fb6e858d8a5a7df2046c0c34f4e7ede274d12))
* **parser:** guard structured tool-call JSON parsing ([6b4e4c7](https://github.com/tmac1973/haruspex/commit/6b4e4c7858d528d59f4474ee13e190781d91e137))
* **proxy:** truncate fetched page text on a char boundary ([04c86ef](https://github.com/tmac1973/haruspex/commit/04c86ef98c4f059fa0e59d194bb966f3a905f2ba))
* **proxy:** truncate fetched page text on a char boundary ([f544809](https://github.com/tmac1973/haruspex/commit/f544809f042ab8e0bc25c15b35ac856ff7e72ccf))
* **sandbox:** label bundled-wheel installs honestly ([1ba00c4](https://github.com/tmac1973/haruspex/commit/1ba00c492e682dfab527fd1c72694bfb19403c4c))
* **sandbox:** label bundled-wheel installs honestly ([8955492](https://github.com/tmac1973/haruspex/commit/89554920595c4e6d999dcf12e2ef6f682b785a2b))
* **sandbox:** make synchronous requests/urllib reach arbitrary URLs ([a7bfc9d](https://github.com/tmac1973/haruspex/commit/a7bfc9dd4cf403bab2afc623eae03d972b3d7ac3))
* **sandbox:** make synchronous requests/urllib reach arbitrary URLs ([ff0ec9b](https://github.com/tmac1973/haruspex/commit/ff0ec9b09d787dea4eade0db95032628584f634c))
* **sandbox:** start the exec timeout after boot, fix tool-doc default ([f917583](https://github.com/tmac1973/haruspex/commit/f917583c80c23afe76282020a8816bc2064f40f0))
* **sandbox:** stop run_python lint-failure loops ([326ea92](https://github.com/tmac1973/haruspex/commit/326ea92fd78caf2dd95874cff0161bd791b377ed))
* **sandbox:** stop run_python lint-failure loops ([8ed6b07](https://github.com/tmac1973/haruspex/commit/8ed6b0763c4db71cdb2f7ac78a8d595c247d95dd))
* **sandbox:** vendor pyodide-http wheel for offline boot ([405000c](https://github.com/tmac1973/haruspex/commit/405000c7decbf5e61e3cbc3174c7a928bea53801))
* **security:** re-validate redirect hops and close IPv6 SSRF gaps ([8748277](https://github.com/tmac1973/haruspex/commit/8748277d69b237f0b7da4e3a94ce5f093d23ef5f))
* **security:** sanitize LLM-derived HTML before render and set a CSP ([ed4d38d](https://github.com/tmac1973/haruspex/commit/ed4d38deb329738880ac5c8ec3c851cd25af10fb))
* **security:** truncate user-derived text on char boundaries ([929e8f8](https://github.com/tmac1973/haruspex/commit/929e8f8584d989478cf07ef92395b7e46f0644ef))
* **security:** XSS sanitization + CSP, SSRF redirect validation, char-boundary panics ([0de44a3](https://github.com/tmac1973/haruspex/commit/0de44a3d7c7436a7eae8bbcc788b9453f6947919))
* **shell:** correct garbled fish capture on the Shell tab ([d0aa9f9](https://github.com/tmac1973/haruspex/commit/d0aa9f9db74fe239bf41012bf7fd040008e7630a))
* **shell:** correct garbled fish capture on the Shell tab ([a44d039](https://github.com/tmac1973/haruspex/commit/a44d03996bfc632f5f380b2afd989186ed82d4dd))
* **shell:** resolve relative fs_* paths against the shell cwd ([f04e838](https://github.com/tmac1973/haruspex/commit/f04e838743e9f1c687cbbad4887afe19c8eec5fc))
* **shell:** resolve relative fs_* paths against the shell cwd ([1f5f198](https://github.com/tmac1973/haruspex/commit/1f5f1987d2eb271f47c2576d21796fdaf024f31e))
* silence two benign console/build warnings ([aeb6aa0](https://github.com/tmac1973/haruspex/commit/aeb6aa073e657f5099711345e39a5aa11c4b6373))


### Code Refactoring

* **agent:** shared turn core + step helpers (audit step 4) ([3073d6a](https://github.com/tmac1973/haruspex/commit/3073d6a4bede61b657561304bb0dd5aabe3e8b19))
* **agent:** shared turn core + step helpers (audit step 4) ([d758b94](https://github.com/tmac1973/haruspex/commit/d758b9490cede8a614235b300142adbcd098d1be))
* **api,layout:** cut chatCompletion + onGlobalKeydown complexity ([55559d5](https://github.com/tmac1973/haruspex/commit/55559d599cb3b6763440235f0f7e50e3486efa60))
* **chat:** extract replaySandboxCall to flatten restore loop ([3cd1bcd](https://github.com/tmac1973/haruspex/commit/3cd1bcd4abebc7051a0bf5a3e3840fdb60928eec))
* **chat:** extract sendMessage callback bundle and finalizer ([d66ac93](https://github.com/tmac1973/haruspex/commit/d66ac937fe72605cc8f470536219c40d6fbfe3bd))
* **complexity:** decompose spawn_output_reader and runIteration ([78e39a7](https://github.com/tmac1973/haruspex/commit/78e39a7508f90a80216705f34b7a37f1962f61f1))
* **config:** single-source ctx-size + searxng/voice defaults (X4/X5) ([ebc5590](https://github.com/tmac1973/haruspex/commit/ebc5590ca2d82c6184bfeb3a20633c689a40c32a))
* **config:** single-source ctx-size + searxng/voice defaults (X4/X5) ([a5f333a](https://github.com/tmac1973/haruspex/commit/a5f333af0b2feabb8fe34fefeb6006beeb77ae23))
* **db:** recover poisoned locks and move inline SQL into repository ([1bceb67](https://github.com/tmac1973/haruspex/commit/1bceb6718240919727d9f0bf9212fb082b02858d))
* **db:** simplify update_engine_stat failure-column mapping ([dddd0fc](https://github.com/tmac1973/haruspex/commit/dddd0fcec277f26a7ade2243d958a95614b2d70e))
* **db:** split monolithic db.rs into domain modules ([c435f08](https://github.com/tmac1973/haruspex/commit/c435f0888147d0e6077ce4972de4105a6d91982f))
* **dedupe:** extract pure-utility helpers (audit roadmap step 1) ([b5d2b83](https://github.com/tmac1973/haruspex/commit/b5d2b83a91e4d454cef3f049934af49070ba8a7a))
* **dedupe:** pure-utility helpers (audit roadmap step 1) ([0552a47](https://github.com/tmac1973/haruspex/commit/0552a4708d649436c979ac297f8096ba5e13b68c))
* **F10:** extract python.worker message dispatch + test harness ([da28a01](https://github.com/tmac1973/haruspex/commit/da28a0196dac5c4c2444ba1f7b0541bd49930224))
* **F10:** worker-manager onMessage dispatch table + tests ([3e6f097](https://github.com/tmac1973/haruspex/commit/3e6f097f68a1a200db7f264dfe4d0b1ae0deffd8))
* **F12:** extract + test search_auto engine ordering ([a220af5](https://github.com/tmac1973/haruspex/commit/a220af5a1837567345d4fa536223adb7ce74c154))
* **F15:** simplify coerce/diagnose/stepLabel + add tests ([879feb9](https://github.com/tmac1973/haruspex/commit/879feb973faf131455ad0c7fb28807e2b0a03948))
* **F9:** extract + test download_file resume/speed math ([3fc4331](https://github.com/tmac1973/haruspex/commit/3fc433115bf9be6dcf583ab609ec93e03b3b7cf5))
* finish complexity audit — deferred items + warning sweep ([0dde89a](https://github.com/tmac1973/haruspex/commit/0dde89ab888a0b29c6e4afa793160189c294cbe8))
* **fs_tools:** dedupe build_pdf page-break + font-set logic ([7b4ed85](https://github.com/tmac1973/haruspex/commit/7b4ed8535209f4dee6df3a2f722cf16846142dc7))
* **fs_tools:** extract paragraph emit helpers in docx + odt ([a28b658](https://github.com/tmac1973/haruspex/commit/a28b658bb74374a976709beb3eb5d8408589bf54))
* **fs_tools:** share ODF + OOXML scaffolding + image-index (step 3b) ([9ca5fda](https://github.com/tmac1973/haruspex/commit/9ca5fda78ad18fd52feb4f116f663160a0d8effa))
* **fs_tools:** share ODF + OOXML scaffolding + image-index (step 3b) ([00f5e77](https://github.com/tmac1973/haruspex/commit/00f5e777e1e8f819c43946faa2dd09caab34274d))
* **fs_tools:** share write-tail/size-caps/sizing/test helpers (step 3a) ([bd6bf8d](https://github.com/tmac1973/haruspex/commit/bd6bf8d049c156262ec5a96a212bdec9e2f0c4ba))
* **fs_tools:** share write-tail/size-caps/sizing/test helpers (step 3a) ([84c4c37](https://github.com/tmac1973/haruspex/commit/84c4c37b70197b465d9c317122821ae52d2be915))
* **ipc:** generate boundary TS types from Rust via ts-rs ([85149a6](https://github.com/tmac1973/haruspex/commit/85149a63ea160bb57504b7cade21091b08f4a1c1))
* **ipc:** single-source ports + dedupe fetch-timeout (step 6) ([436c4bf](https://github.com/tmac1973/haruspex/commit/436c4bfd551666356cf83994eeaba1dd27e293d9))
* **ipc:** single-source ports + dedupe fetch-timeout (step 6) ([88f3acf](https://github.com/tmac1973/haruspex/commit/88f3acf6aeb2d83ef38fc1cbf46250ac73e1d5eb))
* **ipc:** typed Rust→TS bindings (ts-rs) + command-name drift guard ([94c70fe](https://github.com/tmac1973/haruspex/commit/94c70fea77da8de1f2e189765681cdf21bc2c22b))
* **iteration:** clear residual complexity warnings ([496b62b](https://github.com/tmac1973/haruspex/commit/496b62b613636ddac5fe67bbbebafe8e025f0081))
* **jobs:** shared JobStepCard + global status-pill (C1/C5) ([2c48fa9](https://github.com/tmac1973/haruspex/commit/2c48fa9364a49263757aa9fee9d9b11f81675d13))
* **jobs:** shared JobStepCard + global status-pill (C1/C5) ([02604f3](https://github.com/tmac1973/haruspex/commit/02604f36c9ac9a941c15bbca7e39a73fd4ff59af))
* **modals:** migrate Help + Startup onto shared Modal (C6) ([61af260](https://github.com/tmac1973/haruspex/commit/61af260c2ce02f82bbd51fee14ef3ee08a9d62a4))
* **modals:** migrate Help + Startup onto shared Modal (C6) ([3dc234e](https://github.com/tmac1973/haruspex/commit/3dc234ee47450ab6697e5640a7ec63c86afec5ba))
* **models:** extract hardware detection into hardware.rs (A2) ([ea3bdfe](https://github.com/tmac1973/haruspex/commit/ea3bdfef43670407b9078682ce854e49f452674c))
* **models:** table-driven hardware recommendation thresholds ([472cd11](https://github.com/tmac1973/haruspex/commit/472cd11202c2c00625c4ed549991aad0afaff4d6))
* **proxy:** split god module, invert db dependency, dedupe engine plumbing ([db7fe78](https://github.com/tmac1973/haruspex/commit/db7fe78c89ef0ffc790142f1d09aa8527895cb98))
* **proxy:** split god module, invert db dependency, dedupe engines ([205c327](https://github.com/tmac1973/haruspex/commit/205c327800d28024dedf22afcdb027108b5c5245))
* remediate code-complexity audit (god-functions, db split, doc-builder DRY) ([0e0b947](https://github.com/tmac1973/haruspex/commit/0e0b947652cd6d85af5c5386b296f54976babb8c))
* **rust:** sidecar spawn/reader + fs read-guard dedup (loose ends) ([2652edb](https://github.com/tmac1973/haruspex/commit/2652edb0657fc0556dfd76fca9a7eb03fcb582dd))
* **rust:** sidecar spawn/reader + fs read-guard dedup (loose ends) ([0685b33](https://github.com/tmac1973/haruspex/commit/0685b336407483bc843f73d2547a3994b642d60c))
* **sandbox:** decompose python worker init into boot phases ([5d995c4](https://github.com/tmac1973/haruspex/commit/5d995c46062be204dbf0550aaa42e4093b806de8))
* **settings:** shared .settings-section scaffolding (C2) ([2e1aed3](https://github.com/tmac1973/haruspex/commit/2e1aed3d75950c5a3d6ef97f62e1a5505cdfa3d4))
* **settings:** shared .settings-section scaffolding (C2) ([9c1539f](https://github.com/tmac1973/haruspex/commit/9c1539fbfb5a2abc0bd471b37f41d809c54f76da))
* **setup:** decompose runTestQuery streaming + polling tangle ([23a7817](https://github.com/tmac1973/haruspex/commit/23a781706d84875378a112f8e5f8ca2b7a5fc0c2))
* **shell:** dedupe command-line resolution (B/C markers) ([59b4972](https://github.com/tmac1973/haruspex/commit/59b497217abc84736b8fa0c8a74d136bccabe116))
* **sidecar:** centralize loopback host + health-poll timeouts (A4) ([c7ad858](https://github.com/tmac1973/haruspex/commit/c7ad858874255c70044c81de4b01d3a2c85b5253))
* **sidecars:** share library-path/URL/kill/health helpers (step 2) ([346c4d5](https://github.com/tmac1973/haruspex/commit/346c4d509d910d3049402d29941e025ad2748426))
* **sidecars:** share library-path/URL/kill/health helpers (step 2) ([ae3a9f4](https://github.com/tmac1973/haruspex/commit/ae3a9f480532a006b8ee0831652f562f17bd4838))
* **stores:** break chat&lt;-&gt;sandbox import cycle (A1) ([314f78c](https://github.com/tmac1973/haruspex/commit/314f78cd2026b1a3381651121ee2d5489561ce99))
* **ts:** finish errMessage + copy-action adoption (loose ends) ([df77d04](https://github.com/tmac1973/haruspex/commit/df77d048462eec37a112f2536f509f9c274f15c1))
* **ts:** finish errMessage + copy-action adoption (loose ends) ([68b9af1](https://github.com/tmac1973/haruspex/commit/68b9af19270a4d2776a627e3ac693c6f3a378c42))
* **ui:** safe CSS/util dedup — success var, thin-scroll, duration, keyed copy (step 5a) ([52ec801](https://github.com/tmac1973/haruspex/commit/52ec801754e9e3eaab76a7c11ddce2e7745490db))
* **ui:** safe CSS/util dedup (step 5a) ([d634949](https://github.com/tmac1973/haruspex/commit/d634949f01422bfdf40f944428d7a74a7d55796c))


### Documentation

* **audit:** add architecture review ([f19ac5a](https://github.com/tmac1973/haruspex/commit/f19ac5a517c8ee86c60d731a65109df95a46038a))
* **audit:** add code complexity audit report ([f071ca8](https://github.com/tmac1973/haruspex/commit/f071ca8521fe35be0e02d3ed58949db83d9ea71c))
* **audit:** add code-duplication audit report ([732362c](https://github.com/tmac1973/haruspex/commit/732362c9e93c5ca8c0dbc3a7f29536f961c3f818))
* **audit:** add codebase review 2026-06-11 (bugs, coverage, remediation status) ([0961db8](https://github.com/tmac1973/haruspex/commit/0961db8ff0149be0bd171765b35ad65f25d24af7))
* **audit:** code-duplication audit report ([3d4d90a](https://github.com/tmac1973/haruspex/commit/3d4d90a88995c96366062a823af4d5454e58ea9d))
* **audit:** drop phantom poison-recovery follow-up ([3ba5572](https://github.com/tmac1973/haruspex/commit/3ba5572b6f5e33cee58cbc2f928694a30439821b))
* **audit:** proposal for typed Rust&lt;-&gt;TS IPC bindings (X2/X3) ([518a20d](https://github.com/tmac1973/haruspex/commit/518a20d219ca24ecf8a39e5cb40316418096de64))
* **audit:** record remediation status + outstanding items ([51b433d](https://github.com/tmac1973/haruspex/commit/51b433d09803541faecd2b38668e3e0c0bb97dea))
* **audit:** record remediation status + outstanding items ([4cbde22](https://github.com/tmac1973/haruspex/commit/4cbde22cf7b833aca1f5aa51d6cdcbe060a0b346))
* **audit:** typed Rust↔TS IPC bindings proposal (X2/X3) ([21c0f48](https://github.com/tmac1973/haruspex/commit/21c0f48b2c75ac598f05055d71b955a840616376))

## [0.1.46](https://github.com/tmac1973/haruspex/compare/v0.1.45...v0.1.46) (2026-06-08)


### Features

* **shell:** default Run auto-submit to off ([1eb72c0](https://github.com/tmac1973/haruspex/commit/1eb72c0ab2b6dc190651d17304d1d711380fd039))
* **shell:** per-command Run buttons + optional Run auto-submit ([9ac1d07](https://github.com/tmac1973/haruspex/commit/9ac1d0734d5b25d9d077dc68769d8dd4a290568a))
* **shell:** per-command Run buttons + optional Run auto-submit ([b6f13ec](https://github.com/tmac1973/haruspex/commit/b6f13ec0619191c2b0a7db6572856dd8a5ba6923))
* **shell:** submit recent commands to assistant (button + F4); Run auto-submit off by default ([de21a5a](https://github.com/tmac1973/haruspex/commit/de21a5ad5c297c775ba10b3b827468b58a42c720))
* **shell:** submit recent commands to assistant via button + F4 ([2da9c8c](https://github.com/tmac1973/haruspex/commit/2da9c8c660389a726e11066452a684d277ab1cc0))


### Bug Fixes

* **shell:** always set TERM=xterm-256color for PTY sessions ([837d47d](https://github.com/tmac1973/haruspex/commit/837d47ddd4b9ba6bd4707f63da423059e08853bd))
* **shell:** always set TERM=xterm-256color for PTY sessions ([e6b23bc](https://github.com/tmac1973/haruspex/commit/e6b23bcd899fbd4803a24d89b68c8b2f337c1b6f))

## [0.1.45](https://github.com/tmac1973/haruspex/compare/v0.1.44...v0.1.45) (2026-06-07)


### Features

* **shell:** detach shell tabs into their own windows ([c8b4e7d](https://github.com/tmac1973/haruspex/commit/c8b4e7d9f7fabedecdde017d36ef53aeb6722b87))
* **shell:** multiple shell tabs + detachable windows on a shared inference queue ([b1c1c62](https://github.com/tmac1973/haruspex/commit/b1c1c626b78c470f58e80a0a04d5c99282d61934))
* **shell:** multiple shell tabs in one window ([577eb71](https://github.com/tmac1973/haruspex/commit/577eb717b0eb335f7fc43370bd19235fc45c7eac))


### Bug Fixes

* **audio:** F2/F3 media hotkeys no-op in packaged builds ([6ed5445](https://github.com/tmac1973/haruspex/commit/6ed544536f6fed7201bd4daec2e23ff58603ea5d))
* **audio:** F2/F3 media hotkeys no-op in packaged builds ([1254d80](https://github.com/tmac1973/haruspex/commit/1254d800c85c03a7ef69f20a61b250e3cdffa933))
* **shell:** bias assistant toward web search over training data ([61d8625](https://github.com/tmac1973/haruspex/commit/61d862545277fe144f6d35594017f01cec895d54))
* **shell:** clean scrollback handoff + hotkeys in detached windows ([cfa663f](https://github.com/tmac1973/haruspex/commit/cfa663fa923d44474b6b026bf5053e93822bb4ba))
* **shell:** keep PTY alive when opening settings ([5e0a566](https://github.com/tmac1973/haruspex/commit/5e0a5666af3427374d37ee3eaf875bd57819eb22))
* **shell:** persist PTY across settings + search-first assistant prompt ([b401045](https://github.com/tmac1973/haruspex/commit/b4010455515d938c32b03fd8a7cd56334d81f737))
* **shell:** proportion detached window to terminal + sidebar ([a55566c](https://github.com/tmac1973/haruspex/commit/a55566ce1573bc43a4760f6510e6a2f4677893ff))
* **shell:** Run auto-submit on long-lived/detached sessions ([409046d](https://github.com/tmac1973/haruspex/commit/409046d1a516ceb6a8f1b4023ef15741170affdb))


### Code Refactoring

* **inference:** move the inference queue into Rust ([99449a1](https://github.com/tmac1973/haruspex/commit/99449a18436e7b57ed0f33340ca36c1503fc9ad8))

## [0.1.44](https://github.com/tmac1973/haruspex/compare/v0.1.43...v0.1.44) (2026-06-07)


### Bug Fixes

* **shell:** strip AppImage libs from spawned shell's LD_LIBRARY_PATH ([3b6738d](https://github.com/tmac1973/haruspex/commit/3b6738d8b2c822214df91a9e29a3e2945861b05d))
* **shell:** strip AppImage libs from spawned shell's LD_LIBRARY_PATH ([15cb6c3](https://github.com/tmac1973/haruspex/commit/15cb6c3d04d8a82025703b194cb035fee7e53e06))

## [0.1.43](https://github.com/tmac1973/haruspex/compare/v0.1.42...v0.1.43) (2026-06-06)


### Bug Fixes

* **jobs:** run buttons hidden by shell-button CSS class collision ([5966cf4](https://github.com/tmac1973/haruspex/commit/5966cf40edca3ce027d106e4869bcdc6d0771a58))
* **jobs:** run buttons hidden by shell-button CSS class collision ([d0e7319](https://github.com/tmac1973/haruspex/commit/d0e73199b454f480ee3066b9dd762a8b86a056e9))

## [0.1.42](https://github.com/tmac1973/haruspex/compare/v0.1.41...v0.1.42) (2026-06-06)


### Bug Fixes

* **shell:** warn on risky commands for Paste, not just Run ([68d4a27](https://github.com/tmac1973/haruspex/commit/68d4a278b23b0d464a2527e5ab7a0b3eb175b21e))
* **shell:** warn on risky commands for Paste, not just Run ([fe35a40](https://github.com/tmac1973/haruspex/commit/fe35a40548549186a6e2c72c0df2198aafefea02))

## [0.1.41](https://github.com/tmac1973/haruspex/compare/v0.1.40...v0.1.41) (2026-06-06)


### Features

* **agent:** guarantee requests fit context with a self-calibrating pre-send guard ([f6f675e](https://github.com/tmac1973/haruspex/commit/f6f675e6ba80820b9c3e7d1155c5a27238c3d391))
* **sandbox:** ruff pre-run lint pass + compress failed run_python steps ([024eeee](https://github.com/tmac1973/haruspex/commit/024eeee064014f33c751e39d94773761734e2ce1))
* **sandbox:** ruff pre-run lint pass + compress failed run_python steps ([1d4acf7](https://github.com/tmac1973/haruspex/commit/1d4acf7a18c0750768bada18f36ed40a6c3c13f0))
* **shell, audio:** mic input in shell + F1/F2/F3 global media hotkeys ([b00557f](https://github.com/tmac1973/haruspex/commit/b00557ff99dd89eec298f96a424e035a9fd16d33))
* **shell:** add Shell tab with PTY-backed terminal (15a) ([258b549](https://github.com/tmac1973/haruspex/commit/258b5491babfbcbe7fce18fbc1686fc90228ca72))
* **shell:** chat composer in the sidebar for follow-up questions ([5b244af](https://github.com/tmac1973/haruspex/commit/5b244afce95badd7dc8c0512f7a129b6f7ec742b))
* **shell:** collapse the attached shell preamble in user messages ([57e497e](https://github.com/tmac1973/haruspex/commit/57e497e91132558fbf5b0197fcd89fe6e5eceb40))
* **shell:** confirm dialog when Run is clicked on a risky command ([ce81085](https://github.com/tmac1973/haruspex/commit/ce8108544c2a4ae547511806afab73e2c72308a5))
* **shell:** Ctrl+\` swaps focus between terminal and assistant composer ([3d03c49](https://github.com/tmac1973/haruspex/commit/3d03c4948b7b2737ce498d53ff8069f055a04822))
* **shell:** Ctrl+Shift+C / Ctrl+Shift+V + right-click copy/paste ([a534eaf](https://github.com/tmac1973/haruspex/commit/a534eafff2475389c20917935366480077459a5b))
* **shell:** head+tail truncate captured outputs before sending to model ([85a5c5b](https://github.com/tmac1973/haruspex/commit/85a5c5bebea4fe07070e0d61ba461b59b080cedc))
* **shell:** macOS port + in-flight capture + overflow hint ([feeafda](https://github.com/tmac1973/haruspex/commit/feeafda5370605bbb5ad5306d676fbfc001a6b4c))
* **shell:** macOS port + in-flight capture + overflow hint ([33d6479](https://github.com/tmac1973/haruspex/commit/33d647903580e4a9392f5ae7a3dbc6f346553a97))
* **shell:** opt-in fs_write + tighten shell-mode tool allowlist ([7d77013](https://github.com/tmac1973/haruspex/commit/7d770139a579c1958ad039de855613f76aa6e301))
* **shell:** OSC 133 integration + context capture + debug overlay (15b) ([76dd5af](https://github.com/tmac1973/haruspex/commit/76dd5af51be79e9086f8bb4607dcb7497fc3913c))
* **shell:** paste button + risky-command badges (15e) ([977ba83](https://github.com/tmac1973/haruspex/commit/977ba837ebb537f9277b4ddbdb182eb0e489da3f))
* **shell:** placeholder card on non-Linux until cross-platform lands ([1a3479a](https://github.com/tmac1973/haruspex/commit/1a3479ae1d2b7c23694636e2ca79e03bf0792e1f))
* **shell:** Run button on suggested commands + resizable sidebar ([85602d9](https://github.com/tmac1973/haruspex/commit/85602d917c9b477a1dc2161395ed6c77969995a0))
* **shell:** settings section + README + maintenance.md docs (15f) ([d54e06a](https://github.com/tmac1973/haruspex/commit/d54e06a5e32a11e21687fc1845a9b7f48f36f6e8))
* **shell:** shell agent driver + chat sidebar (15d) ([90ae325](https://github.com/tmac1973/haruspex/commit/90ae325b1ccfb0eef6991ea9fa1758efeaa3db17))
* **shell:** Shell tab — interactive terminal + AI troubleshooting sidebar ([cfa3129](https://github.com/tmac1973/haruspex/commit/cfa31292e338d8ec9895a85178b9ef4e1145e163))
* **shell:** shell-mode fs_read tools with absolute paths (15c) ([00d6780](https://github.com/tmac1973/haruspex/commit/00d678032201a2dcb3bb11d68fd41442b832a398))
* **shell:** surface tool calls in the sidebar like the chat tab does ([b095300](https://github.com/tmac1973/haruspex/commit/b0953003e752821341900f39fad6f1642f123e2d))
* **ui:** add AI safety notice to the startup dialog ([22aa6ab](https://github.com/tmac1973/haruspex/commit/22aa6ab357fd4276d760280b98feec2b2075ea44))
* **ui:** keyboard-shortcuts help modal (F1) + document hotkeys ([5317a4e](https://github.com/tmac1973/haruspex/commit/5317a4eba448dae4e7d1f7d550f8b9b158af927e))
* **ui:** keyboard-shortcuts help modal (F1) + document hotkeys ([c2f96f4](https://github.com/tmac1973/haruspex/commit/c2f96f418b83dc2142f153805dfd927c952a21e9))


### Bug Fixes

* **agent:** salvage tool calls Qwen3 wraps in &lt;tool_call&gt;&lt;function=...&gt; form ([f26146b](https://github.com/tmac1973/haruspex/commit/f26146bc8d9b1cfa5ee6d276bc83c71474ae6807))
* **audio:** defensive guards against USB hot-swap state corruption ([929b807](https://github.com/tmac1973/haruspex/commit/929b8070857fcb24f807cc9bdb322fedf5492956))
* **audio:** restore default_input_device for the System Default case ([8289fff](https://github.com/tmac1973/haruspex/commit/8289fffd666bbf7558a69388a5ebb63a23d4895b))
* **shell:** badge now distinguishes "no integration" from "no captures yet" ([00c664e](https://github.com/tmac1973/haruspex/commit/00c664e665779837f507e504469792751150d6e9))
* **shell:** bash hook was eating the C marker for every command after the first ([6b1500a](https://github.com/tmac1973/haruspex/commit/6b1500a04513ac43b518c49d284848f5633b1762))
* **shell:** buffer PTY output until the frontend attaches to avoid a startup-query race ([f6607d3](https://github.com/tmac1973/haruspex/commit/f6607d3ad431d11226496ff65c95ffa34c651342))
* **shell:** capture the real command line and post-command cwd ([43c353f](https://github.com/tmac1973/haruspex/commit/43c353f780d9dc2cfd9089fadb48aa0fe0ced356))
* **shell:** clippy while_let_loop on completed_command_count ([55e1383](https://github.com/tmac1973/haruspex/commit/55e1383912478b5fc6763b9a6cd89c3bc616d53d))
* **shell:** coach the agent away from read-retry loops + double-writes ([596fffc](https://github.com/tmac1973/haruspex/commit/596fffcd5b916f7be1e7299de545318c62bab53b))
* **shell:** harden bash hook and scope context menu to the terminal pane ([5eba813](https://github.com/tmac1973/haruspex/commit/5eba81356e5888509becd258f93646b9fb769edb))
* **shell:** open the sidebar the moment F2 starts recording ([518dce1](https://github.com/tmac1973/haruspex/commit/518dce10afaf603cfb19573d504e6782f06ba3b3))
* **shell:** persist PTY across tab switches ([483da0e](https://github.com/tmac1973/haruspex/commit/483da0e933379095a655153c98058ddd37a290aa))
* **shell:** release F1/F2/F3 from xterm so app hotkeys actually fire ([b92228c](https://github.com/tmac1973/haruspex/commit/b92228cfd76a99027e8ef3f4cea7879a276884c1))
* **shell:** Restart shell button + integration status badge ([8edc254](https://github.com/tmac1973/haruspex/commit/8edc25403dc45b8d8530a5e6e6328483464e4bd4))
* **shell:** show thinking indicator while a turn is processing ([7ef2653](https://github.com/tmac1973/haruspex/commit/7ef26532d051aa6e5ecf73481b9013d8ca3a9c25))
* **shell:** strip comments and inject suggested commands via bracketed paste ([0453317](https://github.com/tmac1973/haruspex/commit/0453317a609edd388ef6ac165cd8ab73c7e3d0a1))
* **shell:** suppress preexec for DEBUG firings about to call our hooks ([df2d17e](https://github.com/tmac1973/haruspex/commit/df2d17ec50102810ce6bf5e609e49cd2fcf6822a))
* **shell:** update context indicator on shell turns ([9a81cd3](https://github.com/tmac1973/haruspex/commit/9a81cd3bd8a5ef9c030ef7fd3c31aa3e80d325a0))
* **ui:** place the help (?) icon next to the settings gear ([0d94e26](https://github.com/tmac1973/haruspex/commit/0d94e26185916fa8f0e82617991f64a965049d0a))


### Code Refactoring

* **shell:** auto-attach recent shell activity instead of explicit submit ([012aba9](https://github.com/tmac1973/haruspex/commit/012aba9c099bf7f3f1915ebeb616c6794af9e7a0))
* **ui:** rename GpuWarningDialog to StartupNoticeDialog ([6e2f75d](https://github.com/tmac1973/haruspex/commit/6e2f75da3d9bff793620437271dd50feb77bc53e))


### Documentation

* add AI safety / hallucination disclaimer to README ([be6d315](https://github.com/tmac1973/haruspex/commit/be6d3154e375404fbbc16bc7dfdabd151484df65))
* **plan:** add phase 15 shell tab plan ([c5282a9](https://github.com/tmac1973/haruspex/commit/c5282a9edea84694689e0463fa8d40e3a5fd8478))
* **readme:** add Jobs tab feature + note sandbox/shell-write default off ([8d39a7e](https://github.com/tmac1973/haruspex/commit/8d39a7e532c3a7574e9b7dcababb71067895fb81))
* **readme:** add Jobs tab feature + note sandbox/shell-write default off ([c8758c0](https://github.com/tmac1973/haruspex/commit/c8758c0ae8a27c0785ed9cd4db0e5ed7fb3646e4))
* **shell:** reconcile macOS/Windows port plans with this session's changes ([7ef7ad1](https://github.com/tmac1973/haruspex/commit/7ef7ad1a4008fe9e61720909b28204f3a92be139))

## [0.1.40](https://github.com/tmac1973/haruspex/compare/v0.1.39...v0.1.40) (2026-05-26)


### Features

* **chat:** click-to-enlarge for inline image thumbnails ([7ca4aea](https://github.com/tmac1973/haruspex/commit/7ca4aea11dfb980d81a355eb5d63cd8f43831f3f))
* **chat:** persist messageSteps to DB so inline images survive restart ([d7a3fb7](https://github.com/tmac1973/haruspex/commit/d7a3fb724fbd509cffdfa3ddf4d1a9ee1f4236bb))
* **jobs:** delete runs from history sidebar ([44c6d38](https://github.com/tmac1973/haruspex/commit/44c6d38537cefb69c2b51cccf457d42282028fb7))
* **jobs:** delete runs from history sidebar — single and bulk ([40d7479](https://github.com/tmac1973/haruspex/commit/40d7479f1c669a0439f10d69cc98d2dea20a8e78))
* **sandbox:** auto-install imports + de-stale tool descriptions ([65069b1](https://github.com/tmac1973/haruspex/commit/65069b1ccaee59d13e02a23e32ac5806fcf16b94))
* **sandbox:** bundle pygame-ce/bokeh/altair workspace wheels (step 2) ([56f9344](https://github.com/tmac1973/haruspex/commit/56f9344893ac2df45a08fdb9b33764d84ff22de3))
* **sandbox:** iframe runtime MVP — protocol, manager, init.py (step 3) ([825895d](https://github.com/tmac1973/haruspex/commit/825895d9581ad36c31fa2fcf7875a0c6b311ee5b))
* **sandbox:** per-chat iframe pool with LRU (step 5) ([a117ccf](https://github.com/tmac1973/haruspex/commit/a117ccf3676e74855067c609058a7e2355819c13))
* **sandbox:** port FS bridge into iframe — save/delete/fetch/sync (step 4) ([9ef58f7](https://github.com/tmac1973/haruspex/commit/9ef58f72fab00e15d184be03a76dfc3e8bd48bd3))
* **sandbox:** render interactive HTML artifacts inline as srcdoc iframes (step E) ([05a9321](https://github.com/tmac1973/haruspex/commit/05a9321d4bf99ddf19616f620bea0fdf97178595))
* **sandbox:** retry-on-ImportError for transitive deps ([e860ddd](https://github.com/tmac1973/haruspex/commit/e860ddd51577053fe762c7cb97c5b52e8dca805c))
* **sandbox:** Run-again + Cancel buttons on run_python steps (step F) ([401a364](https://github.com/tmac1973/haruspex/commit/401a364aa648f8c224f64c5c020af51224533098))
* **sandbox:** spike pygame-ce in Tauri iframe (step 1) ([fc5cc6c](https://github.com/tmac1973/haruspex/commit/fc5cc6c57e7d52d08fdf77ed9e78e9e85238099b))
* **sandbox:** swap run_python / install_package / reset to IframePool (step 6) ([ab5e084](https://github.com/tmac1973/haruspex/commit/ab5e084be6690297a6bd6c1c4408bbd2444fc6da))
* **workspace:** Workspace tab + active-chat wiring (step 7) ([41e78aa](https://github.com/tmac1973/haruspex/commit/41e78aa86efcb5c583be14179b56dac754a696b3))


### Bug Fixes

* **sandbox:** bump default sandbox timeout 30s → 60s ([364ad89](https://github.com/tmac1973/haruspex/commit/364ad899e842556fdcb2f8f6fd64a90098fec8da))
* **sandbox:** package auto-install + phantom-load detector ([18275d8](https://github.com/tmac1973/haruspex/commit/18275d808a02d5b98523f78b1ed57e003876e2ae))
* **sandbox:** route script-bearing _repr_html_ to workspace, not chat ([33cf158](https://github.com/tmac1973/haruspex/commit/33cf158edf9805e622f83c299cf7478be3d7467c))
* **workspace:** always render the stage div so pool.host can attach ([e1f5a5b](https://github.com/tmac1973/haruspex/commit/e1f5a5b31961cbd5d12b9440916c1ac2db1fe676))
* **workspace:** AST-rewrite sync game loops so they don't freeze the UI ([c255d18](https://github.com/tmac1973/haruspex/commit/c255d18935abc89d6239c29e95d3ba1c201cbfc2))
* **workspace:** await external scripts in show_html so plotly works ([4900fcd](https://github.com/tmac1973/haruspex/commit/4900fcd02b743496a7831d9612d5072f1c1fbcd8))
* **workspace:** inherit visibility on active iframe so it hides with tab ([83e9556](https://github.com/tmac1973/haruspex/commit/83e9556c152f2f67491d8b12deea35757d78aba5))
* **workspace:** keep WorkspaceTab mounted so pool iframes stay alive ([a87d045](https://github.com/tmac1973/haruspex/commit/a87d045bbe501c1e138296393d98293845629e93))
* **workspace:** no-op pygame Clock.tick so game loops don't freeze UI ([17839f6](https://github.com/tmac1973/haruspex/commit/17839f6294af64935888eaf251f66e02b044455b))


### Code Refactoring

* **sandbox:** pivot back to Web Worker, drop workspace tab/iframe (steps A–D) ([adeb10e](https://github.com/tmac1973/haruspex/commit/adeb10e0498bc6daa259298b7fcc462fbae55333))


### Documentation

* **plan:** pivot to inline-iframe rendering with Web Worker runtime ([8fb9a62](https://github.com/tmac1973/haruspex/commit/8fb9a62922fda4379e219e6952d4af087d86f31d))
* **plan:** rewrite phase 13 as unified python sandbox ([8c9d8ff](https://github.com/tmac1973/haruspex/commit/8c9d8ff6bb6a7851b0bcb240e83ab7ca426e5cf9))

## [0.1.39](https://github.com/tmac1973/haruspex/compare/v0.1.38...v0.1.39) (2026-05-24)


### Features

* **inference:** app-level queue so chat + jobs don't head-of-line block ([901bdf5](https://github.com/tmac1973/haruspex/commit/901bdf54934ea3425eaac51554b68260ce45f88c))
* **jobs:** add jobs CRUD + editor UI (phase 14 step 2) ([f764f1b](https://github.com/tmac1973/haruspex/commit/f764f1be9ff46b38f01d6d2eda40dd7de950655c))
* **jobs:** crash recovery for orphaned runs (phase 14 step 6) ([21f43a5](https://github.com/tmac1973/haruspex/commit/21f43a5e910c9840718ede0cf51877a2e1883e5b))
* **jobs:** manual single-step run via ephemeral agent loop (phase 14 step 3) ([221b168](https://github.com/tmac1973/haruspex/commit/221b168e96829a712c1b2c3666d15a4926935c8f))
* **jobs:** multi-step pipelines with prior-output prepend (phase 14 step 4) ([56953a3](https://github.com/tmac1973/haruspex/commit/56953a319f782159290d11c0226e8bff4806e343))
* **jobs:** persist runs + browsable history pane (phase 14 step 5) ([e16cf8f](https://github.com/tmac1973/haruspex/commit/e16cf8f429b3725c98d9ee3358766df7c8125e8c))
* **jobs:** Phase 14 — Jobs tab (saved prompts, multi-step pipelines, in-app scheduling) ([6b2dd4c](https://github.com/tmac1973/haruspex/commit/6b2dd4c88d89f1028771bdbe31ad085fbc6ea773))
* **jobs:** scheduler + FIFO queue (phase 14 step 7) ([42ba17f](https://github.com/tmac1973/haruspex/commit/42ba17f9e9559538541bcb77b0a643df7793ae1f))
* **search:** track per-engine statistics with session + lifetime scopes ([c94562d](https://github.com/tmac1973/haruspex/commit/c94562da9f005a0da5fbc97d26d33f5d3445fdc9))


### Bug Fixes

* **agent:** cancel takes effect mid-tool, not just between tool calls ([7de9c22](https://github.com/tmac1973/haruspex/commit/7de9c22cf28961b347e17cd51f858cdc5570e52a))
* **jobs:** clipped Run button + unreadable schedule dropdown ([1fc497a](https://github.com/tmac1973/haruspex/commit/1fc497a105471584c8d1ab253ba878fc9fed64ae))
* **jobs:** Run button enables on first save; working dir is optional ([8b8f140](https://github.com/tmac1973/haruspex/commit/8b8f14023c7102372615d64f9c7fef33cb4549db))
* **jobs:** Run button enables on first save; working dir is optional ([efadcf5](https://github.com/tmac1973/haruspex/commit/efadcf5fd9962f551da99bb9542704a299f7a335))
* **tools:** catch more fs_write_xlsx scaffold patterns ([3458543](https://github.com/tmac1973/haruspex/commit/345854322e00b9931c07c4a7c2838cc246079d72))
* **tools:** reject scaffold input across the other fs_write_* writers ([4984c43](https://github.com/tmac1973/haruspex/commit/4984c430df5863a3038e3eda49fdb4176908fab5))
* **tools:** reject stub spreadsheet input + sharpen fs_write_xlsx description ([1aa75f2](https://github.com/tmac1973/haruspex/commit/1aa75f2b836265aafc953c5b83ca02f75e766585))


### Code Refactoring

* **ui:** add top-level tab shell and extract ChatView ([33ca986](https://github.com/tmac1973/haruspex/commit/33ca98669c4e5d7cbb547b669dd403f1fcfc72b3))


### Documentation

* **jobs:** add phase-14 plan for jobs tab ([0c76f5d](https://github.com/tmac1973/haruspex/commit/0c76f5df2458a2481f2cc158dbf5362ca4cca53d))
* **jobs:** add tooltips across the job editor + scheduler warning ([34624a7](https://github.com/tmac1973/haruspex/commit/34624a7271c1b49f8861907d228c33a0a71facd2))
* **jobs:** polish — prompt-size warning, tab badge, copy, maintenance.md (phase 14 step 8) ([f77569f](https://github.com/tmac1973/haruspex/commit/f77569f72389fb0e94f1d3fdd0a452f5deb49c8e))

## [0.1.38](https://github.com/tmac1973/haruspex/compare/v0.1.37...v0.1.38) (2026-05-23)


### Features

* **feedback:** add in-app feedback button and diagnostics export ([49a2aa1](https://github.com/tmac1973/haruspex/commit/49a2aa1e0d3e206f1e7394534bb215050f3e403e))
* **feedback:** in-app feedback button + diagnostics export ([6c7ad8e](https://github.com/tmac1973/haruspex/commit/6c7ad8e37aa38456f87882544e745c164d478218))
* **settings:** add custom system prompt and make gear icon toggle ([89f76d8](https://github.com/tmac1973/haruspex/commit/89f76d8d3ff97da4798dcb9628102166d5937c3f))
* **settings:** add custom system prompt and make gear icon toggle ([9d7861e](https://github.com/tmac1973/haruspex/commit/9d7861e892f5db7ed4387d8302c8c0e155b8b2ad))
* **settings:** organize into left-rail categories and add per-tab log clear ([7f75d8c](https://github.com/tmac1973/haruspex/commit/7f75d8cc8e22e410851d068bf949d52ec42738a7))
* **settings:** organize into left-rail categories and add per-tab log clear ([7e0dff1](https://github.com/tmac1973/haruspex/commit/7e0dff1cd542fff2ed303d0964cbfc1134b35a0f))


### Bug Fixes

* **agent:** recover when model narrates instead of acting after nudges ([2cde23c](https://github.com/tmac1973/haruspex/commit/2cde23cf23e0a0c0a60c3fc9e2866a8634320bb1))
* **agent:** recover when model narrates instead of acting after nudges ([90fe2fb](https://github.com/tmac1973/haruspex/commit/90fe2fb2ca3e08e1828f6636eb22d7c056830efc))


### Documentation

* **workspace:** add phase-13 plan for interactive Python+HTML tab ([35dcea9](https://github.com/tmac1973/haruspex/commit/35dcea9704af5cb0b4fa3a55bdb5c3bf63db9418))

## [0.1.37](https://github.com/tmac1973/haruspex/compare/v0.1.36...v0.1.37) (2026-05-15)


### Bug Fixes

* **models:** persist active model selection across reloads ([42a2799](https://github.com/tmac1973/haruspex/commit/42a279907b9fad76e3ab5757a68b54a1004a4685))
* **models:** persist active model selection across reloads ([5274c31](https://github.com/tmac1973/haruspex/commit/5274c31c48b79f8343585567edd7a92fd5898d5e))

## [0.1.36](https://github.com/tmac1973/haruspex/compare/v0.1.35...v0.1.36) (2026-05-14)


### Bug Fixes

* **hooks:** make pre-commit work from GUI git clients ([732f90a](https://github.com/tmac1973/haruspex/commit/732f90a63feeb26db1161baa11ddedfdcb78d57a))


### Code Refactoring

* 12-phase codebase refactor ([ade0c52](https://github.com/tmac1973/haruspex/commit/ade0c525e63357ca008010f46496365ab3d1ae43))
* **chat:** decompose sendMessage into named helpers ([4debe65](https://github.com/tmac1973/haruspex/commit/4debe65b87e8d70ea12292bd5d3222bf5db6430d))
* extract shared Modal and ModalButton components ([cd20417](https://github.com/tmac1973/haruspex/commit/cd204171d54b16fa0e730415191d37c083d1212d))
* extract sidecar_utils for shared infra ([46d90dd](https://github.com/tmac1973/haruspex/commit/46d90dd38d3311b221ef299699c205c12a376bbc))
* **fs_tools:** complete module split — docx/odt/pptx/odp/pdf_write ([fb463cf](https://github.com/tmac1973/haruspex/commit/fb463cf3a4ae61e2bcbf385560506d68eeed8f79))
* **fs_tools:** decompose build_pptx and slim build_pdf ([75f58b0](https://github.com/tmac1973/haruspex/commit/75f58b024b2044700cf5c5b8039eaf8a9aac7b3c))
* **fs_tools:** extract path, images, markdown_inline modules ([7a83453](https://github.com/tmac1973/haruspex/commit/7a83453f8cc357fea48a9126675ffb4c0e7a8bf7))
* **fs_tools:** extract text, pdf_read, download, xlsx modules ([faddd20](https://github.com/tmac1973/haruspex/commit/faddd201acac9710790bb0bf334d97285a6bbed7))
* **loop:** extract NudgeState class ([faf1217](https://github.com/tmac1973/haruspex/commit/faf1217c9490dd500d2d4ce5518a40586c1732d4))
* **loop:** extract runIteration + LoopContext + LoopState ([26bebdb](https://github.com/tmac1973/haruspex/commit/26bebdbabb5a92a903cdb543da1d717a585bcd87))
* polish pass — eslint guardrails, error surfacing, helpers ([17c7661](https://github.com/tmac1973/haruspex/commit/17c7661526b3aab0e857563ea8d3ac0eed45fdc7))
* **proxy:** split proxy.rs into module tree ([a865bed](https://github.com/tmac1973/haruspex/commit/a865bedae2f4460155baf0cd5df554878ac1234b))
* **routes:** extract ConversationSidebar component ([6c0b4c1](https://github.com/tmac1973/haruspex/commit/6c0b4c11c20e02af338144606e4af5e55d4092e2))
* **server:** extract log_classifier module ([daa2dbd](https://github.com/tmac1973/haruspex/commit/daa2dbd15eaddde588f59d610e45036205c8c10f))
* **settings:** extract EmailSection and ModelsSection ([8435d07](https://github.com/tmac1973/haruspex/commit/8435d07432f0c626c84888c804227b52156d2846))
* **tools:** extract _helpers + adopt writeExecutor / SHEETS_SCHEMA ([d2de0f9](https://github.com/tmac1973/haruspex/commit/d2de0f97282cafc399756d5a65f81012ab993429))


### Documentation

* add 2026-05-14 audits and 12-phase refactor plan ([f0b3bb1](https://github.com/tmac1973/haruspex/commit/f0b3bb1c4349fdb22a87acafc24728bc3500709d))
* add maintenance.md post-refactor guide ([15c30da](https://github.com/tmac1973/haruspex/commit/15c30dad05ff7467ec82b87d35a2dcb67a82e876))
* broaden web research feature description in README ([739225f](https://github.com/tmac1973/haruspex/commit/739225f2d7c9e7d3b3be77fbbe5c074fa2bef5ac))
* trim and restructure README ([339754b](https://github.com/tmac1973/haruspex/commit/339754b591e3298084e75cf57d94b2cfa7e6c990))

## [0.1.35](https://github.com/tmac1973/haruspex/compare/v0.1.34...v0.1.35) (2026-05-14)


### Features

* add HTTP/HTTPS proxy configuration ([4131287](https://github.com/tmac1973/haruspex/commit/413128754d9089cb9b3e424d37c769b93e502465))
* **agent:** image embedding, python lint, sampling tweaks ([d328f43](https://github.com/tmac1973/haruspex/commit/d328f43e7594f7720078b0fb7499b3bd5807bb9c))
* **agent:** image embedding, python lint, sampling tweaks ([395515a](https://github.com/tmac1973/haruspex/commit/395515a3c130e8e4f72ba4b455797d8c4884a133))
* **agent:** nudge after 3 consecutive run_python failures ([0acda1a](https://github.com/tmac1973/haruspex/commit/0acda1aa6841635bc4f5771a8c4390ce9ba4bba0))
* **chat:** clickable inline citations with paywall and quality guards ([209867b](https://github.com/tmac1973/haruspex/commit/209867b1c6791460e2bdb1164e980cf88d763a11))
* global working dir + per-message tok/s indicator ([65a18e6](https://github.com/tmac1973/haruspex/commit/65a18e69a725f2a8acd06a7a36c3724420feb7a5))
* HTTP proxy config, copy buttons, plus citation and UI fixes ([ca44f6c](https://github.com/tmac1973/haruspex/commit/ca44f6c8db8ca386de7f230291bae304cbba8990))
* optionally retain previous turn's tool results in context ([ee37c05](https://github.com/tmac1973/haruspex/commit/ee37c0572d2f622985e4e164f39b6583024655aa))
* optionally retain previous turn's tool results in context ([e4cfd09](https://github.com/tmac1973/haruspex/commit/e4cfd09160754e4de2701342d34cc11d8d84f5c9))
* replace default Tauri icon with Piacenza Bronze Liver ([c74ca77](https://github.com/tmac1973/haruspex/commit/c74ca7768db455c9b5c69e2b45b6880702fe3a86))
* **sandbox:** bidirectional working-dir ↔ MEMFS sync before each run ([3d0e9b4](https://github.com/tmac1973/haruspex/commit/3d0e9b4201949a8fc7c6e5a90c0367863cdf535e))
* **sandbox:** expose run_python / reset_python / install_package ([bdf624a](https://github.com/tmac1973/haruspex/commit/bdf624a8d1278d7b34cdaa7caffa79f581721d40))
* **sandbox:** gate legacy fs_write_pdf/pptx on sandbox setting; default off ([c084ea2](https://github.com/tmac1973/haruspex/commit/c084ea250d042945a3e08c7f32824708c78083d7))
* **sandbox:** haruspex.save Python bridge for binary writes ([2febdd9](https://github.com/tmac1973/haruspex/commit/2febdd93b39400d9a8bcb8235604fdb57a79e831))
* **sandbox:** mirror memfs ↔ host writes, deletes, and workdir changes ([959df16](https://github.com/tmac1973/haruspex/commit/959df169955d04f044ef4e54802da0fb664a1aab))
* **sandbox:** patch builtins.open so native Python writes reach disk ([130a68c](https://github.com/tmac1973/haruspex/commit/130a68ca70c7292cfc3fe8347c39c0f2b45119b0))
* **sandbox:** pdf/pptx via fpdf2 + python-pptx in pyodide sandbox ([02dbbba](https://github.com/tmac1973/haruspex/commit/02dbbba164b6ed454ac7a1874a4c28ba5036643b))
* **sandbox:** pdf/pptx via python-pptx + fpdf2, behind sandbox toggle ([e3da620](https://github.com/tmac1973/haruspex/commit/e3da620d3d49dc63066cce81ca61b6aeb7c2a507))
* **sandbox:** per-chat approval modal before run_python ([55635cc](https://github.com/tmac1973/haruspex/commit/55635ccee5800812db5a8fcf1acc908496705c3d))
* **sandbox:** restore Python session on chat switch via tool-call replay ([579815d](https://github.com/tmac1973/haruspex/commit/579815d4567d24986aceb0d7bf7e75fb877e6e68))
* **sandbox:** rich artifacts — matplotlib plots + DataFrame tables ([fdada71](https://github.com/tmac1973/haruspex/commit/fdada71507edbe9b4b89d4c499b383406b61237b))
* **sandbox:** route pyodide.http.pyfetch through Rust + app proxy ([c7f06c7](https://github.com/tmac1973/haruspex/commit/c7f06c731a89b7d28a90c2de1d5ef4c2732ca568))
* **sandbox:** settings panel — enable toggle, approval mode, timeout ([5d73b9f](https://github.com/tmac1973/haruspex/commit/5d73b9f719ed418f76a9f6e8f08c21ce1180539e))
* **sandbox:** syntax-highlight run_python code in tool-step view + global hljs theme ([75c5420](https://github.com/tmac1973/haruspex/commit/75c5420b70fea67016d734a0b42f9dec6228ad24))
* **sandbox:** system-prompt file-I/O guidance, gated on sandbox + workdir ([b6a6a43](https://github.com/tmac1973/haruspex/commit/b6a6a43eb8685fb4b6c7ae9b0eac050efe914d21))
* **sandbox:** worker scaffolding + cooperative interrupt ([99a5fea](https://github.com/tmac1973/haruspex/commit/99a5fea4d32447bb73b18cd63f2f6f39eafaf7c0))
* **server:** surface CPU fallback in UI with restart and dismiss ([eec6a5c](https://github.com/tmac1973/haruspex/commit/eec6a5c3abe7362422bc2559a9b90d0d2171ae25))
* show app version in header and window title ([e53b0a6](https://github.com/tmac1973/haruspex/commit/e53b0a64ddd4fafb174d68dd28be0cdaa7b033df))
* **ui:** add copy-to-clipboard buttons on messages and search details ([70d89cc](https://github.com/tmac1973/haruspex/commit/70d89cc6c00325889a9dc5ab08b746f4a0c48454))
* **ui:** add pretty/raw toggle to debug and tools log viewers ([e5af341](https://github.com/tmac1973/haruspex/commit/e5af3412e0a624eeca5388a714d1428d07baae46))
* **ui:** per-step log accordion + collapsible failed code blocks ([16611ba](https://github.com/tmac1973/haruspex/commit/16611bac80812c3b441ee1517fda32f1c8c94bd7))
* **ui:** pretty/raw toggle for debug and tools log viewers ([abdb62d](https://github.com/tmac1973/haruspex/commit/abdb62d44d5f574b21598ea23231281c9111bcd3))
* **ui:** show "new version available" link and indent code/log boxes ([98cb72e](https://github.com/tmac1973/haruspex/commit/98cb72ee3c84b50e8a74d1eb1785e2f3f5e89f50))
* **ui:** show per-message tokens-per-second indicator ([f0dc987](https://github.com/tmac1973/haruspex/commit/f0dc9875f4c6850a3738f15afb8dc83c2f8a00c5))
* **ui:** show remote model in header badge + reasoning toggle ([4e3c9b6](https://github.com/tmac1973/haruspex/commit/4e3c9b62a0be720facfb4c81eea5d19119b7c70e))
* **ui:** show remote model name in header badge and add reasoning toggle ([d86b54f](https://github.com/tmac1973/haruspex/commit/d86b54fb5f2dea5a4c19ed10cef40a6762be2ea2))
* **workdir:** make working directory a global persisted state ([4b0e7a6](https://github.com/tmac1973/haruspex/commit/4b0e7a6d5487ddaa19cd20ee5e795dc61a44b941))


### Bug Fixes

* **agent:** commit non-stream answer when no tools were used ([417d5a4](https://github.com/tmac1973/haruspex/commit/417d5a486e075d52aeebe1ef6a06891cc5972505))
* AppImage link clicks and koko TTS read-only filesystem panic ([b2bd2e8](https://github.com/tmac1973/haruspex/commit/b2bd2e813d1390e84816f63f190cbf507df68a59))
* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **build:** bundle homebrew dylibs into macOS sidecars ([0ab090f](https://github.com/tmac1973/haruspex/commit/0ab090f95837c7a536c5fbcf7b4e85185739a2e4))
* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **build:** emit web workers as ES modules ([ba6b099](https://github.com/tmac1973/haruspex/commit/ba6b099b2d318926ac925ef6879b63e44a46bb99))
* **build:** emit web workers as ES modules ([576a9b6](https://github.com/tmac1973/haruspex/commit/576a9b6bbe4c8dd11a6ecd8cb3d813aea1748248))
* **build:** re-sign sidecars and dylibs after install_name_tool ([26a1572](https://github.com/tmac1973/haruspex/commit/26a157221f530b756942aef3a8bf12f1ac48db84))
* **build:** re-sign sidecars and dylibs after install_name_tool ([8ae6fea](https://github.com/tmac1973/haruspex/commit/8ae6feacc9ae7329906e188ca85a4aca70b438d3))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))
* **inference:** show only enabled toolchest models in the picker ([54a4a58](https://github.com/tmac1973/haruspex/commit/54a4a588b642d34b3012315370e53f34a0f39e06))
* **inference:** show only enabled toolchest models in the picker ([3b1581b](https://github.com/tmac1973/haruspex/commit/3b1581bce64ecdf583002a0b130cba9bc7a4565d))
* **markdown:** drop unresolvable image refs from rendered chat content ([bf74d6c](https://github.com/tmac1973/haruspex/commit/bf74d6cfd3bd8502a6de0b82f95cb8fd29629aea))
* move searchSteps and sourceUrls to per-conversation state ([035ed06](https://github.com/tmac1973/haruspex/commit/035ed06c44c7174aa23b06ab41494cb7aefc7ed1))
* refresh context indicator on inference backend switch ([af5f9f3](https://github.com/tmac1973/haruspex/commit/af5f9f339650e060b9fd84c6a2c38eccfea23609))
* remote status race, link handling, and agent-loop diagnostics ([08840b6](https://github.com/tmac1973/haruspex/commit/08840b66aa7011cb746975ee2ef4770c2250d337))
* remote status race, link handling, and agent-loop diagnostics ([bbdf5b9](https://github.com/tmac1973/haruspex/commit/bbdf5b9b04dbfca78733d58fac9a4db822b7d591))
* restore citation example and anchor text instruction in system prompt ([ef08d33](https://github.com/tmac1973/haruspex/commit/ef08d336e6371699dc68e3b77e3603f48ef5c748))
* restore mandatory citation instructions in system prompt ([246108e](https://github.com/tmac1973/haruspex/commit/246108ea634855c80bfc556537aa3c63563038b9))
* **sandbox:** clear live searchSteps on commit to avoid doubled artifacts ([2e50ab2](https://github.com/tmac1973/haruspex/commit/2e50ab2a19b0218179b7b4bcb269cf511e7ac873))
* **sandbox:** collapse pyfetch-pattern error to single line — \n breaks Python parser ([235bc24](https://github.com/tmac1973/haruspex/commit/235bc24d476e8dda3c7d36fd3ef3ac5e68bf43ae))
* **sandbox:** copy artifact bytes into JS-owned buffer before postMessage ([cadc6d2](https://github.com/tmac1973/haruspex/commit/cadc6d2f507e8da9d6723cba83a89f8d74642bb0))
* **sandbox:** include full pyfetch await pattern in the urllib-blocked error ([1159c7d](https://github.com/tmac1973/haruspex/commit/1159c7d70159445e549d29b66218e7e645b5849a))
* **sandbox:** load packages from Pyodide CDN, preload micropip ([e258184](https://github.com/tmac1973/haruspex/commit/e25818411e87a4c6ec21e87d81e21d8e4e7174d6))
* **sandbox:** load pyodide via npm package instead of /public import ([f2ee2e8](https://github.com/tmac1973/haruspex/commit/f2ee2e8b21159f63fc08de966e94a31660492ddd))
* **sandbox:** patch urllib/requests/httpx via pyodide-http so native HTTP works ([192e86e](https://github.com/tmac1973/haruspex/commit/192e86e3b9a324771c5ff7016ad958cdea8c5517))
* **sandbox:** persist completed search steps under their assistant message ([5599e34](https://github.com/tmac1973/haruspex/commit/5599e34b118e5c2374868f3c0e18f12fc7ba681a))
* **sandbox:** point read-side FileNotFoundError at fs_read_* tools ([688f5e3](https://github.com/tmac1973/haruspex/commit/688f5e380dde78a0659c933c180a8a483d617808))
* **sandbox:** point urllib at pyfetch with a specific error when proxy on ([e32a726](https://github.com/tmac1973/haruspex/commit/e32a726e8d81ee3e724400bfe939cbb3739da270))
* **sandbox:** re-append newline to batched Pyodide stdout/stderr ([42e5221](https://github.com/tmac1973/haruspex/commit/42e5221bc9107da70d73f361142214c80e459e09))
* **sandbox:** skip pyodide-http patch when an app proxy is configured ([1f21d7b](https://github.com/tmac1973/haruspex/commit/1f21d7b57f21a72bd6c78ac549fc8c20b3e44223))
* **ui:** make email provider dropdown readable ([550cb60](https://github.com/tmac1973/haruspex/commit/550cb6035d62d72eaaed10147cde81e78f14c52c))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.34](https://github.com/tmac1973/haruspex/compare/v0.1.33...v0.1.34) (2026-05-14)


### Features

* **agent:** image embedding, python lint, sampling tweaks ([d328f43](https://github.com/tmac1973/haruspex/commit/d328f43e7594f7720078b0fb7499b3bd5807bb9c))
* **agent:** image embedding, python lint, sampling tweaks ([395515a](https://github.com/tmac1973/haruspex/commit/395515a3c130e8e4f72ba4b455797d8c4884a133))
* **ui:** add pretty/raw toggle to debug and tools log viewers ([e5af341](https://github.com/tmac1973/haruspex/commit/e5af3412e0a624eeca5388a714d1428d07baae46))
* **ui:** pretty/raw toggle for debug and tools log viewers ([abdb62d](https://github.com/tmac1973/haruspex/commit/abdb62d44d5f574b21598ea23231281c9111bcd3))

## [0.1.33](https://github.com/tmac1973/haruspex/compare/v0.1.32...v0.1.33) (2026-05-13)


### Features

* **ui:** show remote model in header badge + reasoning toggle ([4e3c9b6](https://github.com/tmac1973/haruspex/commit/4e3c9b62a0be720facfb4c81eea5d19119b7c70e))
* **ui:** show remote model name in header badge and add reasoning toggle ([d86b54f](https://github.com/tmac1973/haruspex/commit/d86b54fb5f2dea5a4c19ed10cef40a6762be2ea2))

## [0.1.32](https://github.com/tmac1973/haruspex/compare/v0.1.31...v0.1.32) (2026-05-12)


### Bug Fixes

* **build:** emit web workers as ES modules ([ba6b099](https://github.com/tmac1973/haruspex/commit/ba6b099b2d318926ac925ef6879b63e44a46bb99))
* **build:** emit web workers as ES modules ([576a9b6](https://github.com/tmac1973/haruspex/commit/576a9b6bbe4c8dd11a6ecd8cb3d813aea1748248))

## [0.1.31](https://github.com/tmac1973/haruspex/compare/v0.1.30...v0.1.31) (2026-05-12)


### Features

* **agent:** nudge after 3 consecutive run_python failures ([0acda1a](https://github.com/tmac1973/haruspex/commit/0acda1aa6841635bc4f5771a8c4390ce9ba4bba0))
* global working dir + per-message tok/s indicator ([65a18e6](https://github.com/tmac1973/haruspex/commit/65a18e69a725f2a8acd06a7a36c3724420feb7a5))
* replace default Tauri icon with Piacenza Bronze Liver ([c74ca77](https://github.com/tmac1973/haruspex/commit/c74ca7768db455c9b5c69e2b45b6880702fe3a86))
* **sandbox:** bidirectional working-dir ↔ MEMFS sync before each run ([3d0e9b4](https://github.com/tmac1973/haruspex/commit/3d0e9b4201949a8fc7c6e5a90c0367863cdf535e))
* **sandbox:** expose run_python / reset_python / install_package ([bdf624a](https://github.com/tmac1973/haruspex/commit/bdf624a8d1278d7b34cdaa7caffa79f581721d40))
* **sandbox:** gate legacy fs_write_pdf/pptx on sandbox setting; default off ([c084ea2](https://github.com/tmac1973/haruspex/commit/c084ea250d042945a3e08c7f32824708c78083d7))
* **sandbox:** haruspex.save Python bridge for binary writes ([2febdd9](https://github.com/tmac1973/haruspex/commit/2febdd93b39400d9a8bcb8235604fdb57a79e831))
* **sandbox:** mirror memfs ↔ host writes, deletes, and workdir changes ([959df16](https://github.com/tmac1973/haruspex/commit/959df169955d04f044ef4e54802da0fb664a1aab))
* **sandbox:** patch builtins.open so native Python writes reach disk ([130a68c](https://github.com/tmac1973/haruspex/commit/130a68ca70c7292cfc3fe8347c39c0f2b45119b0))
* **sandbox:** pdf/pptx via fpdf2 + python-pptx in pyodide sandbox ([02dbbba](https://github.com/tmac1973/haruspex/commit/02dbbba164b6ed454ac7a1874a4c28ba5036643b))
* **sandbox:** pdf/pptx via python-pptx + fpdf2, behind sandbox toggle ([e3da620](https://github.com/tmac1973/haruspex/commit/e3da620d3d49dc63066cce81ca61b6aeb7c2a507))
* **sandbox:** per-chat approval modal before run_python ([55635cc](https://github.com/tmac1973/haruspex/commit/55635ccee5800812db5a8fcf1acc908496705c3d))
* **sandbox:** restore Python session on chat switch via tool-call replay ([579815d](https://github.com/tmac1973/haruspex/commit/579815d4567d24986aceb0d7bf7e75fb877e6e68))
* **sandbox:** rich artifacts — matplotlib plots + DataFrame tables ([fdada71](https://github.com/tmac1973/haruspex/commit/fdada71507edbe9b4b89d4c499b383406b61237b))
* **sandbox:** route pyodide.http.pyfetch through Rust + app proxy ([c7f06c7](https://github.com/tmac1973/haruspex/commit/c7f06c731a89b7d28a90c2de1d5ef4c2732ca568))
* **sandbox:** settings panel — enable toggle, approval mode, timeout ([5d73b9f](https://github.com/tmac1973/haruspex/commit/5d73b9f719ed418f76a9f6e8f08c21ce1180539e))
* **sandbox:** syntax-highlight run_python code in tool-step view + global hljs theme ([75c5420](https://github.com/tmac1973/haruspex/commit/75c5420b70fea67016d734a0b42f9dec6228ad24))
* **sandbox:** system-prompt file-I/O guidance, gated on sandbox + workdir ([b6a6a43](https://github.com/tmac1973/haruspex/commit/b6a6a43eb8685fb4b6c7ae9b0eac050efe914d21))
* **sandbox:** worker scaffolding + cooperative interrupt ([99a5fea](https://github.com/tmac1973/haruspex/commit/99a5fea4d32447bb73b18cd63f2f6f39eafaf7c0))
* **ui:** per-step log accordion + collapsible failed code blocks ([16611ba](https://github.com/tmac1973/haruspex/commit/16611bac80812c3b441ee1517fda32f1c8c94bd7))
* **ui:** show "new version available" link and indent code/log boxes ([98cb72e](https://github.com/tmac1973/haruspex/commit/98cb72ee3c84b50e8a74d1eb1785e2f3f5e89f50))
* **ui:** show per-message tokens-per-second indicator ([f0dc987](https://github.com/tmac1973/haruspex/commit/f0dc9875f4c6850a3738f15afb8dc83c2f8a00c5))
* **workdir:** make working directory a global persisted state ([4b0e7a6](https://github.com/tmac1973/haruspex/commit/4b0e7a6d5487ddaa19cd20ee5e795dc61a44b941))


### Bug Fixes

* **markdown:** drop unresolvable image refs from rendered chat content ([bf74d6c](https://github.com/tmac1973/haruspex/commit/bf74d6cfd3bd8502a6de0b82f95cb8fd29629aea))
* **sandbox:** clear live searchSteps on commit to avoid doubled artifacts ([2e50ab2](https://github.com/tmac1973/haruspex/commit/2e50ab2a19b0218179b7b4bcb269cf511e7ac873))
* **sandbox:** collapse pyfetch-pattern error to single line — \n breaks Python parser ([235bc24](https://github.com/tmac1973/haruspex/commit/235bc24d476e8dda3c7d36fd3ef3ac5e68bf43ae))
* **sandbox:** copy artifact bytes into JS-owned buffer before postMessage ([cadc6d2](https://github.com/tmac1973/haruspex/commit/cadc6d2f507e8da9d6723cba83a89f8d74642bb0))
* **sandbox:** include full pyfetch await pattern in the urllib-blocked error ([1159c7d](https://github.com/tmac1973/haruspex/commit/1159c7d70159445e549d29b66218e7e645b5849a))
* **sandbox:** load packages from Pyodide CDN, preload micropip ([e258184](https://github.com/tmac1973/haruspex/commit/e25818411e87a4c6ec21e87d81e21d8e4e7174d6))
* **sandbox:** load pyodide via npm package instead of /public import ([f2ee2e8](https://github.com/tmac1973/haruspex/commit/f2ee2e8b21159f63fc08de966e94a31660492ddd))
* **sandbox:** patch urllib/requests/httpx via pyodide-http so native HTTP works ([192e86e](https://github.com/tmac1973/haruspex/commit/192e86e3b9a324771c5ff7016ad958cdea8c5517))
* **sandbox:** persist completed search steps under their assistant message ([5599e34](https://github.com/tmac1973/haruspex/commit/5599e34b118e5c2374868f3c0e18f12fc7ba681a))
* **sandbox:** point read-side FileNotFoundError at fs_read_* tools ([688f5e3](https://github.com/tmac1973/haruspex/commit/688f5e380dde78a0659c933c180a8a483d617808))
* **sandbox:** point urllib at pyfetch with a specific error when proxy on ([e32a726](https://github.com/tmac1973/haruspex/commit/e32a726e8d81ee3e724400bfe939cbb3739da270))
* **sandbox:** re-append newline to batched Pyodide stdout/stderr ([42e5221](https://github.com/tmac1973/haruspex/commit/42e5221bc9107da70d73f361142214c80e459e09))
* **sandbox:** skip pyodide-http patch when an app proxy is configured ([1f21d7b](https://github.com/tmac1973/haruspex/commit/1f21d7b57f21a72bd6c78ac549fc8c20b3e44223))

## [0.1.30](https://github.com/tmac1973/haruspex/compare/v0.1.29...v0.1.30) (2026-05-09)


### Features

* add HTTP/HTTPS proxy configuration ([4131287](https://github.com/tmac1973/haruspex/commit/413128754d9089cb9b3e424d37c769b93e502465))
* **chat:** clickable inline citations with paywall and quality guards ([209867b](https://github.com/tmac1973/haruspex/commit/209867b1c6791460e2bdb1164e980cf88d763a11))
* HTTP proxy config, copy buttons, plus citation and UI fixes ([ca44f6c](https://github.com/tmac1973/haruspex/commit/ca44f6c8db8ca386de7f230291bae304cbba8990))
* optionally retain previous turn's tool results in context ([ee37c05](https://github.com/tmac1973/haruspex/commit/ee37c0572d2f622985e4e164f39b6583024655aa))
* optionally retain previous turn's tool results in context ([e4cfd09](https://github.com/tmac1973/haruspex/commit/e4cfd09160754e4de2701342d34cc11d8d84f5c9))
* **server:** surface CPU fallback in UI with restart and dismiss ([eec6a5c](https://github.com/tmac1973/haruspex/commit/eec6a5c3abe7362422bc2559a9b90d0d2171ae25))
* show app version in header and window title ([e53b0a6](https://github.com/tmac1973/haruspex/commit/e53b0a64ddd4fafb174d68dd28be0cdaa7b033df))
* **ui:** add copy-to-clipboard buttons on messages and search details ([70d89cc](https://github.com/tmac1973/haruspex/commit/70d89cc6c00325889a9dc5ab08b746f4a0c48454))


### Bug Fixes

* **agent:** commit non-stream answer when no tools were used ([417d5a4](https://github.com/tmac1973/haruspex/commit/417d5a486e075d52aeebe1ef6a06891cc5972505))
* AppImage link clicks and koko TTS read-only filesystem panic ([b2bd2e8](https://github.com/tmac1973/haruspex/commit/b2bd2e813d1390e84816f63f190cbf507df68a59))
* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **build:** bundle homebrew dylibs into macOS sidecars ([0ab090f](https://github.com/tmac1973/haruspex/commit/0ab090f95837c7a536c5fbcf7b4e85185739a2e4))
* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **build:** re-sign sidecars and dylibs after install_name_tool ([26a1572](https://github.com/tmac1973/haruspex/commit/26a157221f530b756942aef3a8bf12f1ac48db84))
* **build:** re-sign sidecars and dylibs after install_name_tool ([8ae6fea](https://github.com/tmac1973/haruspex/commit/8ae6feacc9ae7329906e188ca85a4aca70b438d3))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))
* **inference:** show only enabled toolchest models in the picker ([54a4a58](https://github.com/tmac1973/haruspex/commit/54a4a588b642d34b3012315370e53f34a0f39e06))
* **inference:** show only enabled toolchest models in the picker ([3b1581b](https://github.com/tmac1973/haruspex/commit/3b1581bce64ecdf583002a0b130cba9bc7a4565d))
* move searchSteps and sourceUrls to per-conversation state ([035ed06](https://github.com/tmac1973/haruspex/commit/035ed06c44c7174aa23b06ab41494cb7aefc7ed1))
* refresh context indicator on inference backend switch ([af5f9f3](https://github.com/tmac1973/haruspex/commit/af5f9f339650e060b9fd84c6a2c38eccfea23609))
* remote status race, link handling, and agent-loop diagnostics ([08840b6](https://github.com/tmac1973/haruspex/commit/08840b66aa7011cb746975ee2ef4770c2250d337))
* remote status race, link handling, and agent-loop diagnostics ([bbdf5b9](https://github.com/tmac1973/haruspex/commit/bbdf5b9b04dbfca78733d58fac9a4db822b7d591))
* restore citation example and anchor text instruction in system prompt ([ef08d33](https://github.com/tmac1973/haruspex/commit/ef08d336e6371699dc68e3b77e3603f48ef5c748))
* restore mandatory citation instructions in system prompt ([246108e](https://github.com/tmac1973/haruspex/commit/246108ea634855c80bfc556537aa3c63563038b9))
* **ui:** make email provider dropdown readable ([550cb60](https://github.com/tmac1973/haruspex/commit/550cb6035d62d72eaaed10147cde81e78f14c52c))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.29](https://github.com/tmac1973/haruspex/compare/v0.1.28...v0.1.29) (2026-05-09)


### Bug Fixes

* **inference:** show only enabled toolchest models in the picker ([54a4a58](https://github.com/tmac1973/haruspex/commit/54a4a588b642d34b3012315370e53f34a0f39e06))
* **inference:** show only enabled toolchest models in the picker ([3b1581b](https://github.com/tmac1973/haruspex/commit/3b1581bce64ecdf583002a0b130cba9bc7a4565d))

## [0.1.28](https://github.com/tmac1973/haruspex/compare/v0.1.27...v0.1.28) (2026-05-04)


### Features

* optionally retain previous turn's tool results in context ([ee37c05](https://github.com/tmac1973/haruspex/commit/ee37c0572d2f622985e4e164f39b6583024655aa))
* optionally retain previous turn's tool results in context ([e4cfd09](https://github.com/tmac1973/haruspex/commit/e4cfd09160754e4de2701342d34cc11d8d84f5c9))


### Bug Fixes

* refresh context indicator on inference backend switch ([af5f9f3](https://github.com/tmac1973/haruspex/commit/af5f9f339650e060b9fd84c6a2c38eccfea23609))

## [0.1.27](https://github.com/tmac1973/haruspex/compare/v0.1.26...v0.1.27) (2026-05-01)


### Bug Fixes

* AppImage link clicks and koko TTS read-only filesystem panic ([b2bd2e8](https://github.com/tmac1973/haruspex/commit/b2bd2e813d1390e84816f63f190cbf507df68a59))

## [0.1.26](https://github.com/tmac1973/haruspex/compare/v0.1.25...v0.1.26) (2026-04-29)


### Features

* add HTTP/HTTPS proxy configuration ([4131287](https://github.com/tmac1973/haruspex/commit/413128754d9089cb9b3e424d37c769b93e502465))
* **chat:** clickable inline citations with paywall and quality guards ([209867b](https://github.com/tmac1973/haruspex/commit/209867b1c6791460e2bdb1164e980cf88d763a11))
* HTTP proxy config, copy buttons, plus citation and UI fixes ([ca44f6c](https://github.com/tmac1973/haruspex/commit/ca44f6c8db8ca386de7f230291bae304cbba8990))
* **server:** surface CPU fallback in UI with restart and dismiss ([eec6a5c](https://github.com/tmac1973/haruspex/commit/eec6a5c3abe7362422bc2559a9b90d0d2171ae25))
* show app version in header and window title ([e53b0a6](https://github.com/tmac1973/haruspex/commit/e53b0a64ddd4fafb174d68dd28be0cdaa7b033df))
* **ui:** add copy-to-clipboard buttons on messages and search details ([70d89cc](https://github.com/tmac1973/haruspex/commit/70d89cc6c00325889a9dc5ab08b746f4a0c48454))


### Bug Fixes

* **agent:** commit non-stream answer when no tools were used ([417d5a4](https://github.com/tmac1973/haruspex/commit/417d5a486e075d52aeebe1ef6a06891cc5972505))
* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **build:** bundle homebrew dylibs into macOS sidecars ([0ab090f](https://github.com/tmac1973/haruspex/commit/0ab090f95837c7a536c5fbcf7b4e85185739a2e4))
* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **build:** re-sign sidecars and dylibs after install_name_tool ([26a1572](https://github.com/tmac1973/haruspex/commit/26a157221f530b756942aef3a8bf12f1ac48db84))
* **build:** re-sign sidecars and dylibs after install_name_tool ([8ae6fea](https://github.com/tmac1973/haruspex/commit/8ae6feacc9ae7329906e188ca85a4aca70b438d3))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))
* move searchSteps and sourceUrls to per-conversation state ([035ed06](https://github.com/tmac1973/haruspex/commit/035ed06c44c7174aa23b06ab41494cb7aefc7ed1))
* remote status race, link handling, and agent-loop diagnostics ([08840b6](https://github.com/tmac1973/haruspex/commit/08840b66aa7011cb746975ee2ef4770c2250d337))
* remote status race, link handling, and agent-loop diagnostics ([bbdf5b9](https://github.com/tmac1973/haruspex/commit/bbdf5b9b04dbfca78733d58fac9a4db822b7d591))
* restore citation example and anchor text instruction in system prompt ([ef08d33](https://github.com/tmac1973/haruspex/commit/ef08d336e6371699dc68e3b77e3603f48ef5c748))
* restore mandatory citation instructions in system prompt ([246108e](https://github.com/tmac1973/haruspex/commit/246108ea634855c80bfc556537aa3c63563038b9))
* **ui:** make email provider dropdown readable ([550cb60](https://github.com/tmac1973/haruspex/commit/550cb6035d62d72eaaed10147cde81e78f14c52c))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.25](https://github.com/tmac1973/haruspex/compare/v0.1.24...v0.1.25) (2026-04-28)


### Features

* show app version in header and window title ([e53b0a6](https://github.com/tmac1973/haruspex/commit/e53b0a64ddd4fafb174d68dd28be0cdaa7b033df))

## [0.1.24](https://github.com/tmac1973/haruspex/compare/v0.1.23...v0.1.24) (2026-04-26)


### Bug Fixes

* remote status race, link handling, and agent-loop diagnostics ([08840b6](https://github.com/tmac1973/haruspex/commit/08840b66aa7011cb746975ee2ef4770c2250d337))
* remote status race, link handling, and agent-loop diagnostics ([bbdf5b9](https://github.com/tmac1973/haruspex/commit/bbdf5b9b04dbfca78733d58fac9a4db822b7d591))

## [0.1.23](https://github.com/tmac1973/haruspex/compare/v0.1.22...v0.1.23) (2026-04-23)


### Bug Fixes

* **build:** re-sign sidecars and dylibs after install_name_tool ([26a1572](https://github.com/tmac1973/haruspex/commit/26a157221f530b756942aef3a8bf12f1ac48db84))
* **build:** re-sign sidecars and dylibs after install_name_tool ([8ae6fea](https://github.com/tmac1973/haruspex/commit/8ae6feacc9ae7329906e188ca85a4aca70b438d3))

## [0.1.22](https://github.com/tmac1973/haruspex/compare/v0.1.21...v0.1.22) (2026-04-23)


### Bug Fixes

* **build:** bundle homebrew dylibs into macOS sidecars ([0ab090f](https://github.com/tmac1973/haruspex/commit/0ab090f95837c7a536c5fbcf7b4e85185739a2e4))

## [0.1.21](https://github.com/tmac1973/haruspex/compare/v0.1.20...v0.1.21) (2026-04-20)


### Features

* add HTTP/HTTPS proxy configuration ([4131287](https://github.com/tmac1973/haruspex/commit/413128754d9089cb9b3e424d37c769b93e502465))
* **chat:** clickable inline citations with paywall and quality guards ([209867b](https://github.com/tmac1973/haruspex/commit/209867b1c6791460e2bdb1164e980cf88d763a11))
* HTTP proxy config, copy buttons, plus citation and UI fixes ([ca44f6c](https://github.com/tmac1973/haruspex/commit/ca44f6c8db8ca386de7f230291bae304cbba8990))
* **ui:** add copy-to-clipboard buttons on messages and search details ([70d89cc](https://github.com/tmac1973/haruspex/commit/70d89cc6c00325889a9dc5ab08b746f4a0c48454))


### Bug Fixes

* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))
* move searchSteps and sourceUrls to per-conversation state ([035ed06](https://github.com/tmac1973/haruspex/commit/035ed06c44c7174aa23b06ab41494cb7aefc7ed1))
* restore citation example and anchor text instruction in system prompt ([ef08d33](https://github.com/tmac1973/haruspex/commit/ef08d336e6371699dc68e3b77e3603f48ef5c748))
* restore mandatory citation instructions in system prompt ([246108e](https://github.com/tmac1973/haruspex/commit/246108ea634855c80bfc556537aa3c63563038b9))
* **ui:** make email provider dropdown readable ([550cb60](https://github.com/tmac1973/haruspex/commit/550cb6035d62d72eaaed10147cde81e78f14c52c))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.20](https://github.com/tmac1973/haruspex/compare/v0.1.19...v0.1.20) (2026-04-14)


### Bug Fixes

* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.19](https://github.com/tmac1973/haruspex/compare/v0.1.18...v0.1.19) (2026-04-14)


### Bug Fixes

* **audio:** use device's native config for mic capture on Windows ([fac07bb](https://github.com/tmac1973/haruspex/commit/fac07bbed47c31e3bd5ed77bdd69e021068cfa4f))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

## [0.1.18](https://github.com/tmac1973/haruspex/compare/v0.1.17...v0.1.18) (2026-04-13)


### Bug Fixes

* **build:** disable -march=native in sidecar builds ([fa45a9f](https://github.com/tmac1973/haruspex/commit/fa45a9f25604e20677efe3fb5e24f49874d713e5))
* **ci:** drop --offline and --workspace from Cargo.lock sync ([7d5df0b](https://github.com/tmac1973/haruspex/commit/7d5df0b7b7455d4bb951bbbaf4f2b160db0e2d42))
* **ci:** use plain vX.Y.Z tags in release-please ([8cf0249](https://github.com/tmac1973/haruspex/commit/8cf0249f24e5fa3d3c58a259bf3cdcb31620dc01))

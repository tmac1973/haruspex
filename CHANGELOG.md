# Changelog

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

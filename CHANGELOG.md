# Changelog

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

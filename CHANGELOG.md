# Changelog

## [0.1.29](https://github.com/tmac1973/haruspex/compare/v0.1.28...v0.1.29) (2026-05-04)


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
* move searchSteps and sourceUrls to per-conversation state ([035ed06](https://github.com/tmac1973/haruspex/commit/035ed06c44c7174aa23b06ab41494cb7aefc7ed1))
* refresh context indicator on inference backend switch ([af5f9f3](https://github.com/tmac1973/haruspex/commit/af5f9f339650e060b9fd84c6a2c38eccfea23609))
* remote status race, link handling, and agent-loop diagnostics ([08840b6](https://github.com/tmac1973/haruspex/commit/08840b66aa7011cb746975ee2ef4770c2250d337))
* remote status race, link handling, and agent-loop diagnostics ([bbdf5b9](https://github.com/tmac1973/haruspex/commit/bbdf5b9b04dbfca78733d58fac9a4db822b7d591))
* restore citation example and anchor text instruction in system prompt ([ef08d33](https://github.com/tmac1973/haruspex/commit/ef08d336e6371699dc68e3b77e3603f48ef5c748))
* restore mandatory citation instructions in system prompt ([246108e](https://github.com/tmac1973/haruspex/commit/246108ea634855c80bfc556537aa3c63563038b9))
* **ui:** make email provider dropdown readable ([550cb60](https://github.com/tmac1973/haruspex/commit/550cb6035d62d72eaaed10147cde81e78f14c52c))
* **ui:** prevent sidebar scrollbar from covering chat delete button ([89acea3](https://github.com/tmac1973/haruspex/commit/89acea3ab1a6087fbfcf8ae199e98bc3b5de07d5))

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

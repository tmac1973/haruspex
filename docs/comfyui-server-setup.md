# A ComfyUI server for Haruspex

How to run ComfyUI on another machine so Haruspex can generate images on it.
You install plain ComfyUI with its built-in Manager and start it listening on
the network. Haruspex does the rest from Settings → Image: it finds the
server, installs the model files through Manager, and picks the workflows.

Written for Linux with an AMD GPU (ROCm). Notes for NVIDIA and Windows are at
the end.

## What Haruspex needs from the server

- **ComfyUI, a current release.** The bundled workflows use only ComfyUI's own
  nodes: the Ming-Image graphs need no custom node packs, and neither does
  Qwen-Image-2.1 (`TextEncodeQwenImage21` is a core node).
- **ComfyUI-Manager, enabled.** It is how Haruspex puts model files on a
  server it cannot write to directly. Without it you copy the files by hand
  (see [Installing the models by hand](#installing-the-models-by-hand)).
- **Reachable from the Haruspex machine** on its port, 8188 by default.
- **Resources for Ming-Image** (the default model): about 8 GB of VRAM and
  24 GB of RAM, because the text encoder runs on the CPU. Disk: about 19 GB
  for Ming, and 17 GB more if you also want Qwen-Image-2.1.

## 1. Install ComfyUI

On the server:

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git ~/ComfyUI
cd ~/ComfyUI
python3 -m venv venv
source venv/bin/activate
```

Install PyTorch for your GPU **before** ComfyUI's requirements, so pip does not
pull the default CUDA build. For an AMD card, use the ROCm index that
[pytorch.org's install selector](https://pytorch.org/get-started/locally/)
lists for the current release. For example:

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.4
```

The ROCm wheels carry their own ROCm runtime. The machine needs only the
`amdgpu` kernel driver, which current kernels include, and your user in the
`render` and `video` groups (`sudo usermod -aG render,video $USER`, then log
in again).

Check that PyTorch sees the card:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

ROCm builds report through `torch.cuda`; this should print `True` and the card's
name (for example `AMD Radeon RX 7900 XTX`).

Then ComfyUI itself, and the built-in Manager's requirements:

```bash
pip install -r requirements.txt
pip install -r manager_requirements.txt
```

## 2. Start it on the network

```bash
cd ~/ComfyUI && source venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188 --enable-manager
```

- `--listen 0.0.0.0` accepts connections from other machines. ComfyUI
  listens only on localhost by default.
- `--enable-manager` turns on the built-in ComfyUI-Manager. An older install
  that has Manager as a custom node in `custom_nodes/ComfyUI-Manager` works
  too; Haruspex speaks both APIs.
- No CORS flag is needed: Haruspex calls ComfyUI from its Rust side, not the
  browser.

Open the port to your LAN if the server runs a firewall, for example:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8188 proto tcp
# or, with firewalld:
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="8188" protocol="tcp" accept' && sudo firewall-cmd --reload
```

## 3. Let Manager install models for a remote client

Manager refuses to install models when ComfyUI listens on anything but
loopback, unless its `network_mode` is `personal_cloud`. It refuses
**quietly**: the install queue empties and no file appears. So set it before
the first install.

Start ComfyUI once with `--enable-manager` so Manager writes its config, then
stop it and find the file:

```bash
find ~/ComfyUI/user -name config.ini -path '*anager*'
```

In that file's `[default]` section, set:

```ini
network_mode = personal_cloud
```

Leave `security_level` at `normal`. At `strong`, Manager refuses model
installs even from loopback.

Start ComfyUI again as in step 2.

> **Security.** ComfyUI has no login. Anyone who can reach port 8188 can run
> prompts, and with `personal_cloud` they can make the server download model
> files. Keep the port on your LAN; don't forward it to the internet.

## 4. Keep it running (optional)

A systemd user service, so ComfyUI starts at boot:

```ini
# ~/.config/systemd/user/comfyui.service
[Unit]
Description=ComfyUI
After=network-online.target

[Service]
WorkingDirectory=%h/ComfyUI
ExecStart=%h/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188 --enable-manager
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now comfyui
sudo loginctl enable-linger $USER   # start without anyone logged in
journalctl --user -u comfyui -f     # its log
```

## 5. Check it from the Haruspex machine

```bash
curl -s http://SERVER:8188/system_stats | head -c 300; echo
curl -s http://SERVER:8188/v2/manager/version; echo
```

The first prints ComfyUI's version and the GPU. The second prints Manager's
version; a 404 means Manager is not enabled (step 2). An older custom-node
Manager answers on `/manager/version` instead.

## 6. Connect Haruspex

In Settings → Image:

1. **Backend:** ComfyUI.
2. **Server address:** `http://SERVER:8188`. Leave **API key** empty; it is
   only for a reverse proxy that asks for one.
3. **Probe.** Haruspex lists what the server can do and, under it, each model
   family with the files the server is missing.
4. **Install** on Ming-Image 0.1 Design. On a remote server this goes through
   Manager, which downloads on the server itself. It shows which file it is on
   but not a percentage, and the text encoder alone is 12.8 GB. Haruspex waits
   up to six hours.
5. When it finishes, Haruspex probes again. Choose the Ming model in
   **Model** (`ming_image_0.1_design_int8_convrot.safetensors`). Its text
   encoder and VAE are found by name.
6. **Generate a test image.**

Qwen-Image-2.1 installs the same way. It is licensed for research and
evaluation only, and Haruspex asks you to confirm that before it installs.

The app's proxy setting does not apply to ComfyUI: a server on the LAN is
called directly.

## Installing the models by hand

If Manager is not available, or it installed nothing, Settings → Image shows
**Copy file list** instead: one line per file with its folder, size and URL.
Download each into that folder under `~/ComfyUI/models/`. For Ming-Image:

```bash
cd ~/ComfyUI/models
wget -P diffusion_models https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/diffusion_models/ming_image_0.1_design_int8_convrot.safetensors
wget -P text_encoders    https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/text_encoders/ming_image_0.1_ling_mini_2.0_w4a8.safetensors
wget -P vae              https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/vae/ming_image_vae_bf16.safetensors
```

Then Probe again in Haruspex. ComfyUI picks up new files without a restart.

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| Probe can't reach the server | ComfyUI isn't listening on the network (`--listen 0.0.0.0`), or a firewall blocks 8188. Try the `curl` in step 5 from the Haruspex machine. |
| Install finishes, but the files are still listed as missing | Manager refused: `network_mode` isn't `personal_cloud`, or `security_level` is `strong`. ComfyUI's console logs the refusal. |
| No Install button, only Copy file list | Manager isn't enabled, or isn't answering (step 5). |
| A generation fails with an out-of-memory error | Something else holds the GPU's memory, or the server has less than 24 GB of RAM for the text encoder. |
| Transparent sprites come out opaque | The server runs a modified Ming workflow. Haruspex's own (`src/lib/image/comfyui/templates/`) needs only core nodes; a custom workflow in Settings → Image replaces it. |

## Other platforms

- **NVIDIA:** install PyTorch from the CUDA index pytorch.org lists instead of
  ROCm; everything else is the same.
- **Windows:** the ComfyUI portable build or ComfyUI Desktop both work. Start
  it with the same flags (`--listen 0.0.0.0 --port 8188 --enable-manager`),
  allow port 8188 through Windows Defender Firewall for private networks, and
  set `network_mode` in Manager's `config.ini` under ComfyUI's `user`
  folder.

## What has been verified

- Haruspex's Manager route is live-tested against Manager 4.2.2 with the
  server on loopback, installing Ming's VAE and checking its SHA-256
  (`plan/local-image-generation/TODO.md`, phase 27).
- The remote case, with `network_mode = personal_cloud`, follows Manager's
  documented rules, but hasn't been tried end to end yet.
- Ming on ComfyUI has not been tried on an RX 7900 XTX specifically.

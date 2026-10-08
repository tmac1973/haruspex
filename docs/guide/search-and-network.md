---
title: Search and network
description: Choose a web search provider (Auto, Brave, SearXNG, browser), deep research slow mode, proxies, Python sandbox network access, and API keys.
---

# Search and network

The assistant searches the web to answer questions about current things. This page covers which search engine it uses, how to send traffic through a proxy, what the Python sandbox may connect to, and where API keys are kept.

## Choose a search provider

Pick one in Settings → Search → **Search provider**:

| Provider | Setup | Notes |
| --- | --- | --- |
| Auto (the default) | None | Takes turns between Yahoo, Brave, DuckDuckGo and Bing, and skips engines that are failing. |
| DuckDuckGo | None | One engine only, so it may get rate limited. |
| Brave Search | API key | Free key with 2,000 queries a month from brave.com/search/api. The most reliable option. |
| SearXNG | Instance URL | Unlimited, if you host it yourself. |
| Browser-assisted | Chrome or Chromium | Drives a hidden browser, so it can reach engines that block simple requests (it adds Startpage). |

Free public engines are unreliable: they rate-limit and change their pages. If searches keep failing, use a Brave key or SearXNG. To see how each engine is doing, open the log viewer's **Stats** tab: it shows totals for this session and all time, and a **By day** table of how many searches worked out of how many were tried, so an engine that broke today stands out.

**Brave Search:** paste the key into **Brave API Key**. It is saved when you leave the field. **Remove key** deletes it.

**Browser-assisted:** any Chromium-based browser works (Chrome, Chromium, Brave, Edge). Haruspex finds it for you; if it doesn't, set **Browser path**. Searches take about twice as long and the browser uses about 1.2 GB of RAM while it runs. It starts when you search and quits when idle. If no browser works, searches fall back to the normal rotation and say so.

**Result recency** limits results to the past day, week, month or year. The default is Any time.

## Deep research and slow mode

The deep research button in the chat box makes the assistant search more sources. If deep research is on, the provider is Auto and you have no Brave key, searches use slow mode: they wait longer between engines so the engines don't block you. A search step in the chat says when this is happening. A Brave key or SearXNG skips slow mode.

## Use a proxy

Settings → Network has two proxies.

- **Network Proxy** covers everything except web search: model downloads, MCP servers, calendar and contacts, ComfyUI installs and the Python sandbox. Choose **None** (the default) or **Manual** and enter a **Proxy URL**.
- **Web Search Proxy** covers web search, the pages it opens and image search. Choose **None**, **Network proxy** (the default: use the same proxy as above) or **Manual** with its own URL.

The URL looks like `http://host:port`. Add `user:pass@` if the proxy needs a login; the password is moved to the system keychain and hidden from the field.

**Proxy Bypass List** holds addresses reached directly: one per line, as a hostname, IP or CIDR subnet. A hostname also matches its subdomains. `localhost` is always bypassed.

Each MCP server can also choose its own proxy use (Use the app setting, Always, Never) on its card in Settings → Integrations. See the `integrations` page.

## Control what Python code can reach

When the Python sandbox is on, Settings → Agent → Python Sandbox → **Network access** decides what code the model writes may connect to:

- **Internet only**: public addresses.
- **Internet and local network** (the default): also devices on your network.
- **Everything, including this computer**: also services on your own machine, including Haruspex's own model, speech and remote access servers.

Sandbox traffic uses the Network Proxy.

## Where API keys are kept

API keys for remote model servers and OpenRouter are managed in Settings → Inference → **API Keys**. Give each key a name; the remote server and OpenRouter forms, and per-job model choices, refer to it by name, so changing a key here changes it everywhere.

Keys, email and calendar passwords, and proxy passwords go in your system keychain (GNOME Keyring or KWallet on Linux, Keychain on macOS, Credential Manager on Windows). Where no keychain works, Haruspex keeps them in an encrypted file in its data folder.
